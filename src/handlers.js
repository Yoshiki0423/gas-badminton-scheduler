/**
 * @fileoverview F-1-1 メンバー自動登録機能 — イベントハンドラー
 *
 * follow / unfollow イベントを受け取って、実際の業務処理(=スプレッドシート更新 +
 * 歓迎メッセージ送信)を行うファイルです。
 *
 * 各関数の役割を 1 行で:
 *   - handleFollow(event)               : 新メンバー登録 + 歓迎メッセージ
 *   - handleUnfollow(event)             : メンバーを inactive に変更(削除はしない)
 *   - handleDistributeSurvey()          : 全 active メンバーに 2 ボタン Flex Message を Push 配信(F-1-3 / F-3-6)
 *   - handleSendReminders()             : 未回答メンバーに 2 ボタン Flex Message を再送(F-1-5 / F-3-6)
 *   - handleLiffGetData(userId)         : LIFF 回答フォーム用データ取得(F-3-4)
 *   - handleLiffSubmit(userId, answers) : LIFF 回答送信・全削除→再挿入(F-3-4)
 *   - handleLiffGetAllResponses()       : LIFF 回答状況確認ページ用データ取得(F-3-5)
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
 * 質問配信・リマインドで送るスケジュールの対象期間(今日から N 日以内)
 */
var SURVEY_SCHEDULE_DAYS = 14;

/**
 * (Phase 1 互換・内部用) Flex Carousel を組み立てる関数群
 * D-021: F-3-6 で配信・リマインドからは呼ばれなくなるが、デバッグ・将来復活用として残す
 */
var SURVEY_FLEX_MAX_PER_BUBBLE = 3;
var SURVEY_FLEX_MAX_BUBBLES = 12;

/**
 * 質問配信 — F-1-3 / F-3-6 の本体
 *
 * F-3-6 変更点:
 *   従来の Flex Carousel(スケジュールごとのボタン)から
 *   「2 ボタン Flex Message」(回答する / 回答状況を見る)に変更。
 *
 * 処理の流れ:
 *   1. schedules シートから直近 14 日のスケジュールを取得
 *   2. members シートから active なメンバーだけを取得
 *   3. 2 ボタン Flex Message を組み立てる
 *   4. 全 active メンバーに Push API で 1 対 1 送信する
 *
 * @returns {{sent: number, skipped: number}}
 */
function handleDistributeSurvey() {
  // 新アンケート配信のタイミングで自動集計フラグをリセットする。
  PropertiesService.getScriptProperties().deleteProperty('RESULTS_NOTIFIED');

  // (1) スケジュール取得 → 直近 SURVEY_SCHEDULE_DAYS 日以内に絞り込む
  var schedules = _filterUpcomingSchedules(getSchedules(), SURVEY_SCHEDULE_DAYS);
  console.log('[INFO] distributeSurvey: 絞り込み後スケジュール件数=' + schedules.length + ' (直近' + SURVEY_SCHEDULE_DAYS + '日以内)');
  if (schedules.length === 0) {
    console.log('[INFO] distributeSurvey: 直近 ' + SURVEY_SCHEDULE_DAYS + ' 日以内のスケジュールがありません。配信をスキップします。');
    return { sent: 0, skipped: 0 };
  }

  // (2) アクティブメンバー取得
  var members = getActiveMembers();
  if (members.length === 0) {
    console.log('[INFO] distributeSurvey: active メンバーがいません。配信をスキップします。');
    return { sent: 0, skipped: 0 };
  }

  // (3) 2 ボタン Flex Message 組み立て(F-3-6)
  var flexContents = _buildTwoButtonFlex('直近のスケジュールが届きました！\n参加できる日時を回答してください。');
  var altText = '【日程調整】参加できる日時を回答してください(' + schedules.length + '件)';

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
 * 2 ボタン Flex Message を組み立てる(F-3-6 用・内部関数)
 *
 * 「回答する」「回答状況を見る」の 2 ボタンを並べた 1 枚の Bubble を返す。
 * LIFF URL はスクリプトプロパティ LIFF_FORM_ID / LIFF_RESULTS_ID から生成する。
 *
 * @param {string} bodyText - body に表示するテキスト
 * @returns {Object} LINE Flex Message の bubble オブジェクト
 * @private
 */
function _buildTwoButtonFlex(bodyText) {
  var liffFormId    = getProperty('LIFF_FORM_ID');
  var liffResultsId = getProperty('LIFF_RESULTS_ID');

  // LIFF URL の形式: https://liff.line.me/{LIFF_ID}
  var liffFormUrl    = liffFormId    ? 'https://liff.line.me/' + liffFormId    : '#';
  var liffResultsUrl = liffResultsId ? 'https://liff.line.me/' + liffResultsId : '#';

  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#06C755',
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
      contents: [{
        type: 'text',
        text: bodyText,
        wrap: true,
        size: 'sm',
        color: '#555555'
      }]
    },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#06C755',
          height: 'sm',
          action: {
            type: 'uri',
            label: '回答する',
            uri: liffFormUrl
          }
        },
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'uri',
            label: '回答状況を見る',
            uri: liffResultsUrl
          }
        }
      ]
    }
  };
}

