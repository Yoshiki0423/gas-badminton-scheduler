/**
 * @fileoverview F-1-1 メンバー自動登録機能 — イベントハンドラー
 *
 * follow / unfollow イベントを受け取って、実際の業務処理(=スプレッドシート更新 +
 * 歓迎メッセージ送信)を行うファイルです。
 *
 * 各関数の役割を 1 行で:
 *   - handleFollow(event)          : 新メンバー登録 + 歓迎メッセージ
 *   - handleUnfollow(event)        : メンバーを inactive に変更(削除はしない)
 *   - handleDistributeSurvey()     : 全 active メンバーに Flex Message を Push 配信(F-1-3)
 */

/**
 * follow イベント処理 — F-1-1 の本体
 *
 * 処理の流れ(順番):
 *   1. event から userId / replyToken を取り出す(両方必須・なければ即終了)
 *   2. LINE プロフィール API で displayName を取得(リトライあり)
 *   3. メンバーシートに行を追記 or 既存行を再 active 化(リトライあり + Lock 付き)
 *   4. Reply API で歓迎メッセージを返信(リトライあり)
 *
 * 設計上の注意:
 *   - replyToken は **約 1 分で期限切れ** になるため、上記 1〜3 を素早く済ませる必要がある
 *     (=スプレッドシート更新で時間を食いすぎないよう、Lock の保持時間は最小化する)
 *   - プロフィール取得が失敗した場合でも、最低限「(名前不明)」として登録は進める
 *     (=メンバー登録の主目的は「userId をリストに入れる」ことなので、displayName は補助情報)
 *
 * @param {Object} event - LINE follow イベント
 *   - event.source.userId : LINE ユーザー ID(必須)
 *   - event.replyToken    : 返信用トークン(必須)
 *   - event.timestamp     : イベント発生時刻(ミリ秒・参考情報)
 * @returns {void}
 */
function handleFollow(event) {
  var userId = (event && event.source && event.source.userId) ? event.source.userId : '';
  var replyToken = (event && event.replyToken) ? event.replyToken : '';

  if (!userId) {
    logError(new Error('handleFollow: userId is missing'), { phase: 'handleFollow.validate', event: event });
    return;
  }

  // (1) プロフィール取得(失敗しても登録は続行)
  var displayName = '(名前不明)';
  try {
    var profile = withRetry(function () {
      return getLineProfile(userId);
    }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'getLineProfile' });

    if (profile && profile.displayName) {
      displayName = profile.displayName;
    }
  } catch (profileError) {
    // プロフィール取得失敗はログのみ残して登録は続行
    logError(profileError, { phase: 'handleFollow.getProfile', userId: userId });
  }

  // (2) メンバーシートに登録 or 復活(Lock + リトライ)
  try {
    upsertMemberAsActive(userId, displayName);
  } catch (sheetError) {
    logError(sheetError, { phase: 'handleFollow.upsert', userId: userId });
    // シート更新が失敗しても歓迎メッセージは送る(UX 優先・後で手動で復旧可能)
  }

  // (3) 歓迎メッセージを返信
  if (replyToken) {
    try {
      withRetry(function () {
        return replyText(replyToken, _buildWelcomeMessage(displayName));
      }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'replyWelcome' });
    } catch (replyError) {
      logError(replyError, { phase: 'handleFollow.reply', userId: userId });
    }
  }

  console.log('[INFO] follow handled: userId=' + _maskUserId(userId) + ' displayName=' + displayName);
}

/**
 * unfollow イベント処理 — D-008 基本処理のみ実装
 *
 * 処理の流れ:
 *   1. userId を取り出す
 *   2. メンバーシートで該当 userId を探し、status を "inactive" に、lastUpdatedAt を現在時刻に更新
 *   3. 該当が見つからない場合は警告ログのみ(エラーにはしない)
 *
 * 注意:
 *   - unfollow 時はユーザーがすでに Bot をブロックしているため、Reply / Push API は呼ばない
 *     (=送っても届かない仕様)
 *   - 行は削除しない(履歴保持・将来の TBD-10b で再 follow 復活させるため)
 *
 * @param {Object} event - LINE unfollow イベント
 *   - event.source.userId : LINE ユーザー ID(必須)
 * @returns {void}
 */
