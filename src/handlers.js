/**
 * @fileoverview F-1-1 メンバー自動登録機能 / F-5 グループトーク対応 — イベントハンドラー
 *
 * follow / unfollow / join / memberJoined イベントを受け取って、
 * 実際の業務処理(スプレッドシート更新 + メッセージ送信)を行うファイルです。
 *
 * 各関数の役割を 1 行で:
 *   - handleFollow(event)               : 新メンバー登録 + 歓迎メッセージ(1対1用・後方互換)
 *   - handleUnfollow(event)             : メンバーを inactive に変更(削除はしない)
 *   - handleJoin(event)                 : グループ参加時にグループ ID を保存する(F-5)
 *   - handleMemberJoined(event)         : グループへの新メンバー参加時に自動登録する(F-5)
 *   - handleVote(event)                 : D-018 でカルーセル廃止済み・no-op
 *   - handleDistributeSurvey()          : グループトークに 2 ボタン Flex Message を Push 配信(F-1-3 / F-3-6 / F-5)
 *   - handleSendReminders()             : 未回答メンバーに個別 Push を再送(F-1-5 / F-3-6・変更なし)
 *   - handleLiffGetData(userId)         : F-4 グリッドフォーム用データ取得(日付×スロット構造)
 *   - handleLiffSubmitFast(userId, answers) : F-4 回答一括送信(新データモデル)
 *   - handleLiffGetAllResponses()       : F-4 LIFF 回答状況確認ページ用データ取得
 *   - _checkAndNotifyViableSlots()      : 4人以上即通知チェック(F-5)
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
// F-5: グループトーク対応
// ─────────────────────────────────────────────

/**
 * join イベント処理 — Bot がグループに招待されたときの処理(F-5)
 *
 * Bot がグループトークに招待されると LINE から `join` イベントが届きます。
 * このとき `event.source.groupId` を ScriptProperties の `LINE_GROUP_ID` に保存します。
 * 以降のすべてのグループ宛通知は、この groupId を使います。
 *
 * 設計上の注意:
 *   - 保存だけ行い、グループへのメッセージ送信は行わない(不要なメッセージを送らない)
 *   - groupId が取得できない場合はログのみ(エラーにしない)
 *
 * @param {Object} event - LINE join イベント
 *   - event.source.groupId : グループ ID(必須)
 * @returns {void}
 */
function handleJoin(event) {
  var groupId = (event && event.source && event.source.groupId) ? event.source.groupId : '';

  if (!groupId) {
    console.warn('[WARN] handleJoin: groupId is missing. event.source=' +
                 JSON.stringify(event && event.source));
    return;
  }

  try {
    PropertiesService.getScriptProperties().setProperty('LINE_GROUP_ID', groupId);
    console.log('[INFO] handleJoin: グループ ID を保存しました。groupId=' + groupId);
  } catch (err) {
    logError(err, { phase: 'handleJoin.setProperty', groupId: groupId });
  }
}

/**
 * memberJoined イベント処理 — グループへの新メンバー参加時に自動登録する(F-5)
 *
 * グループトークに新しいメンバーが参加すると `memberJoined` イベントが届きます。
 * `event.joined.members` をループして各メンバーを自動でメンバーシートに登録します。
 * handleFollow と同じ登録処理(upsertMemberAsActive)を使います。
 *
 * 設計上の注意:
 *   - グループメンバーは友達追加なしで参加できるため、follow イベントの代わりにこちらを使う
 *   - プロフィール取得失敗時は「(名前不明)」として登録する(登録自体は続行)
 *   - 1人失敗しても次のメンバーへ続行する(全員分を処理する)
 *
 * @param {Object} event - LINE memberJoined イベント
 *   - event.joined.members : 参加したメンバーの配列
 *     各メンバーは { type: 'user', userId: '...' } の形式
 * @returns {void}
 */