/**
 * Flex Message の中身(contents)を組み立てる(内部用・Phase 1 互換)
 *
 * D-021: F-3-6 以降は _buildTwoButtonFlex が使われるが、
 * デバッグや将来復活の可能性を考慮してコードは残す。
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

  // 3 件ずつ Bubble に分割して Carousel に束ねる(LINE 上限の 12 バブルで打ち切り)
  var bubbles = [];
  for (var i = 0; i < schedules.length; i += SURVEY_FLEX_MAX_PER_BUBBLE) {
    if (bubbles.length >= SURVEY_FLEX_MAX_BUBBLES) {
      break;
    }
    var chunk = schedules.slice(i, Math.min(i + SURVEY_FLEX_MAX_PER_BUBBLE, schedules.length));
    bubbles.push(_buildSurveyBubble(chunk));
  }

  return { type: 'carousel', contents: bubbles };
}

/**
 * 1 つの Bubble を組み立てる(内部用・Phase 1 互換)
 *
 * D-021: 将来復活用として残す。
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
    '質問が届いたら、ボタンをタップして回答フォームを開いてください。',
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
 * 後方互換として残す。Phase 3 以降もポストバック経由の回答は引き続き受け付ける。
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

  // (2) responses シートに記録(第3引数なし → デフォルト canAttend=true)
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
 * リマインド送信 — F-1-5 / F-3-6 の本体
 *
 * F-3-6 変更点:
 *   従来の「テキスト + Flex Carousel」から「2 ボタン Flex Message」に変更。
 *
 * まだ 1 件も回答していない active メンバーだけを対象に、
 * リマインドテキスト + 2 ボタン Flex Message を Push API で送信する。
 *
 * @returns {{sent: number, skipped: number, unresponded: number}}
 */