function handleUnfollow(event) {
  var userId = (event && event.source && event.source.userId) ? event.source.userId : '';

  if (!userId) {
    logError(new Error('handleUnfollow: userId is missing'), { phase: 'handleUnfollow.validate', event: event });
    return;
  }

  try {
    var result = markMemberInactive(userId);
    if (result.found) {
      console.log('[INFO] unfollow handled: userId=' + _maskUserId(userId) + ' (marked inactive)');
    } else {
      console.warn('[WARN] unfollow received for unknown userId=' + _maskUserId(userId) +
                   ' (likely tested in LINE Developers console before friend-add)');
    }
  } catch (sheetError) {
    logError(sheetError, { phase: 'handleUnfollow.markInactive', userId: userId });
  }
}

// ─────────────────────────────────────────────
// F-1-3: 質問配信機能
// ─────────────────────────────────────────────

/**
 * 1 バブルに収めるボタンの最大数
 *
 * LINE 公式デザインガイドでは 1 バブルあたり最大 3 ボタンを推奨。
 * 3 件を超える場合は Carousel(= 横スワイプで複数バブルを切り替える形式)に自動分割する。
 * 5-7 件の候補なら 2〜3 枚に分かれてスワイプで選べる形になる。
 */
var SURVEY_FLEX_MAX_PER_BUBBLE = 3;

/**
 * 質問配信 — F-1-3 の本体
 *
 * 処理の流れ:
 *   1. schedules シートから全スケジュール行を取得
 *   2. members シートから active なメンバーだけを取得(D-008 の方針)
 *   3. schedules を元に Flex Message を組み立てる
 *   4. 全 active メンバーに Push API で 1 対 1(1on1)送信する
 *
 * 設計上の注意:
 *   - Push API はリクエスト 1 件 = メンバー 1 人への送信。10 名いれば 10 回 API を呼ぶ。
 *     無料枠(月 200 通)を意識した運用が前提(REQUIREMENTS.md §4-4)。
 *   - 1 人への送信が失敗しても他のメンバーへの送信は続行する設計(全体停止しない)。
 *   - withRetry(最大 3 回・指数バックオフ)を全送信に適用する。
 *
 * @returns {{sent: number, skipped: number}} 送信成功数・スキップ(失敗)数
 */
function handleDistributeSurvey() {
  // 新アンケート配信のタイミングで自動集計フラグをリセットする。
  // これにより、今回の配信に対して全員が回答した時点で _checkAllRespondedAndNotify が再び動く。
  PropertiesService.getScriptProperties().deleteProperty('RESULTS_NOTIFIED');

  // (1) スケジュール取得
  var schedules = getSchedules();
  if (schedules.length === 0) {
    console.log('[INFO] distributeSurvey: schedules シートが空です。配信をスキップします。');
    return { sent: 0, skipped: 0 };
  }

  // (2) アクティブメンバー取得
  var members = getActiveMembers();
  if (members.length === 0) {
    console.log('[INFO] distributeSurvey: active メンバーがいません。配信をスキップします。');
    return { sent: 0, skipped: 0 };
  }

  // (3) Flex Message 組み立て
  var flexContents = _buildSurveyFlex(schedules);
  var altText = '【日程調整】参加できる日時を選んでください(' + schedules.length + '件)';

  // (4) 全メンバーに Push 送信(失敗しても次のメンバーへ続行)
  var sent = 0;
  var skipped = 0;

  for (var i = 0; i < members.length; i++) {
    var member = members[i];
    try {
      withRetry(function () {
        return pushFlexMessage(member.userId, altText, flexContents);
      }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'pushSurvey' });
      sent++;
      console.log('[INFO] 質問送信完了: ' + _maskUserId(member.userId) + ' (' + member.displayName + ')');
    } catch (pushError) {
      logError(pushError, { phase: 'distributeSurvey.push', index: i, userId: _maskUserId(member.userId), displayName: member.displayName });
      skipped++;
    }
  }

  console.log('[INFO] distributeSurvey 完了: sent=' + sent + ' skipped=' + skipped);
  return { sent: sent, skipped: skipped };
}