function handleMemberJoined(event) {
  var members = (event && event.joined && event.joined.members) ? event.joined.members : [];

  if (members.length === 0) {
    console.warn('[WARN] handleMemberJoined: joined.members が空です');
    return;
  }

  for (var i = 0; i < members.length; i++) {
    var member = members[i];
    var userId = (member && member.type === 'user' && member.userId) ? member.userId : '';

    if (!userId) {
      console.warn('[WARN] handleMemberJoined: userId が取得できませんでした。member=' +
                   JSON.stringify(member));
      continue;
    }

    // (1) プロフィール取得(失敗しても登録は続行)
    var displayName = '(名前不明)';
    try {
      var profile = getLineProfile(userId);
      if (profile && profile.displayName) {
        displayName = profile.displayName;
      }
    } catch (profileError) {
      logError(profileError, { phase: 'handleMemberJoined.getProfile', userId: userId });
    }

    // (2) メンバーシートに登録 or 復活
    try {
      upsertMemberAsActive(userId, displayName);
      console.log('[INFO] handleMemberJoined: 登録完了 userId=' + _maskUserId(userId) +
                  ' displayName=' + displayName);
    } catch (sheetError) {
      logError(sheetError, { phase: 'handleMemberJoined.upsert', userId: userId });
    }
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
 * 質問配信 — F-1-3 / F-3-6 / F-5 の本体
 *
 * F-5 変更点:
 *   全 active メンバーへの個別 Push から「グループに 1 通」に変更。
 *   また、新しいアンケート配信のタイミングで VIABLE_NOTIFIED_SLOT_* 系のフラグを
 *   全削除してリセットする(4人以上即通知の重複防止フラグのリセット)。
 *
 * 処理の流れ:
 *   1. schedules シートから直近 14 日のスケジュールを取得
 *   2. VIABLE_NOTIFIED_SLOT_* 系のキーを全削除(新アンケート開始のため)
 *   3. 2 ボタン Flex Message を組み立てる
 *   4. グループ ID を取得してグループに 1 通 Push 送信する
 *
 * @returns {{sent: number, skipped: number}}
 */
function handleDistributeSurvey() {
  // 新アンケート配信のタイミングで自動集計フラグをリセットする。
  PropertiesService.getScriptProperties().deleteProperty('RESULTS_NOTIFIED');

  // F-5: 4人以上即通知の重複防止フラグをすべて削除する(新しいアンケートが始まるため)
  _resetViableNotifiedSlotFlags();

  // (1) スケジュール取得 → 直近 SURVEY_SCHEDULE_DAYS 日以内に絞り込む
  var schedules = _filterUpcomingSchedules(getSchedules(), SURVEY_SCHEDULE_DAYS);
  console.log('[INFO] distributeSurvey: 絞り込み後スケジュール件数=' + schedules.length + ' (直近' + SURVEY_SCHEDULE_DAYS + '日以内)');
  if (schedules.length === 0) {
    console.log('[INFO] distributeSurvey: 直近 ' + SURVEY_SCHEDULE_DAYS + ' 日以内のスケジュールがありません。配信をスキップします。');
    return { sent: 0, skipped: 0 };
  }

  // (2) グループ ID を取得する
  var groupId = getProperty('LINE_GROUP_ID');
  if (!groupId) {
    console.warn('[WARN] distributeSurvey: LINE_GROUP_ID が未設定です。配信をスキップします。');
    return { sent: 0, skipped: 1 };
  }

  // (3) 2 ボタン Flex Message 組み立て(F-3-6)
  var flexContents = _buildTwoButtonFlex('直近のスケジュールが届きました！\n参加できる日時を回答してください。');
  var altText = '【日程調整】参加できる日時を回答してください(' + schedules.length + '件)';

  // (4) グループに 1 通 Push 送信(F-5)
  try {
    withRetry(function () {
      return pushFlexMessage(groupId, altText, flexContents);
    }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'pushSurvey' });
    console.log('[INFO] distributeSurvey 完了: グループ(' + groupId + ')に送信しました');
    return { sent: 1, skipped: 0 };
  } catch (pushError) {
    logError(pushError, { phase: 'distributeSurvey.push', groupId: groupId });
    return { sent: 0, skipped: 1 };
  }
}

/**
 * VIABLE_NOTIFIED_SLOT_* 系のキーをすべて削除する(内部用・F-5)
 *
 * 新しいアンケートが配信されたタイミングで呼ばれます。
 * `VIABLE_NOTIFIED_SLOT_` で始まるすべてのキーを ScriptProperties から削除します。
 *
 * @private
 */
function _resetViableNotifiedSlotFlags() {
  try {
    var props = PropertiesService.getScriptProperties().getProperties();
    var keysToDelete = [];
    var prefix = 'VIABLE_NOTIFIED_SLOT_';
    for (var key in props) {
      if (key.indexOf(prefix) === 0) {
        keysToDelete.push(key);
      }
    }
    for (var i = 0; i < keysToDelete.length; i++) {
      PropertiesService.getScriptProperties().deleteProperty(keysToDelete[i]);
    }
    console.log('[INFO] _resetViableNotifiedSlotFlags: ' + keysToDelete.length + ' 件のフラグを削除しました');
  } catch (err) {
    logError(err, { phase: '_resetViableNotifiedSlotFlags' });
  }
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
// F-1-4: 回答収集機能(postback)
// ─────────────────────────────────────────────

/**
 * postback イベント処理 — D-018 でカルーセル廃止済み・no-op
 *
 * D-018 でカルーセル(postback 経由の個別スケジュール投票)は廃止済み。
 * F-4 以降の回答は LIFF グリッドフォーム経由のみ。
 * postback が来た場合は無視してログだけ残す。
 *
 * @param {Object} event - LINE postback イベント
 * @returns {void}
 */
function handleVote(event) {
  // D-018 でカルーセル廃止済み。postback は受け付けるが何もしない。
  console.log('[INFO] handleVote: deprecated since D-018, ignoring.');
}

// ─────────────────────────────────────────────
// F-1-5: リマインド送信機能
// ─────────────────────────────────────────────

/**
 * リマインド送信 — F-1-5 / F-3-6 の本体
 *
 * F-5 非変更: リマインドは未回答者に個別 Push を継続する。
 * 理由: 未回答者のみを対象にするためには userId が必要なため。
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
// F-1-6 / F-1-7: 集計・判定・結果通知機能(F-4 / F-5 対応版)
// ─────────────────────────────────────────────

/** 「成立」と見なす最小参加人数(REQUIREMENTS.md §2 より) */
var MIN_ATTENDEES = 4;

/**
 * 集計・結果通知 — F-1-6 / F-1-7 の本体(F-4 スロット単位 / F-5 グループ送信対応版)
 *
 * F-5 変更点:
 *   全 active メンバーへの個別 Push から「グループに 1 通」に変更。
 *   グループ ID が未設定の場合はログを出して処理をスキップ(エラーにしない)。
 *
 * @returns {{viable: number, sent: number, skipped: number}}
 */
function handleAggregateAndNotify() {
  // (date, slotStart) ごとに can / undecided の票数を集計(△も参加候補として含める)
  var responses = getAllSlotResponses();
  var canCounts = {};       // key: 'YYYY-MM-DD|HH:mm' → can 票数
  var undecidedCounts = {}; // key: 'YYYY-MM-DD|HH:mm' → undecided 票数

  for (var i = 0; i < responses.length; i++) {
    var r = responses[i];
    var key = r.date + '|' + r.slotStart;
    if (r.answer === 'can') {
      canCounts[key] = (canCounts[key] || 0) + 1;
    } else if (r.answer === 'undecided') {
      undecidedCounts[key] = (undecidedCounts[key] || 0) + 1;
    }
  }

  // ○＋△の合計が MIN_ATTENDEES 人以上のスロットを抽出
  var viableSlots = [];
  var keySet = {};
  var allKeys = Object.keys(canCounts).concat(Object.keys(undecidedCounts));
  for (var ki = 0; ki < allKeys.length; ki++) { keySet[allKeys[ki]] = true; }
  var allSlotKeys = Object.keys(keySet);
  for (var k = 0; k < allSlotKeys.length; k++) {
    var total = (canCounts[allSlotKeys[k]] || 0) + (undecidedCounts[allSlotKeys[k]] || 0);
    if (total >= MIN_ATTENDEES) {
      viableSlots.push(allSlotKeys[k]);
    }
  }
  viableSlots.sort();  // 日付・時刻順でソート

  var message = _buildSlotResultMessage(viableSlots, canCounts, undecidedCounts);

  // F-5: グループに 1 通送信する
  var groupId = getProperty('LINE_GROUP_ID');
  if (!groupId) {
    console.warn('[WARN] handleAggregateAndNotify: LINE_GROUP_ID が未設定です。通知をスキップします。');
    return { viable: viableSlots.length, sent: 0, skipped: 1 };
  }

  try {
    withRetry(function () {
      return pushText(groupId, message);
    }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'pushResult' });
    console.log('[INFO] aggregateAndNotify 完了: viable=' + viableSlots.length +
                ' グループ(' + groupId + ')に送信しました');
    return { viable: viableSlots.length, sent: 1, skipped: 0 };
  } catch (pushError) {
    logError(pushError, { phase: 'aggregateAndNotify.push', groupId: groupId });
    return { viable: viableSlots.length, sent: 0, skipped: 1 };
  }
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
 * スロット単位の結果通知メッセージを組み立てる(内部用・F-4 対応)
 *
 * @param {Array<string>} viableSlots    - 成立スロットのキー配列 ('YYYY-MM-DD|HH:mm')
 * @param {Object}        canCounts      - スロットキー → can 票数 のマップ
 * @param {Object}        undecidedCounts - スロットキー → undecided 票数 のマップ
 * @returns {string}
 * @private
 */
function _buildSlotResultMessage(viableSlots, canCounts, undecidedCounts) {
  var lines = ['【日程調整 結果】'];
  var SLOT_ENDS = {
    '09:00': '11:00', '11:00': '13:00', '13:00': '15:00',
    '15:00': '17:00', '17:00': '19:00', '19:00': '21:00'
  };

  if (viableSlots.length === 0) {
    lines.push('');
    lines.push('申し訳ありません。' + MIN_ATTENDEES + ' 人以上参加できる時間帯が見つかりませんでした。');
    lines.push('');
    lines.push('改めて日程を調整します。しばらくお待ちください。');
  } else {
    lines.push('');
    lines.push(MIN_ATTENDEES + ' 人以上が参加できる時間帯です:');
    lines.push('');

    for (var i = 0; i < viableSlots.length; i++) {
      var parts = viableSlots[i].split('|');
      var date = parts[0];
      var slotStart = parts[1];
      var slotEnd = SLOT_ENDS[slotStart] || '?';
      var canCount = canCounts[viableSlots[i]] || 0;
      var undecidedCount = undecidedCounts[viableSlots[i]] || 0;
      var total = canCount + undecidedCount;

      var weekdays = ['日', '月', '火', '水', '木', '金', '土'];
      var d = new Date(date + 'T00:00:00+09:00');
      var m = d.getMonth() + 1;
      var day = d.getDate();
      var w = weekdays[d.getDay()];

      var countStr = total + '人: ○' + canCount;
      if (undecidedCount > 0) { countStr += ' △' + undecidedCount; }

      lines.push('・' + m + '/' + day + '(' + w + ') ' + slotStart + '〜' + slotEnd + ' (' + countStr + ')');
    }

    lines.push('');
    lines.push('詳細は改めてご連絡します。');
  }

  return lines.join('\n');
}

/**
 * 後方互換: 旧 _buildResultMessage(viable, voteCounts) を呼ぶ箇所のために残す
 *
 * @deprecated F-4 以降は _buildSlotResultMessage を使う
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
// 管理者テキストコマンド
// ─────────────────────────────────────────────

/**
 * LINE テキストメッセージを管理者コマンドとして処理する
 *
 * ADMIN_USER_ID と一致する送信者のみコマンドを受け付ける。
 * F-5 対応: source.type が 'user'(1対1)でも 'group'(グループ)でも動作する。
 * ADMIN_USER_ID との照合は変わらず行う(グループ内でも管理者だけが使える)。
 *
 * 対応コマンド: /配信 /リマインド /状況 /集計 /ヘルプ
 *
 * @param {Object} event - LINE message イベント
 */
function handleTextMessage(event) {
  var userId = event.source && event.source.userId;
  var replyToken = event.replyToken;
  var text = event.message && event.message.text;
  if (!userId || !text || !replyToken) return;

  var adminUserId = getProperty('ADMIN_USER_ID');
  if (!adminUserId || userId !== adminUserId) return;

  var cmd = text.trim();

  try {
    if (cmd === '/配信') {
      var distResult = handleDistributeSurvey();
      replyText(replyToken, 'アンケートを配信しました ✅\n送信: ' + distResult.sent + '件');

    } else if (cmd === '/リマインド') {
      var remResult = handleSendReminders();
      replyText(replyToken, 'リマインドを送信しました ✅\n対象: ' + remResult.unresponded + '人 / 送信: ' + remResult.sent + '人');

    } else if (cmd === '/状況') {
      replyText(replyToken, _buildStatusMessage());

    } else if (cmd === '/集計') {
      PropertiesService.getScriptProperties().deleteProperty('RESULTS_NOTIFIED');
      var aggResult = handleAggregateAndNotify();
      replyText(replyToken, '集計・通知を実行しました ✅\n成立スロット: ' + aggResult.viable + '件 / 送信: ' + aggResult.sent + '件');

    } else if (cmd === '/ヘルプ') {
      replyText(replyToken,
        '【管理者コマンド一覧】\n' +
        '/配信 — アンケートを全員に送る\n' +
        '/リマインド — 未回答の人にリマインド\n' +
        '/状況 — 回答状況を確認\n' +
        '/集計 — 集計して全員に結果通知\n' +
        '/ヘルプ — このヘルプを表示'
      );
    }
  } catch (err) {
    logError(err, { phase: 'handleTextMessage', cmd: cmd });
    try {
      replyText(replyToken, '❌ エラーが発生しました: ' + err.message);
    } catch (_) {}
  }
}

/**
 * 回答状況メッセージを組み立てる(内部用)
 * @returns {string}
 * @private
 */
function _buildStatusMessage() {
  var members = getActiveMembers();
  if (members.length === 0) {
    return '【回答状況】\nメンバーが登録されていません。';
  }

  var respondedIds = getRespondedUserIds();
  var respondedSet = {};
  for (var i = 0; i < respondedIds.length; i++) {
    respondedSet[respondedIds[i]] = true;
  }

  var responded = [];
  var notResponded = [];
  for (var j = 0; j < members.length; j++) {
    var m = members[j];
    if (respondedSet[m.userId]) {
      responded.push(m.displayName);
    } else {
      notResponded.push(m.displayName);
    }
  }

  var lines = [
    '【回答状況】',
    '',
    '✅ 回答済み (' + responded.length + '人)'
  ];
  if (responded.length > 0) lines.push(responded.join('、'));
  lines.push('');
  lines.push('⏳ 未回答 (' + notResponded.length + '人)');
  if (notResponded.length > 0) lines.push(notResponded.join('、'));

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// F-4: LIFF ハンドラー(グリッドフォーム対応版)
// ─────────────────────────────────────────────

/**
 * F-4 グリッドフォーム用データを取得する
 *
 * Code.js の `_handleLiffApi` から `liff=getSchedules` で呼ばれる。
 * 直近 14 日のスケジュールを日付単位にまとめ、6スロットの available フラグと
 * このユーザーの前回答を返す。
 *
 * 返却データの形:
 *   {
 *     dates: [
 *       {
 *         date: 'YYYY-MM-DD',
 *         dateLabel: '5/14(木)',
 *         facilityInfo: '📍東総合 13〜21 / 鳥屋野 終日',
 *         slots: [
 *           { slotStart: '09:00', available: false },
 *           { slotStart: '11:00', available: false },
 *           { slotStart: '13:00', available: true },
 *           ...
 *         ]
 *       },
 *       ...
 *     ],
 *     userAnswers: { 'YYYY-MM-DD|HH:mm': 'can'|'undecided', ... }
 *   }
 *
 * @param {string} userId - 検証済み LINE ユーザー ID
 * @returns {{ dates: Array<Object>, userAnswers: Object }}
 */
function handleLiffGetData(userId) {
  var allSchedules = getSchedules();
  var schedules = _filterUpcomingSchedules(allSchedules, SURVEY_SCHEDULE_DAYS);

  // 日付ごとにスケジュールをグループ化
  var dateMap = {};       // { 'YYYY-MM-DD': [schedule, ...] }
  var dateOrder = [];     // 日付の順序を保持

  for (var i = 0; i < schedules.length; i++) {
    var s = schedules[i];
    var dateStr = String(s.date);
    if (!dateMap[dateStr]) {
      dateMap[dateStr] = [];
      dateOrder.push(dateStr);
    }
    dateMap[dateStr].push(s);
  }

  dateOrder.sort();  // 日付昇順

  var SLOT_STARTS = ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'];
  var weekdays = ['日', '月', '火', '水', '木', '金', '土'];

  var dates = dateOrder.map(function (dateStr) {
    var daySchedules = dateMap[dateStr];
    var d = new Date(dateStr + 'T00:00:00+09:00');
    var m = d.getMonth() + 1;
    var day = d.getDate();
    var w = weekdays[d.getDay()];
    var dateLabel = m + '/' + day + '(' + w + ')';

    // 施設情報1行: "📍東総合 13〜21 / 鳥屋野 終日"
    var facilityInfo = _buildFacilityInfo(daySchedules);

    // 6スロットの available 判定
    var slots = SLOT_STARTS.map(function (slotStart) {
      return {
        slotStart: slotStart,
        available: _isSlotAvailable(slotStart, daySchedules)
      };
    });

    return {
      date: dateStr,
      dateLabel: dateLabel,
      facilityInfo: facilityInfo,
      slots: slots
    };
  });

  // このユーザーの前回答を取得
  var userAnswers = getSlotResponsesByUserId(userId);

  return { dates: dates, userAnswers: userAnswers };
}

/**
 * スロットが利用可能かどうか判定する(内部用・F-4-5 グレーアウト判定ロジック)
 *
 * 判定ルール:
 *   - スロットの2時間区間(例: 13:00〜15:00)が、その日のいずれかの施設開放時間に
 *     「完全に含まれる」場合 true
 *   - 施設の note に「終日」が含まれる場合は全スロット true
 *   - 施設が1つもない日は全スロット false
 *
 * @param {string} slotStart - "HH:mm" 形式 (例: '13:00')
 * @param {Array<Object>} daySchedules - その日のスケジュール一覧
 * @returns {boolean}
 * @private
 */
function _isSlotAvailable(slotStart, daySchedules) {
  if (!daySchedules || daySchedules.length === 0) return false;

  var SLOT_END_MAP = {
    '09:00': '11:00', '11:00': '13:00', '13:00': '15:00',
    '15:00': '17:00', '17:00': '19:00', '19:00': '21:00'
  };
  var slotEnd = SLOT_END_MAP[slotStart];
  if (!slotEnd) return false;

  for (var i = 0; i < daySchedules.length; i++) {
    var sch = daySchedules[i];
    var note = String(sch.note || '');
    var startTime = String(sch.startTime || '');
    var endTime   = String(sch.endTime   || '');

    // 「終日」は全スロット available
    if (note.indexOf('終日') !== -1 || startTime.indexOf('終日') !== -1 || endTime.indexOf('終日') !== -1) {
      return true;
    }

    // "HH:mm" → 時間の数値比較
    if (startTime && endTime) {
      // スロット全体がこの施設の開放時間に完全に含まれるか判定
      if (slotStart >= startTime && slotEnd <= endTime) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 施設情報の1行テキストを組み立てる(内部用)
 *
 * 形式: 📍{facilityName} {startTime}〜{endTime} / ...
 * 「終日」の施設は "終日" と表示。
 * 施設がない日は空文字を返す。
 *
 * @param {Array<Object>} daySchedules
 * @returns {string}
 * @private
 */
function _buildFacilityInfo(daySchedules) {
  if (!daySchedules || daySchedules.length === 0) return '';

  var parts = [];
  for (var i = 0; i < daySchedules.length; i++) {
    var sch = daySchedules[i];
    var name = String(sch.facilityName || '');
    var note = String(sch.note || '');
    var startTime = String(sch.startTime || '');
    var endTime   = String(sch.endTime   || '');

    var timeStr;
    if (note.indexOf('終日') !== -1 || startTime.indexOf('終日') !== -1 || endTime.indexOf('終日') !== -1) {
      timeStr = '終日';
    } else if (startTime && endTime) {
      // "HH:mm" → "H〜H" 形式(先頭ゼロを除去して時間部分のみ)
      var startH = startTime.split(':')[0].replace(/^0/, '');
      var endH   = endTime.split(':')[0].replace(/^0/, '');
      timeStr = startH + '〜' + endH;
    } else {
      timeStr = '';
    }

    parts.push(name + (timeStr ? ' ' + timeStr : ''));
  }

  return parts.join('\n');
}

/**
 * F-4 LIFF フォームの回答を一括送信する(高速版)
 *
 * Code.js の `_handleLiffApi` から `liff=submit` で呼ばれる。
 *
 * 処理フロー:
 *   1. この userId の既存スロット回答をすべて削除
 *   2. answers の各エントリを一括 setValues で挿入(高速化)
 *
 * answers の形:
 *   { 'YYYY-MM-DD|HH:mm': 'can', 'YYYY-MM-DD|HH:mm': 'undecided' }
 *   キーを '|' で分割して date と slotStart を取り出す
 *
 * @param {string} userId  - 検証済み LINE ユーザー ID
 * @param {Object} answers - { 'YYYY-MM-DD|HH:mm': 'can'|'undecided' }
 * @returns {{ deleted: number, inserted: number }}
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

    // (1) この userId の既存スロット回答行を一括削除
    if (lastRow >= 2) {
      var colB = sheet.getRange(2, SRCOL_USER_ID, lastRow - 1, 1).getValues();
      var toDelete = [];
      for (var i = 0; i < colB.length; i++) {
        if (String(colB[i][0]) === userId) toDelete.push(i + 2);
      }
      toDelete.sort(function (a, b) { return b - a; });
      for (var d = 0; d < toDelete.length; d++) sheet.deleteRow(toDelete[d]);
      deleted = toDelete.length;
    }

    // (2) 新しい回答を一括挿入
    var nowIso = _toIsoTokyo(new Date());
    var keys = Object.keys(answers);
    var newRows = [];

    for (var k = 0; k < keys.length; k++) {
      var slotKey = keys[k];
      var val = answers[slotKey];
      if (val !== 'can' && val !== 'undecided') {
        console.warn('[WARN] handleLiffSubmitFast: unknown answer="' + val + '" key=' + slotKey + '. Skipping.');
        continue;
      }

      // キーを '|' で分割して date と slotStart を取り出す
      var pipeIdx = slotKey.indexOf('|');
      if (pipeIdx < 0) {
        console.warn('[WARN] handleLiffSubmitFast: invalid key format="' + slotKey + '". Skipping.');
        continue;
      }
      var date      = slotKey.substring(0, pipeIdx);
      var slotStart = slotKey.substring(pipeIdx + 1);

      newRows.push([_generateResponseId(), userId, date, slotStart, val, nowIso, nowIso]);
    }

    if (newRows.length > 0) {
      var startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, newRows.length, SLOT_RESPONSES_HEADER.length).setValues(newRows);
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
 * F-4 LIFF 回答状況確認ページ用データを取得する
 *
 * Code.js の `_handleLiffApi` から `liff=getAllResponses` で呼ばれる。
 * 全スロットに対する全メンバーの回答状況を返す。
 *
 * 返却データの形:
 *   {
 *     dates: [ { date, dateLabel, facilityInfo, slots: [...] } ],  // handleLiffGetData と同じ構造
 *     responses: {
 *       'YYYY-MM-DD|HH:mm': { can: ['田中', '佐藤'], undecided: ['山田'] },
 *       ...
 *     }
 *   }
 *
 * @returns {{ dates: Array<Object>, responses: Object }}
 */
function handleLiffGetAllResponses() {
  // 日付ごとのグリッド情報(handleLiffGetData と同じ構造・userId は不要なので空文字)
  var gridData = handleLiffGetData('');

  // userId → displayName のマップを members シートから作る
  var members = getActiveMembers();
  var userNameMap = {};
  for (var i = 0; i < members.length; i++) {
    userNameMap[members[i].userId] = members[i].displayName || '(名前不明)';
  }

  // 全スロット回答を取得して 'YYYY-MM-DD|HH:mm' キーごとに集計
  var allResponses = getAllSlotResponses();
  var responseMap = {};

  for (var k = 0; k < allResponses.length; k++) {
    var resp = allResponses[k];
    var slotKey = resp.date + '|' + resp.slotStart;
    if (!responseMap[slotKey]) {
      responseMap[slotKey] = { can: [], undecided: [] };
    }
    var name = userNameMap[resp.userId] || '(不明)';
    if (resp.answer === 'can') {
      responseMap[slotKey].can.push(name);
    } else if (resp.answer === 'undecided') {
      responseMap[slotKey].undecided.push(name);
    }
  }

  return {
    dates: gridData.dates,
    responses: responseMap
  };
}

/**
 * 後方互換: 旧 handleLiffSubmit を呼ぶ箇所のために残す
 *
 * @deprecated F-4 以降は handleLiffSubmitFast を使う
 *
 * @param {string} userId
 * @param {Object} answers - { 'YYYY-MM-DD|HH:mm': 'can'|'undecided' } または旧形式
 * @returns {{ deleted: number, inserted: number }}
 */
function handleLiffSubmit(userId, answers) {
  return handleLiffSubmitFast(userId, answers);
}

// ─────────────────────────────────────────────
// F-5: 4人以上即通知
// ─────────────────────────────────────────────

/**
 * LIFF 回答送信後に「4人以上即通知」チェックを実行する(F-5 / Code.js から呼ばれる)
 *
 * 処理フロー:
 *   1. getAllSlotResponses() で全回答を取得
 *   2. スロットごとに can 票数を集計
 *   3. MIN_ATTENDEES(4) 以上のスロットを抽出
 *   4. 各スロットについて ScriptProperties の VIABLE_NOTIFIED_SLOT_<date>|<slotStart> を確認
 *   5. まだ通知していないスロットがあればグループに 1 通まとめて通知
 *   6. 通知したスロットに VIABLE_NOTIFIED_SLOT_* = 'true' を保存
 *
 * 設計上の注意:
 *   - グループ ID が未設定の場合はログのみ・処理をスキップ(エラーにしない)
 *   - 複数スロットが同時に条件を満たした場合は 1 通にまとめて送る
 *   - このチェックは「can 票数のみ」で判定する(undecided は含めない)
 *   - 例外が発生しても呼び出し元の回答送信処理には影響しないよう try-catch で囲む
 *
 * @private
 */
function _checkAndNotifyViableSlots() {
  try {
    var groupId = getProperty('LINE_GROUP_ID');
    if (!groupId) {
      console.log('[INFO] _checkAndNotifyViableSlots: LINE_GROUP_ID が未設定のためスキップします');
      return;
    }

    // (1) 全回答を取得して can 票数をスロットごとに集計
    var responses = getAllSlotResponses();
    var canCounts = {};  // key: 'YYYY-MM-DD|HH:mm' → can 票数

    for (var i = 0; i < responses.length; i++) {
      var r = responses[i];
      if (r.answer === 'can') {
        var key = r.date + '|' + r.slotStart;
        canCounts[key] = (canCounts[key] || 0) + 1;
      }
    }

    // (2) MIN_ATTENDEES 以上かつ未通知のスロットを抽出
    var newlyViableSlots = [];
    var slotKeys = Object.keys(canCounts);
    var propKeyPrefix = 'VIABLE_NOTIFIED_SLOT_';

    for (var j = 0; j < slotKeys.length; j++) {
      var slotKey = slotKeys[j];
      if (canCounts[slotKey] >= MIN_ATTENDEES) {
        var notifiedKey = propKeyPrefix + slotKey;
        var alreadyNotified = getProperty(notifiedKey);
        if (alreadyNotified !== 'true') {
          newlyViableSlots.push(slotKey);
        }
      }
    }

    if (newlyViableSlots.length === 0) {
      return;  // 新たに条件を満たしたスロットなし
    }

    newlyViableSlots.sort();  // 日付・時刻順

    // (3) 通知メッセージを組み立てる
    var SLOT_ENDS = {
      '09:00': '11:00', '11:00': '13:00', '13:00': '15:00',
      '15:00': '17:00', '17:00': '19:00', '19:00': '21:00'
    };
    var weekdays = ['日', '月', '火', '水', '木', '金', '土'];

    var lines = ['4人以上参加できる時間帯が見つかりました！🏸', ''];
    for (var n = 0; n < newlyViableSlots.length; n++) {
      var parts = newlyViableSlots[n].split('|');
      var date = parts[0];
      var slotStart = parts[1];
      var slotEnd = SLOT_ENDS[slotStart] || '?';
      var canCount = canCounts[newlyViableSlots[n]] || 0;

      var d = new Date(date + 'T00:00:00+09:00');
      var m = d.getMonth() + 1;
      var day = d.getDate();
      var w = weekdays[d.getDay()];

      lines.push('・' + m + '/' + day + '(' + w + ') ' + slotStart + '〜' + slotEnd +
                 '（○' + canCount + '人）');
    }
    var message = lines.join('\n');

    // (4) グループに通知
    pushText(groupId, message);
    console.log('[INFO] _checkAndNotifyViableSlots: ' + newlyViableSlots.length +
                ' スロットをグループに通知しました');

    // (5) 通知済みフラグを保存
    for (var f = 0; f < newlyViableSlots.length; f++) {
      PropertiesService.getScriptProperties()
        .setProperty(propKeyPrefix + newlyViableSlots[f], 'true');
    }

  } catch (err) {
    logError(err, { phase: '_checkAndNotifyViableSlots' });
    // 呼び出し元(回答送信)の処理を止めないため、例外は再 throw しない
  }
}