function handleSendReminders() {
  var schedules = _filterUpcomingSchedules(getSchedules(), SURVEY_SCHEDULE_DAYS);
  if (schedules.length === 0) {
    console.log('[INFO] sendReminders: 直近 ' + SURVEY_SCHEDULE_DAYS + ' 日以内のスケジュールがありません。リマインドをスキップします。');
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

  // 2 ボタン Flex Message(F-3-6)
  var flexContents = _buildTwoButtonFlex('リマインドです。\nまだ回答が届いていません。\n下のボタンから回答をお願いします。');
  var altText = '【リマインド】まだ回答が届いていません。ご回答をお願いします。';

  var sent = 0;
  var skipped = 0;

  for (var j = 0; j < unresponded.length; j++) {
    var member = unresponded[j];
    try {
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
 * @private
 */
function _checkAllRespondedAndNotify() {
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
 *
 * @param {{date: string, startTime: string, endTime: string}} schedule
 * @returns {string}
 * @private
 */
function _formatDateTimeLabel(schedule) {
  var weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  var date = new Date(schedule.date + 'T00:00:00+09:00');
  var m = date.getMonth() + 1;
  var d = date.getDate();
  var w = weekdays[date.getDay()];
  return m + '/' + d + '(' + w + ') ' + schedule.startTime + '〜' + schedule.endTime;
}

/**
 * スケジュール配列を今日から N 日以内のものだけに絞り込む(内部用)
 *
 * @param {Array<Object>} schedules
 * @param {number} days
 * @returns {Array<Object>}
 * @private
 */
function _filterUpcomingSchedules(schedules, days) {
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var limitDate = new Date(todayStr + 'T00:00:00+09:00');
  limitDate.setDate(limitDate.getDate() + days);
  var limitStr = Utilities.formatDate(limitDate, 'Asia/Tokyo', 'yyyy-MM-dd');

  return schedules.filter(function (s) {
    return s.date >= todayStr && s.date <= limitStr;
  });
}

/**
 * postback の data 文字列を key=value& 形式で parse する(内部用)
 *
 * @param {string} data
 * @returns {Object}
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
 * @param {string} userId
 * @returns {string}
 * @private
 */
function _maskUserId(userId) {
  if (!userId || userId.length < 12) {
    return '(short)';
  }
  return userId.substring(0, 6) + '...' + userId.substring(userId.length - 4);
}

// ─────────────────────────────────────────────
// F-3: LIFF ハンドラー
// ─────────────────────────────────────────────

/**
 * LIFF 回答フォーム用データを取得する(F-3-4)
 *
 * Code.js の `liffGetSchedulesAndResponses(idToken)` から呼ばれる。
 * 直近 14 日のスケジュール一覧と、このユーザーの前回答を返す。
 *
 * 返却データのイメージ:
 *   {
 *     schedules: [
 *       { scheduleId: "SCH_xxx", date: "2026-05-15", startTime: "18:00", endTime: "20:00", facilityName: "体育館A" },
 *       ...
 *     ],
 *     userAnswers: {
 *       "SCH_xxx": "can",       // 行ける
 *       "SCH_yyy": "undecided"  // 未定
 *       // 未回答のスケジュールはキーなし
 *     }
 *   }
 *
 * @param {string} userId - 検証済み LINE ユーザー ID
 * @returns {{ schedules: Array<Object>, userAnswers: Object }}
 */
function handleLiffGetData(userId) {
  // 直近 SURVEY_SCHEDULE_DAYS 日のスケジュールを取得
  var allSchedules = getSchedules();
  var schedules = _filterUpcomingSchedules(allSchedules, SURVEY_SCHEDULE_DAYS);

  // スケジュールオブジェクトは HTML 側で必要な項目のみに絞る
  var scheduleList = schedules.map(function (s) {
    return {
      scheduleId:   s.scheduleId,
      date:         s.date,
      startTime:    s.startTime,
      endTime:      s.endTime,
      facilityName: s.facilityName
    };
  });

  // このユーザーの前回答を取得して { scheduleId: 'can'|'undecided' } の形に変換
  var prevResponses = getResponsesByUserId(userId);
  var userAnswers = {};
  for (var i = 0; i < prevResponses.length; i++) {
    var r = prevResponses[i];
    if (r.canAttend === true) {
      userAnswers[r.scheduleId] = 'can';
    } else if (r.canAttend === 'undecided') {
      userAnswers[r.scheduleId] = 'undecided';
    }
    // それ以外(false 等)はスキップ
  }

  return {
    schedules: scheduleList,
    userAnswers: userAnswers
  };
}

/**
 * LIFF フォームの回答を一括送信する(F-3-4)
 *
 * Code.js の `liffSubmitResponses(idToken, answers)` から呼ばれる。
 *
 * 処理フロー(D-020「全削除→再挿入」パターン):
 *   1. この userId の既存回答をすべて削除する
 *   2. answers の各エントリを upsertResponse で挿入する
 *
 * answers の形:
 *   { 'SCH_xxx': 'can', 'SCH_yyy': 'undecided' }
 *   ※ 未選択のスケジュールは含まれない(= 削除後に挿入されない = 行けない扱い)
 *
 * AC-11(送信後に Bot メッセージなし): LINE Push API は呼ばない。
 *
 * @param {string} userId - 検証済み LINE ユーザー ID
 * @param {Object} answers - { scheduleId: 'can' | 'undecided' } のオブジェクト
 * @returns {{ deleted: number, inserted: number }}
 */
function handleLiffSubmit(userId, answers) {
  if (!userId) {
    throw new Error('handleLiffSubmit: userId is required');
  }
  if (!answers || typeof answers !== 'object') {
    throw new Error('handleLiffSubmit: answers must be an object');
  }

  // (1) この userId の既存回答を全削除
  var deleted = clearResponsesByUserId(userId);

  // (2) answers の各エントリを挿入
  var inserted = 0;
  var scheduleIds = Object.keys(answers);
  for (var i = 0; i < scheduleIds.length; i++) {
    var scheduleId = scheduleIds[i];
    var answerValue = answers[scheduleId];

    // 'can' → true(行ける) / 'undecided' → 'undecided'(未定)
    var canAttend;
    if (answerValue === 'can') {
      canAttend = true;
    } else if (answerValue === 'undecided') {
      canAttend = 'undecided';
    } else {
      // 想定外の値はスキップしてログを残す
      console.warn('[WARN] handleLiffSubmit: unknown answer value="' + answerValue +
                   '" for scheduleId=' + scheduleId + '. Skipping.');
      continue;
    }

    upsertResponse(userId, scheduleId, canAttend);
    inserted++;
  }

  console.log('[INFO] handleLiffSubmit: userId=' + _maskUserId(userId) +
              ' deleted=' + deleted + ' inserted=' + inserted);
  return { deleted: deleted, inserted: inserted };
}

/**
 * LIFF 回答送信 — 一括書き込み版(高速)
 *
 * handleLiffSubmit と同じ目的だが、ロック取得・シート読み書きをそれぞれ
 * 1 回にまとめることで実行時間を短縮する。LIFF API (_handleLiffApi) から呼ぶ。
 */
function handleLiffSubmitFast(userId, answers) {
  if (!userId) throw new Error('handleLiffSubmitFast: userId is required');
  if (!answers || typeof answers !== 'object') throw new Error('handleLiffSubmitFast: answers must be an object');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('handleLiffSubmitFast: could not acquire lock');

  try {
    var sheet = getResponsesSheet();
    var lastRow = sheet.getLastRow();
    var deleted = 0;

    // (1) この userId の既存行を一括削除
    if (lastRow >= 2) {
      var colB = sheet.getRange(2, RCOL_USER_ID, lastRow - 1, 1).getValues();
      var toDelete = [];
      for (var i = 0; i < colB.length; i++) {
        if (colB[i][0] === userId) toDelete.push(i + 2);
      }
      toDelete.sort(function (a, b) { return b - a; });
      for (var d = 0; d < toDelete.length; d++) sheet.deleteRow(toDelete[d]);
      deleted = toDelete.length;
    }

    // (2) 新しい回答を一括挿入
    var nowIso = _toIsoTokyo(new Date());
    var scheduleIds = Object.keys(answers);
    var newRows = [];
    for (var k = 0; k < scheduleIds.length; k++) {
      var sid = scheduleIds[k];
      var val = answers[sid];
      var canAttend;
      if (val === 'can') canAttend = true;
      else if (val === 'undecided') canAttend = 'undecided';
      else continue;
      newRows.push([_generateResponseId(), userId, sid, canAttend, nowIso, nowIso]);
    }

    if (newRows.length > 0) {
      var startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, newRows.length, RESPONSES_HEADER.length).setValues(newRows);
    }

    SpreadsheetApp.flush();
    console.log('[INFO] handleLiffSubmitFast: userId=' + _maskUserId(userId) +
                ' deleted=' + deleted + ' inserted=' + newRows.length);
    return { deleted: deleted, inserted: newRows.length };

  } finally {
    lock.releaseLock();
  }
}

/**
 * LIFF 回答状況確認ページ用データを取得する(F-3-5)
 *
 * Code.js の `liffGetAllResponses(idToken)` から呼ばれる。
 * 全スケジュールに対する全メンバーの回答状況を返す(AC-12 対応)。
 *
 * 返却データのイメージ:
 *   {
 *     schedules: [
 *       { scheduleId: "SCH_xxx", date: "2026-05-15", startTime: "18:00", endTime: "20:00", facilityName: "体育館A" },
 *       ...
 *     ],
 *     responses: {
 *       "SCH_xxx": {
 *         can: ["田中", "佐藤"],       // 行ける人の displayName リスト
 *         undecided: ["山田"]           // 未定の人の displayName リスト
 *       },
 *       ...
 *     }
 *   }
 *
 * 設計ポイント:
 *   - members シートの displayName を使う(LINE API を都度叩かない)
 *   - 直近 14 日のスケジュールに絞る(handleLiffGetData と同じ期間)
 *
 * @returns {{ schedules: Array<Object>, responses: Object }}
 */
function handleLiffGetAllResponses() {
  // 直近 14 日のスケジュール
  var allSchedules = getSchedules();
  var schedules = _filterUpcomingSchedules(allSchedules, SURVEY_SCHEDULE_DAYS);

  var scheduleList = schedules.map(function (s) {
    return {
      scheduleId:   s.scheduleId,
      date:         s.date,
      startTime:    s.startTime,
      endTime:      s.endTime,
      facilityName: s.facilityName
    };
  });

  // userId → displayName のマップを members シートから作る
  var members = getActiveMembers();
  var userNameMap = {};
  for (var i = 0; i < members.length; i++) {
    userNameMap[members[i].userId] = members[i].displayName || '(名前不明)';
  }

  // 全回答を取得して scheduleId ごとに集計
  var allResponses = getAllResponses();

  // まず scheduleId ごとの空の集計オブジェクトを作る
  var responseMap = {};
  for (var j = 0; j < scheduleList.length; j++) {
    responseMap[scheduleList[j].scheduleId] = { can: [], undecided: [] };
  }

  // 回答を振り分ける
  for (var k = 0; k < allResponses.length; k++) {
    var resp = allResponses[k];
    if (!responseMap[resp.scheduleId]) {
      // 直近 14 日の範囲外のスケジュールの回答はスキップ
      continue;
    }

    var name = userNameMap[resp.userId] || '(不明)';

    if (resp.canAttend === true) {
      responseMap[resp.scheduleId].can.push(name);
    } else if (resp.canAttend === 'undecided') {
      responseMap[resp.scheduleId].undecided.push(name);
    }
  }

  return {
    schedules: scheduleList,
    responses: responseMap
  };
}