/**
 * Flex Message の中身(contents)を組み立てる(内部用)
 *
 * 候補が SURVEY_FLEX_MAX_PER_BUBBLE(3) 件以下なら 1 つの Bubble を返す。
 * 超える場合は Carousel(= 複数 Bubble を横スワイプで切り替える形式)に分割する。
 *
 * @param {Array<Object>} schedules - getSchedules() が返すオブジェクト配列
 * @returns {Object} LINE Flex Message の contents オブジェクト(bubble or carousel)
 * @private
 */
function _buildSurveyFlex(schedules) {
  if (schedules.length <= SURVEY_FLEX_MAX_PER_BUBBLE) {
    return _buildSurveyBubble(schedules);
  }

  // 3 件超: 3 件ずつ Bubble に分割して Carousel に束ねる
  var bubbles = [];
  for (var i = 0; i < schedules.length; i += SURVEY_FLEX_MAX_PER_BUBBLE) {
    var chunk = schedules.slice(i, Math.min(i + SURVEY_FLEX_MAX_PER_BUBBLE, schedules.length));
    bubbles.push(_buildSurveyBubble(chunk));
  }

  return { type: 'carousel', contents: bubbles };
}

/**
 * 1 つの Bubble を組み立てる(内部用)
 *
 * Bubble 構造:
 *   header: 緑背景 + 「バドミントン日程調整」タイトル
 *   body:   案内テキスト + 区切り線 + 各候補のボタン(postback アクション)
 *
 * ボタンのアクション形式(F-1-4 との連携を考慮):
 *   data: "action=vote&scheduleId=SCH_xxxxxxxxxxxxxxxx_xxxx"
 *   displayText: ラベルと同じ文字列(ユーザーのトークルームに表示されるテキスト)
 *
 * @param {Array<Object>} schedules
 * @returns {Object} Flex Message の bubble オブジェクト
 * @private
 */
function _buildSurveyBubble(schedules) {
  var bodyContents = [
    {
      type: 'text',
      text: '参加できる日時をすべて選んでください。',
      wrap: true,
      size: 'sm',
      color: '#555555'
    },
    { type: 'separator' }
  ];

  for (var i = 0; i < schedules.length; i++) {
    var s = schedules[i];
    var label = _formatScheduleLabel(s);
    // LINE ボタンのラベルは最大 40 文字(日本語を含む場合も文字数で制限)
    if (label.length > 40) {
      label = label.substring(0, 39) + '…';
    }
    bodyContents.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: {
        type: 'postback',
        label: label,
        // F-1-4(回答収集)が postback データから scheduleId を取り出せる形式
        data: 'action=vote&scheduleId=' + s.scheduleId,
        // ユーザーのトークルームに表示されるテキスト(ボタンをタップした証跡)
        displayText: label
      }
    });
  }

  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#1DB446',
      contents: [{
        type: 'text',
        text: 'バドミントン日程調整',
        weight: 'bold',
        size: 'xl',
        color: '#FFFFFF'
      }]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: bodyContents
    }
  };
}

/**
 * スケジュールオブジェクトからボタン用ラベル文字列を生成する(内部用)
 *
 * 生成例: "5/15(金) 18:00〜20:00 鳥屋野総合体育館"
 *
 * @param {{date: string, startTime: string, endTime: string, facilityName: string}} schedule
 * @returns {string}
 * @private
 */
function _formatScheduleLabel(schedule) {
  return _formatDateTimeLabel(schedule) + ' ' + schedule.facilityName;
}

/**
 * 歓迎メッセージの本文を組み立てる(内部用)
 *
 * D-001 で「事務的トーンでよい」「絵文字は使ってもよい(過度でなければ)」と決まっているため、
 * シンプルかつ親しみやすい文面にする。文面は将来 TBD-2 / TBD-3 で改修予定のため、
 * 1 か所(この関数)だけ書き換えれば変えられる構造にしている。
 *
 * @param {string} displayName
 * @returns {string} LINE で送信する平文メッセージ
 * @private
 */
function _buildWelcomeMessage(displayName) {
  var lines = [
    'こんにちは、' + displayName + 'さん!',
    '日程調整 Bot のメンバー登録が完了しました。',
    '',
    '今後、バドミントンの日程調整(質問配信・回答収集・結果通知)は',
    'すべて、この Bot との 1 対 1 トークでやり取りします。',
    '',
    '質問が届いたら、表示されたボタンをタップしてご回答ください。',
    'よろしくお願いします!'
  ];
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// F-1-4: 回答収集機能
// ─────────────────────────────────────────────

/**
 * postback イベント処理 — F-1-4 の本体
 *
 * 処理の流れ:
 *   1. userId / replyToken を取り出す
 *   2. event.postback.data を parse → action=vote&scheduleId=SCH_xxx を分解
 *   3. action が 'vote' 以外ならログのみ残してスルー
 *   4. responses シートに upsert(同一 userId + scheduleId は上書き)
 *   5. Reply API で「回答ありがとうございます」を返信
 *
 * 設計上の注意:
 *   - シート書き込みが失敗しても返信は行う(UX 優先・後で手動確認可能)
 *   - replyToken がない場合(= LINE Developers コンソールのテスト送信など)は返信をスキップ
 *
 * @param {Object} event - LINE postback イベント
 * @returns {void}
 */
function handleVote(event) {
  var userId = (event && event.source && event.source.userId) ? event.source.userId : '';
  var replyToken = (event && event.replyToken) ? event.replyToken : '';

  if (!userId) {
    logError(new Error('handleVote: userId is missing'), { phase: 'handleVote.validate' });
    return;
  }

  // (1) postback.data を parse する
  //     形式: "action=vote&scheduleId=SCH_20260510143022_4831"
  var data = (event && event.postback && event.postback.data) ? event.postback.data : '';
  var params = _parsePostbackData(data);

  if (params.action !== 'vote') {
    console.log('[INFO] handleVote: unknown action=' + (params.action || '(empty)') + ' data=' + data);
    return;
  }

  var scheduleId = params.scheduleId || '';
  if (!scheduleId) {
    logError(new Error('handleVote: scheduleId is missing in postback data'), {
      phase: 'handleVote.validate',
      data: data
    });
    return;
  }

  // (2) responses シートに記録
  try {
    var result = upsertResponse(userId, scheduleId);
    console.log('[INFO] vote recorded: userId=' + _maskUserId(userId) +
      ' scheduleId=' + scheduleId + ' action=' + result.action);
  } catch (sheetError) {
    logError(sheetError, { phase: 'handleVote.upsert', userId: _maskUserId(userId), scheduleId: scheduleId });
    // シート書き込み失敗でも返信は続行
  }

  // (3) 返信
  if (replyToken) {
    try {
      withRetry(function () {
        return replyText(replyToken, '回答ありがとうございます!\n参加希望を受け付けました。');
      }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'replyVote' });
    } catch (replyError) {
      logError(replyError, { phase: 'handleVote.reply', userId: _maskUserId(userId) });
    }
  }

  // (4) 全員回答チェック → 自動集計・通知(F-1-6 / F-1-7)
  try {
    _checkAllRespondedAndNotify();
  } catch (checkError) {
    logError(checkError, { phase: 'handleVote.checkAllResponded' });
  }
}

// ─────────────────────────────────────────────
// F-1-5: リマインド送信機能
// ─────────────────────────────────────────────

/**
 * リマインド送信 — F-1-5 の本体
 *
 * まだ 1 件も回答していない active メンバーだけを対象に、
 * 「リマインドテキスト + 質問 Flex Message の再送」を Push API で送信する。
 *
 * 処理の流れ:
 *   1. schedules / active メンバーを取得(どちらも空なら即終了)
 *   2. getRespondedUserIds() で回答済み userId を Set に変換
 *   3. active メンバーから未回答者だけを抽出
 *   4. 未回答者全員に「テキスト + Flex」を Push 送信
 *
 * @returns {{sent: number, skipped: number, unresponded: number}}
 */
function handleSendReminders() {
  var schedules = getSchedules();
  if (schedules.length === 0) {
    console.log('[INFO] sendReminders: schedules シートが空です。リマインドをスキップします。');
    return { sent: 0, skipped: 0, unresponded: 0 };
  }

  var members = getActiveMembers();
  if (members.length === 0) {
    console.log('[INFO] sendReminders: active メンバーがいません。リマインドをスキップします。');
    return { sent: 0, skipped: 0, unresponded: 0 };
  }

  // 回答済み userId を Object(ハッシュセット代わり)に変換
  var respondedIds = getRespondedUserIds();
  var respondedSet = {};
  for (var i = 0; i < respondedIds.length; i++) {
    respondedSet[respondedIds[i]] = true;
  }

  var unresponded = members.filter(function (m) { return !respondedSet[m.userId]; });

  if (unresponded.length === 0) {
    console.log('[INFO] sendReminders: 全員が回答済みです。リマインド不要。');
    return { sent: 0, skipped: 0, unresponded: 0 };
  }

  var flexContents = _buildSurveyFlex(schedules);
  var altText = '【リマインド】参加できる日時を選んでください(' + schedules.length + '件)';
  var reminderText = 'リマインドです。\nまだ回答が届いていません。\n下のメッセージのボタンをタップしてご回答ください。';

  var sent = 0;
  var skipped = 0;

  for (var j = 0; j < unresponded.length; j++) {
    var member = unresponded[j];
    try {
      withRetry(function () {
        return pushText(member.userId, reminderText);
      }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'reminderText' });
      withRetry(function () {
        return pushFlexMessage(member.userId, altText, flexContents);
      }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'reminderFlex' });
      sent++;
      console.log('[INFO] リマインド送信完了: ' + _maskUserId(member.userId) +
                  ' (' + member.displayName + ')');
    } catch (pushError) {
      logError(pushError, {
        phase: 'sendReminders.push',
        userId: _maskUserId(member.userId),
        displayName: member.displayName
      });
      skipped++;
    }
  }

  console.log('[INFO] sendReminders 完了: sent=' + sent + ' skipped=' + skipped +
              ' unresponded=' + unresponded.length);
  return { sent: sent, skipped: skipped, unresponded: unresponded.length };
}

// ─────────────────────────────────────────────
// F-1-6 / F-1-7: 集計・判定・結果通知機能
// ─────────────────────────────────────────────

/** 「成立」と見なす最小参加人数(REQUIREMENTS.md §2 より) */
var MIN_ATTENDEES = 4;

/**
 * 集計・結果通知 — F-1-6 / F-1-7 の本体
 *
 * 処理の流れ:
 *   1. schedules / active メンバー / 全 responses を取得
 *   2. scheduleId ごとに canAttend=true の票数を集計
 *   3. MIN_ATTENDEES(4) 人以上集まるスケジュールを抽出
 *   4. 結果メッセージを組み立てて全 active メンバーに Push 送信
 *
 * @returns {{viable: number, sent: number, skipped: number}}
 */
function handleAggregateAndNotify() {
  var schedules = getSchedules();
  var members = getActiveMembers();

  if (schedules.length === 0 || members.length === 0) {
    console.log('[INFO] aggregateAndNotify: スケジュールまたはメンバーがいません。集計スキップ。');
    return { viable: 0, sent: 0, skipped: 0 };
  }

  // scheduleId ごとに canAttend=true の票数を集計
  var responses = getAllResponses();
  var voteCounts = {};
  for (var i = 0; i < responses.length; i++) {
    var r = responses[i];
    if (r.canAttend === true) {
      voteCounts[r.scheduleId] = (voteCounts[r.scheduleId] || 0) + 1;
    }
  }

  // MIN_ATTENDEES 人以上集まるスケジュールを抽出
  var viable = schedules.filter(function (s) {
    return (voteCounts[s.scheduleId] || 0) >= MIN_ATTENDEES;
  });

  var message = _buildResultMessage(viable, voteCounts);

  var sent = 0;
  var skipped = 0;

  for (var j = 0; j < members.length; j++) {
    var member = members[j];
    try {
      withRetry(function () {
        return pushText(member.userId, message);
      }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'pushResult' });
      sent++;
      console.log('[INFO] 結果通知完了: ' + _maskUserId(member.userId) +
                  ' (' + member.displayName + ')');
    } catch (pushError) {
      logError(pushError, {
        phase: 'aggregateAndNotify.push',
        userId: _maskUserId(member.userId),
        displayName: member.displayName
      });
      skipped++;
    }
  }

  console.log('[INFO] aggregateAndNotify 完了: viable=' + viable.length +
              ' sent=' + sent + ' skipped=' + skipped);
  return { viable: viable.length, sent: sent, skipped: skipped };
}

/**
 * 全員が回答済みかを確認し、済んでいれば 1 回だけ集計・通知を実行する(内部用)
 *
 * handleVote の末尾から呼ばれる。
 * スクリプトプロパティ `RESULTS_NOTIFIED` を使って 2 重通知を防ぐ。
 * 手動の aggregateAndNotify() 実行時はこのフラグをリセットする。
 *
 * @private
 */
function _checkAllRespondedAndNotify() {
  // 既に通知済みならスキップ
  var alreadyNotified = getProperty('RESULTS_NOTIFIED');
  if (alreadyNotified === 'true') {
    return;
  }

  var members = getActiveMembers();
  if (members.length === 0) {
    return;
  }

  var respondedIds = getRespondedUserIds();
  var respondedSet = {};
  for (var i = 0; i < respondedIds.length; i++) {
    respondedSet[respondedIds[i]] = true;
  }

  // 未回答者が 1 人でもいればまだ通知しない
  for (var j = 0; j < members.length; j++) {
    if (!respondedSet[members[j].userId]) {
      return;
    }
  }

  // 全員回答 → フラグを立ててから通知(二重通知防止)
  PropertiesService.getScriptProperties().setProperty('RESULTS_NOTIFIED', 'true');
  console.log('[INFO] 全員回答を確認。自動集計・通知を実行します。');
  handleAggregateAndNotify();
}

/**
 * 結果通知メッセージを組み立てる(内部用)
 *
 * viable が空なら「成立する日時なし」、あれば日程一覧を列挙する。
 * F-2-3: 同じ日時で複数体育館がある場合は「/」区切りで使える体育館を併記する。
 *
 * @param {Array<Object>} viable - 4 人以上が参加できるスケジュール配列
 * @param {Object} voteCounts - scheduleId → 票数 のマップ
 * @returns {string}
 * @private
 */
function _buildResultMessage(viable, voteCounts) {
  var lines = ['【日程調整 結果】'];

  if (viable.length === 0) {
    lines.push('');
    lines.push('申し訳ありません。' + MIN_ATTENDEES + ' 人以上参加できる日時が見つかりませんでした。');
    lines.push('');
    lines.push('改めて日程を調整します。しばらくお待ちください。');
  } else {
    lines.push('');
    lines.push(MIN_ATTENDEES + ' 人以上が参加できる日時です:');
    lines.push('');

    // F-2-3: 同じ日時(date+startTime+endTime)でグループ化して体育館名を集約する
    var groups = {};
    var groupOrder = [];
    for (var i = 0; i < viable.length; i++) {
      var s = viable[i];
      var key = s.date + '|' + s.startTime + '|' + s.endTime;
      if (!groups[key]) {
        groups[key] = { schedule: s, facilities: [], maxCount: 0 };
        groupOrder.push(key);
      }
      groups[key].facilities.push(s.facilityName);
      var count = voteCounts[s.scheduleId] || 0;
      // 同じ日時で複数体育館の票数が異なる場合は最大値を代表値として使う
      // (TBD-3 で通知文面が確定したタイミングで集計方法も再検討予定)
      if (count > groups[key].maxCount) {
        groups[key].maxCount = count;
      }
    }

    for (var k = 0; k < groupOrder.length; k++) {
      var g = groups[groupOrder[k]];
      lines.push('・' + _formatDateTimeLabel(g.schedule) + ' (' + g.maxCount + '人)');
      lines.push('  ' + g.facilities.join(' / ') + ' が利用可');
    }

    lines.push('');
    lines.push('詳細は改めてご連絡します。');
  }

  return lines.join('\n');
}

/**
 * 体育館名を除いた日時部分のラベルを返す(内部用)
 *
 * 生成例: "5/15(金) 18:00〜20:00"
 * _buildResultMessage が体育館名を別行で表示するために使う。
 * _formatScheduleLabel の共通ベースでもある。
 *
 * 'YYYY-MM-DDT00:00:00+09:00' とすることで Asia/Tokyo の日付として正しく解釈させる
 *
 * @param {{date: string, startTime: string, endTime: string}} schedule
 * @returns {string}
 * @private
 */
function _formatDateTimeLabel(schedule) {
  var weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  var date = new Date(schedule.date + 'T00:00:00+09:00');
  var m = date.getMonth() + 1; // getMonth() は 0 始まり
  var d = date.getDate();
  var w = weekdays[date.getDay()];
  return m + '/' + d + '(' + w + ') ' + schedule.startTime + '〜' + schedule.endTime;
}

/**
 * postback の data 文字列を key=value& 形式で parse する(内部用)
 *
 * 例: "action=vote&scheduleId=SCH_20260510143022_4831"
 *   → { action: 'vote', scheduleId: 'SCH_20260510143022_4831' }
 *
 * 用語補足:
 *   parse(パース) = 文字列を分解して、プログラムが使いやすい形に変換すること。
 *   ここでは "&" で区切り、さらに "=" で区切ることで key と value に分ける。
 *
 * @param {string} data - postback.data の文字列
 * @returns {Object} parse 結果(key-value のオブジェクト)
 * @private
 */
function _parsePostbackData(data) {
  var result = {};
  if (!data) {
    return result;
  }
  var pairs = data.split('&');
  for (var i = 0; i < pairs.length; i++) {
    var idx = pairs[i].indexOf('=');
    if (idx > 0) {
      var key = pairs[i].substring(0, idx);
      var value = pairs[i].substring(idx + 1);
      result[key] = decodeURIComponent(value);
    }
  }
  return result;
}

/**
 * userId をログ出力時にマスクする(内部用)
 *
 * LINE の userId は秘匿情報ではないが、ログに長文が並ぶと視認性が下がるため
 * 先頭 6 + 末尾 4 文字のみ表示する慣行的なマスキング。
 *
 * @param {string} userId
 * @returns {string} 例: "U12345...abcd"
 * @private
 */
function _maskUserId(userId) {
  if (!userId || userId.length < 12) {
    return '(short)';
  }
  return userId.substring(0, 6) + '...' + userId.substring(userId.length - 4);
}
