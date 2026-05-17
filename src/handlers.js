/**
 * @fileoverview F-1-1〜F-6 — イベントハンドラー
 *
 * follow / unfollow / join / memberJoined / message / postback イベントを受け取って、
 * 実際の業務処理(スプレッドシート更新 + メッセージ送信)を行うファイルです。
 *
 * 各関数の役割を 1 行で:
 *   - handleFollow(event)                        : 新メンバー登録 + 歓迎メッセージ(1対1用・後方互換)
 *   - handleUnfollow(event)                      : メンバーを inactive に変更(削除はしない)
 *   - handleJoin(event)                          : グループ参加時にグループ ID を保存する(F-5)
 *   - handleMemberJoined(event)                  : グループへの新メンバー参加時に自動登録する(F-5)
 *   - handleDistributeSurvey()                   : グループトークに 2 ボタン Flex Message を Push 配信(F-1-3 / F-3-6 / F-5)
 *   - handleSendReminders()                      : 未回答メンバーに個別 Push を再送(F-1-5 / F-3-6)
 *   - handleLiffGetData(userId)                  : F-4 グリッドフォーム用データ取得(日付×スロット構造)
 *   - handleLiffSubmitFast(userId, answers)      : F-4 回答一括送信(新データモデル)
 *   - handleLiffGetAllResponses()                : F-4 LIFF 回答状況確認ページ用データ取得
 *   - _checkAndNotifyViableSlots()               : 4人以上即通知チェック(F-5 / F-6: ボタン付きFlexメッセージ)
 *   - handlePostback(event)                      : postback イベント処理 — 予約フロー全体を管理(F-6)
 *   - _doImmediateReserve(...)                   : 7日以内スロットの即時予約フロー(scan→選択Flex表示)(F-6)
 *   - _enqueueReservation(...)                   : 8日以上先スロットをキューに登録(F-6)
 *   - _doSelectCourtReserve(...)                 : コート確定後に Lambda 予約を実行(F-6)
 *   - _doSelectFacilityReserve(...)              : 施設選択後に再 scan してコート選択Flexを表示(F-6)
 *   - _callReserveLambda(slotKey, facilityId, courseTimeId) : AWS Lambda 経由で予約フォームを送信(F-6)
 *   - _callScanLambda(date, startTime, courseGroupIds)      : AWS Lambda 経由で空きコートを取得(F-6)
 *   - _buildReserveBubble(slotKey, canCount, facilityId)    : 「予約する」ボタン付き Flex Bubble(F-6)
 *   - _buildCourtSelectionFlex(...)              : コート選択用 Flex Bubble(F-6)
 *   - _buildFacilitySelectionFlex(...)           : 施設選択用 Flex Bubble(F-6)
 *   - _buildReserveConfirmFlex(...)              : 予約確認用 Flex Bubble(F-6)
 */

// ─────────────────────────────────────────────
// モジュールレベル定数(各関数で重複定義していたものを一元管理)
// ─────────────────────────────────────────────

/**
 * スロット開始時刻 → 終了時刻 のマッピング
 * 全ファイルで共通して使う 2 時間枠の定義。
 * @type {Object}
 */
var _SLOT_ENDS = {
  '09:00': '11:00', '11:00': '13:00', '13:00': '15:00',
  '15:00': '17:00', '17:00': '19:00', '19:00': '21:00'
};

/**
 * 施設 ID → 施設名 のマッピング
 * @type {Object}
 */
var _FACILITY_NAMES = {
  '420': '鳥屋野総合体育館',
  '413': '東総合スポーツセンター'
};

/**
 * 曜日ラベル配列(インデックス 0 = 日曜)
 * @type {string[]}
 */
var _WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

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
      var slotEnd = _SLOT_ENDS[slotStart] || '?';
      var canCount = canCounts[viableSlots[i]] || 0;
      var undecidedCount = undecidedCounts[viableSlots[i]] || 0;
      var total = canCount + undecidedCount;

      var d = new Date(date + 'T00:00:00+09:00');
      var m = d.getMonth() + 1;
      var day = d.getDate();
      var w = _WEEKDAYS[d.getDay()];

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
 * 体育館名を除いた日時部分のラベルを返す(内部用)
 *
 * 生成例: "5/15(金) 18:00〜20:00"
 *
 * @param {{date: string, startTime: string, endTime: string}} schedule
 * @returns {string}
 * @private
 */
function _formatDateTimeLabel(schedule) {
  var date = new Date(schedule.date + 'T00:00:00+09:00');
  var m = date.getMonth() + 1;
  var d = date.getDate();
  var w = _WEEKDAYS[date.getDay()];
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
      handleDistributeSurvey();

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

  var dates = dateOrder.map(function (dateStr) {
    var daySchedules = dateMap[dateStr];
    var d = new Date(dateStr + 'T00:00:00+09:00');
    var m = d.getMonth() + 1;
    var day = d.getDate();
    var w = _WEEKDAYS[d.getDay()];
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

  var slotEnd = _SLOT_ENDS[slotStart];
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

// ─────────────────────────────────────────────
// F-5: 4人以上即通知 / F-6: 予約ボタン付き Flex メッセージ
// ─────────────────────────────────────────────

/**
 * LIFF 回答送信後に「4人以上即通知」チェックを実行する(F-5 / F-6 対応版)
 *
 * F-6 変更点:
 *   テキスト通知から「予約する」ボタン付き Flex メッセージに変更。
 *   スロットが1件なら bubble 1枚、複数なら carousel(最大 10件)で送信する。
 *
 * 処理フロー:
 *   1. getAllSlotResponses() で全回答を取得
 *   2. スロットごとに can 票数を集計
 *   3. MIN_ATTENDEES(4) 以上のスロットを抽出
 *   4. 各スロットについて ScriptProperties の VIABLE_NOTIFIED_SLOT_<date>|<slotStart> を確認
 *   5. まだ通知していないスロットがあればグループに Flex メッセージで通知
 *   6. 通知したスロットに VIABLE_NOTIFIED_SLOT_* = 'true' を保存
 *
 * 設計上の注意:
 *   - グループ ID が未設定の場合はログのみ・処理をスキップ(エラーにしない)
 *   - 複数スロットが同時に条件を満たした場合は carousel にまとめて 1 通送る
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

    // (3) スロットごとに「予約する」ボタン付き Flex Bubble を作り、carousel にまとめる
    var facilityId = getProperty('DEFAULT_FACILITY_ID') || '420';
    var bubbles = [];
    for (var n = 0; n < newlyViableSlots.length; n++) {
      bubbles.push(_buildReserveBubble(newlyViableSlots[n], canCounts[newlyViableSlots[n]], facilityId));
    }

    // LINE Carousel の上限（10件）に制限
    if (bubbles.length > 10) {
      bubbles = bubbles.slice(0, 10);
    }

    var flexContents;
    var altText = '4人以上参加できる時間帯が見つかりました！予約しますか？';
    if (bubbles.length === 1) {
      flexContents = bubbles[0];
    } else {
      flexContents = {
        type: 'carousel',
        contents: bubbles
      };
    }

    // (4) グループに通知
    withRetry(function () {
      return pushFlexMessage(groupId, altText, flexContents);
    }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'pushViableSlotsFlex' });

    console.log('[INFO] _checkAndNotifyViableSlots: ' + newlyViableSlots.length +
                ' スロットをグループに Flex メッセージで通知しました');

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

/**
 * 「予約する」ボタン付きの Flex Bubble を組み立てる(内部用・F-6)
 *
 * 生成する Bubble の構成:
 *   header: 「4人以上確定！」(緑背景)
 *   body  : 日時・参加人数
 *   footer: 「予約する」ボタン(postback アクション)
 *
 * postback data 形式: action=reserve&slotKey=YYYY-MM-DD|HH:mm&facilityId=420
 *
 * @param {string} slotKey    - 'YYYY-MM-DD|HH:mm' 形式
 * @param {number} canCount   - can 票数
 * @param {string} facilityId - 施設 ID 文字列(例: '420')
 * @returns {Object} LINE Flex Message の bubble オブジェクト
 * @private
 */
function _buildReserveBubble(slotKey, canCount, facilityId) {
  var parts = slotKey.split('|');
  var date = parts[0];
  var slotStart = parts[1];
  var slotEnd = _SLOT_ENDS[slotStart] || '?';
  var facilityName = _FACILITY_NAMES[String(facilityId)] || ('施設ID:' + facilityId);

  var d = new Date(date + 'T00:00:00+09:00');
  var m = d.getMonth() + 1;
  var day = d.getDate();
  var w = _WEEKDAYS[d.getDay()];
  var dateLabel = m + '月' + day + '日(' + w + ')';

  var postbackData = 'action=reserve&slotKey=' +
    encodeURIComponent(slotKey) + '&facilityId=' + encodeURIComponent(facilityId);

  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#06C755',
      contents: [{
        type: 'text',
        text: '4人以上確定！🏸',
        weight: 'bold',
        size: 'lg',
        color: '#FFFFFF'
      }]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: dateLabel,
          weight: 'bold',
          size: 'xl'
        },
        {
          type: 'text',
          text: slotStart + '〜' + slotEnd,
          size: 'lg',
          color: '#333333'
        },
        {
          type: 'text',
          text: facilityName,
          size: 'sm',
          color: '#888888',
          wrap: true
        },
        {
          type: 'text',
          text: '参加確定: ' + canCount + '人',
          size: 'sm',
          color: '#06C755'
        }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        style: 'primary',
        color: '#06C755',
        action: {
          type: 'postback',
          label: '予約する',
          data: postbackData,
          displayText: '予約します'
        }
      }]
    }
  };
}

// ─────────────────────────────────────────────
// F-6: postback ハンドラー / AWS Lambda 呼び出し
// ─────────────────────────────────────────────

/**
 * postback イベント処理 — F-6 予約フロー全体を管理する
 *
 * 処理フロー:
 *   1. postback データを parse して action / slotKey / facilityId を取り出す
 *   2. RESERVE_ENABLED フラグが 'true' でなければ機能全体を無効にする
 *   3. action に応じて各サブフローへ分岐する:
 *      - reserve       : 「予約する」ボタン初回タップ → scan → 施設/コート選択Flex 表示
 *      - selectFacility: 施設選択 → 再 scan → コート選択Flex 表示
 *      - selectCourt   : コート選択 → 予約確認Flex 表示
 *      - confirmReserve: 予約確認後 → _callReserveLambda() で実際に予約実行
 *   4. 利用日が今日から 7 日以内 → _doImmediateReserve() で即時予約フロー
 *   5. 利用日が 8 日以上先 → _enqueueReservation() でキューに登録
 *
 * グループ ID の取得方法:
 *   event.source.groupId を優先し、なければ ScriptProperties の LINE_GROUP_ID を使う。
 *
 * @param {Object} event - LINE postback イベント
 * @returns {void}
 */
function handlePostback(event) {
  // RESERVE_ENABLED フラグが 'true' でなければ機能全体を無効にする(TBD-18 実機検証完了まで)
  if (getProperty('RESERVE_ENABLED') !== 'true') {
    var guardGroupId = (event && event.source && event.source.groupId)
      ? event.source.groupId
      : getProperty('LINE_GROUP_ID');
    if (guardGroupId) {
      try {
        pushText(guardGroupId, '⚠️ 自動予約機能は現在準備中です。手動でご予約ください。');
      } catch (_) {}
    }
    console.log('[INFO] handlePostback: RESERVE_ENABLED が true でないためスキップします');
    return;
  }

  var data = (event && event.postback && event.postback.data) ? event.postback.data : '';
  if (!data) {
    console.warn('[WARN] handlePostback: postback.data が空です');
    return;
  }

  var params = _parsePostbackData(data);

  // action=reserve / selectCourt / selectFacility / confirmReserve 以外は無視
  var validActions = { reserve: true, selectCourt: true, selectFacility: true, confirmReserve: true };
  if (!validActions[params.action]) {
    console.log('[INFO] handlePostback: 未対応の action=' + params.action);
    return;
  }

  var slotKey    = params.slotKey    || '';
  var facilityId = params.facilityId || '420';

  if (!slotKey) {
    logError(new Error('handlePostback: slotKey が空です'), { phase: 'handlePostback.validate', data: data });
    return;
  }

  // グループ ID を取得(event.source.groupId > ScriptProperties の優先順)
  var groupId = (event && event.source && event.source.groupId)
    ? event.source.groupId
    : getProperty('LINE_GROUP_ID');

  if (!groupId) {
    logError(new Error('handlePostback: LINE_GROUP_ID が未設定です'), { phase: 'handlePostback.groupId' });
    return;
  }

  // (3) 二重予約防止チェック（confirmReserve・selectCourt のみ対象）
  if (params.action === 'confirmReserve' || params.action === 'selectCourt') {
    var reservedFlagKey = 'RESERVED_SLOT_' + slotKey;
    var alreadyReserved = getProperty(reservedFlagKey);
    if (alreadyReserved === 'true') {
      try {
        pushText(groupId, 'このスロットはすでに予約済みです。\n別の日時をご確認ください。');
      } catch (pushErr) {
        logError(pushErr, { phase: 'handlePostback.alreadyReserved.push' });
      }
      console.log('[INFO] handlePostback: 二重予約防止 slotKey=' + slotKey);
      return;
    }
  }

  // action=confirmReserve: 確認Flex後の実際の予約実行
  if (params.action === 'confirmReserve') {
    var confirmCourseTimeId = parseInt(params.courseTimeId, 10);
    if (!confirmCourseTimeId) {
      logError(new Error('handlePostback: courseTimeId が空です'), { phase: 'handlePostback.confirmReserve', data: data });
      return;
    }
    _doSelectCourtReserve(groupId, slotKey, facilityId, confirmCourseTimeId);
    return;
  }

  // action=selectCourt: コート選択 → 予約確認Flexを表示
  if (params.action === 'selectCourt') {
    var selectedCourseTimeId = parseInt(params.courseTimeId, 10);
    if (!selectedCourseTimeId) {
      logError(new Error('handlePostback: courseTimeId が空です'), { phase: 'handlePostback.selectCourt', data: data });
      return;
    }
    var courtPatternName  = params.patternName  || '';
    var courtFacilityName = params.facilityName || '';
    // slotKey から日時ラベルを生成
    var scPipeIdx  = slotKey.indexOf('|');
    var scUseDate  = slotKey.substring(0, scPipeIdx);
    var scStart    = slotKey.substring(scPipeIdx + 1);
    var scBubble   = _buildReserveConfirmFlex(
      slotKey, facilityId, selectedCourseTimeId,
      courtPatternName, courtFacilityName, scUseDate, scStart
    );
    try {
      withRetry(function() {
        return pushFlexMessage(groupId, '予約内容を確認してください', scBubble);
      }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'pushConfirmFlex' });
    } catch (flexErr) {
      logError(flexErr, { phase: 'handlePostback.selectCourt.confirmFlex', slotKey: slotKey });
    }
    return;
  }

  // action=selectFacility: 施設選択 → その courseGroupId のコート選択Flexを表示
  if (params.action === 'selectFacility') {
    var sfCourseGroupId = parseInt(params.courseGroupId, 10);
    if (!sfCourseGroupId) {
      logError(new Error('handlePostback: courseGroupId が空です'), { phase: 'handlePostback.selectFacility', data: data });
      return;
    }
    _doSelectFacilityReserve(groupId, slotKey, facilityId, sfCourseGroupId);
    return;
  }

  // action=reserve: 「予約する」ボタン初回タップ → scan → 施設/コート選択Flex
  // 二重予約防止チェック（action=reserve でも確認する）
  var rfKey = 'RESERVED_SLOT_' + slotKey;
  if (getProperty(rfKey) === 'true') {
    try {
      pushText(groupId, 'このスロットはすでに予約済みです。\n別の日時をご確認ください。');
    } catch (pushErr) {
      logError(pushErr, { phase: 'handlePostback.reserve.alreadyReserved.push' });
    }
    return;
  }

  // slotKey から利用日(date)を取り出す
  var pipeIdx = slotKey.indexOf('|');
  if (pipeIdx < 0) {
    logError(new Error('handlePostback: slotKey の形式が不正です: ' + slotKey), { phase: 'handlePostback.slotKeyParse' });
    return;
  }
  var useDate = slotKey.substring(0, pipeIdx);
  var slotStart = slotKey.substring(pipeIdx + 1);

  // 今日から何日後か計算
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var todayDate  = new Date(todayStr + 'T00:00:00+09:00');
  var targetDate = new Date(useDate  + 'T00:00:00+09:00');
  var diffDays = Math.round((targetDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));

  var facilityName = _FACILITY_NAMES[String(facilityId)] || ('施設ID:' + facilityId);

  if (diffDays <= 7) {
    // (4) 7日以内 → 即時予約フロー（scan → 施設/コート選択Flex）
    _doImmediateReserve(groupId, slotKey, facilityId, facilityName, useDate, slotStart);
  } else {
    // (5) 8日以上先 → キューに登録して予約待ち通知
    _enqueueReservation(groupId, slotKey, facilityId, facilityName, useDate, slotStart);
  }
}

/**
 * 即時予約処理(内部用・F-6)
 *
 * Lambda(scan)を呼んで空きコートを調べ、施設/コート選択 Flex を表示する。
 * 施設が1種類なら直接コート選択Flex、2種類以上なら施設選択Flexを表示する。
 *
 * @param {string} groupId
 * @param {string} slotKey
 * @param {string} facilityId
 * @param {string} facilityName
 * @param {string} useDate     - 'YYYY-MM-DD'
 * @param {string} slotStart   - 'HH:mm'
 * @private
 */
function _doImmediateReserve(groupId, slotKey, facilityId, facilityName, useDate, slotStart) {
  var slotEnd = _SLOT_ENDS[slotStart] || '?';
  var d = new Date(useDate + 'T00:00:00+09:00');
  var m = d.getMonth() + 1;
  var day = d.getDate();
  var w = _WEEKDAYS[d.getDay()];
  var dateLabel = m + '月' + day + '日(' + w + ')';

  // scan で空きコートを調べる
  // courseGroupIds は ScriptProperties から取得（週ごとに更新が必要）
  // 例: TOYA_COURSE_GROUP_IDS = "14879,14881,14882,14883,14884,14885,14886"
  //     HIGASHI_COURSE_GROUP_IDS = "14791"
  var idPropKey = String(facilityId) === '420' ? 'TOYA_COURSE_GROUP_IDS' : 'HIGASHI_COURSE_GROUP_IDS';
  var idPropVal = getProperty(idPropKey) || '';
  var courseGroupIds = idPropVal
    ? idPropVal.split(',').map(function (s) { return parseInt(s.trim(), 10); }).filter(function (n) { return !isNaN(n); })
    : [];

  var scanResult;
  try {
    scanResult = _callScanLambda(useDate, slotStart, courseGroupIds);
  } catch (scanErr) {
    logError(scanErr, { phase: '_doImmediateReserve.scan', slotKey: slotKey });
    try {
      pushText(groupId,
        '❌ 空きコートの検索中にエラーが発生しました。\n' +
        dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
        '手動で予約をお試しください。'
      );
    } catch (_) {}
    return;
  }

  if (!scanResult || !scanResult.success || !scanResult.courts || scanResult.courts.length === 0) {
    try {
      pushText(groupId,
        '😢 空きコートが見つかりませんでした。\n' +
        dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
        facilityName + '\n\n' +
        '手動でご確認ください。'
      );
    } catch (_) {}
    return;
  }

  var courts = scanResult.courts;

  // facilityName でグループ化する
  // groups = { '鳥屋野総合体育館': [ { court... }, ... ], '東総合スポーツセンター': [...] }
  var groups = {};
  var groupOrder = []; // 施設名の登場順を保持する
  for (var gi = 0; gi < courts.length; gi++) {
    var c = courts[gi];
    var gKey = c.facilityName || facilityName; // Lambda が facilityName を返さない場合の fallback
    if (!groups[gKey]) {
      groups[gKey] = [];
      groupOrder.push(gKey);
    }
    groups[gKey].push(c);
  }

  var facilityCount = groupOrder.length;

  if (facilityCount <= 1) {
    // 施設が1種類（または facilityName 未設定で混在） → コート選択Flexを表示
    var singleFacilityName = groupOrder[0] || facilityName;
    var singleCourts = groups[singleFacilityName] || courts;
    // patternName は全コートで同じはずなのでの最初の値を使う
    var singlePatternName = (singleCourts[0] && singleCourts[0].patternName) || '';
    try {
      var selFlex = _buildCourtSelectionFlex(
        slotKey, facilityId, singleFacilityName, singlePatternName,
        dateLabel, slotStart, slotEnd, singleCourts
      );
      withRetry(function() {
        return pushFlexMessage(groupId,
          'コートを選んでください（' + singleCourts.length + '面空きあり）', selFlex);
      }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'pushCourtSelection' });
    } catch (flexErr) {
      logError(flexErr, { phase: '_doImmediateReserve.courtSelection', slotKey: slotKey });
    }
  } else {
    // 施設が2種類以上 → 施設選択Flexを表示
    try {
      var facFlex = _buildFacilitySelectionFlex(
        slotKey, facilityId, dateLabel, slotStart, slotEnd, groups, groupOrder
      );
      withRetry(function() {
        return pushFlexMessage(groupId,
          '施設を選んでください（' + facilityCount + '施設に空きあり）', facFlex);
      }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'pushFacilitySelection' });
    } catch (flexErr) {
      logError(flexErr, { phase: '_doImmediateReserve.facilitySelection', slotKey: slotKey });
    }
  }
}

/**
 * 予約待ちキューへの登録処理(内部用・F-6)
 *
 * reserve-queue シートにエントリを追加し、グループに「X月X日7:00に自動予約」を通知する。
 *
 * @param {string} groupId
 * @param {string} slotKey
 * @param {string} facilityId
 * @param {string} facilityName
 * @param {string} useDate     - 'YYYY-MM-DD'
 * @param {string} slotStart   - 'HH:mm'
 * @private
 */
function _enqueueReservation(groupId, slotKey, facilityId, facilityName, useDate, slotStart) {
  // 予約可能日 = 利用日の 7 日前
  var targetDate = new Date(useDate + 'T00:00:00+09:00');
  targetDate.setDate(targetDate.getDate() - 7);
  var reservableDate = Utilities.formatDate(targetDate, 'Asia/Tokyo', 'yyyy-MM-dd');

  var slotEnd = _SLOT_ENDS[slotStart] || '?';

  // 利用日のラベル
  var d = new Date(useDate + 'T00:00:00+09:00');
  var m = d.getMonth() + 1;
  var day = d.getDate();
  var w = _WEEKDAYS[d.getDay()];
  var dateLabel = m + '月' + day + '日(' + w + ')';

  // 予約可能日(X月X日)のラベル — 通知文で使う
  var rd = new Date(reservableDate + 'T00:00:00+09:00');
  var rm = rd.getMonth() + 1;
  var rday = rd.getDate();
  var rw = _WEEKDAYS[rd.getDay()];
  var reservableDateLabel = rm + '月' + rday + '日(' + rw + ')';

  try {
    addReserveQueue({
      slotKey:       slotKey,
      facilityId:    facilityId,
      facilityName:  facilityName,
      reservableDate: reservableDate,
      status:        'pending'
    });

    pushText(groupId,
      '🕐 予約待ちに登録しました。\n' +
      dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
      facilityName + '\n\n' +
      reservableDateLabel + ' 7:00 に自動予約します。'
    );
    console.log('[INFO] _enqueueReservation: キュー登録完了 slotKey=' + slotKey +
                ' reservableDate=' + reservableDate);
  } catch (err) {
    logError(err, { phase: '_enqueueReservation', slotKey: slotKey });
    try {
      pushText(groupId, '❌ 予約待ち登録中にエラーが発生しました。手動でご確認ください。');
    } catch (_) {}
  }
}

/**
 * AWS Lambda 経由でバド卓ねっとの予約フォームを送信する(内部用・F-6)
 *
 * 【楽観的ロック方式の冪等性保証】
 *   1. Lambda 呼び出し「前」に RESERVED_SLOT_{slotKey} を 'true' にセットする
 *      (先にフラグを立てることで、GAS が二重に Lambda を呼ばないようにする)
 *   2. Lambda が成功 → フラグは 'true' のまま維持する
 *   3. Lambda が失敗(例外 or success=false) → フラグを 'false' に戻す
 *      (次回の processReserveQueue や再実行で再試行できるように解放する)
 *
 * ※ 注意: フラグのセットと Lambda 呼び出しの間に GAS プロセスがクラッシュした場合は
 *   フラグが 'true' のままになる可能性がある(過剰ロック)。
 *   その場合は ScriptProperties の RESERVED_SLOT_{slotKey} を手動で 'false' に戻すこと。
 *
 * ※ Code.js の processReserveQueue から呼ぶ場合は、事前に _callScanLambda で
 *   courseTimeId を取得してから渡すこと（キューフロー用の scan は Code.js 側の責務）。
 *
 * Lambda へのリクエスト(JSON):
 *   { courseTimeId, name, tel, email }
 *
 * Lambda からのレスポンス(JSON):
 *   { success: true/false, message: "...", uncertain?: true }
 *
 * ScriptProperties から取得するキー:
 *   AWS_RESERVE_URL   : API Gateway URL
 *   RESERVE_API_TOKEN : Lambda との合言葉トークン（X-Api-Token ヘッダーに付与）
 *   RESERVE_NAME      : 予約代表者の氏名
 *   RESERVE_TEL       : 予約代表者の電話番号（RESERVE_PHONE でも可）
 *   RESERVE_EMAIL     : 予約代表者のメールアドレス
 *
 * @param {string} slotKey      - 'YYYY-MM-DD|HH:mm' 形式（二重予約防止フラグのキーに使用）
 * @param {string} facilityId   - 施設 ID（ログ用）
 * @param {number} courseTimeId - 予約する時間枠 ID（_callScanLambda で取得した値）
 * @returns {{ success: boolean, message: string }}
 * @throws {Error} AWS_RESERVE_URL 未設定 / courseTimeId 未指定 / HTTP エラー / JSON パースエラー
 */
function _callReserveLambda(slotKey, facilityId, courseTimeId) {
  var awsUrl       = getProperty('AWS_RESERVE_URL');
  var reserveName  = getProperty('RESERVE_NAME');
  var reserveTel   = getProperty('RESERVE_TEL') || getProperty('RESERVE_PHONE');
  var reserveEmail = getProperty('RESERVE_EMAIL');

  if (!awsUrl) {
    throw new Error('_callReserveLambda: AWS_RESERVE_URL が ScriptProperties に設定されていません');
  }
  if (!courseTimeId) {
    throw new Error('_callReserveLambda: courseTimeId が指定されていません');
  }
  if (!reserveName || !reserveTel || !reserveEmail) {
    throw new Error('_callReserveLambda: RESERVE_NAME / RESERVE_TEL（または RESERVE_PHONE）/ RESERVE_EMAIL のいずれかが未設定です');
  }

  // ── 楽観的ロック: Lambda 呼び出し前にフラグを 'true' にセット ──
  // バド卓ねっとはログイン不要のため「マイページの予約一覧」で確認できない。
  // GAS 側のフラグを使って二重呼び出しを防ぐ。
  var reservedFlagKey = 'RESERVED_SLOT_' + slotKey;
  PropertiesService.getScriptProperties().setProperty(reservedFlagKey, 'true');
  console.log('[INFO] _callReserveLambda: 楽観的ロック設定。key=' + reservedFlagKey +
              ' courseTimeId=' + courseTimeId);

  var requestBody = JSON.stringify({
    courseTimeId: courseTimeId,
    name:         reserveName,
    tel:          reserveTel,
    email:        reserveEmail
  });

  // X-Api-Token ヘッダーを付与して不正呼び出しを防ぐ(RESERVE_API_TOKEN を ScriptProperties に登録すること)
  var apiToken = getProperty('RESERVE_API_TOKEN');

  var response;
  try {
    response = UrlFetchApp.fetch(awsUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'X-Api-Token': apiToken || ''
      },
      payload: requestBody,
      muteHttpExceptions: true
    });
  } catch (fetchErr) {
    // 通信自体が失敗 → フラグを解放して再試行を可能にする
    PropertiesService.getScriptProperties().setProperty(reservedFlagKey, 'false');
    console.warn('[WARN] _callReserveLambda: 通信エラー。楽観的ロック解放。key=' + reservedFlagKey +
                 ' error=' + fetchErr.message);
    throw new Error('_callReserveLambda: Lambda への通信に失敗しました: ' + fetchErr.message);
  }

  var statusCode = response.getResponseCode();
  var responseText = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    // HTTP エラー → フラグを解放して再試行を可能にする
    PropertiesService.getScriptProperties().setProperty(reservedFlagKey, 'false');
    console.warn('[WARN] _callReserveLambda: Lambda HTTP エラー。楽観的ロック解放。key=' + reservedFlagKey +
                 ' status=' + statusCode);
    throw new Error('_callReserveLambda: Lambda HTTP エラー status=' + statusCode + ' body=' + responseText);
  }

  var result;
  try {
    result = JSON.parse(responseText);
  } catch (parseErr) {
    // JSON パースエラー → フラグを解放して再試行を可能にする
    PropertiesService.getScriptProperties().setProperty(reservedFlagKey, 'false');
    console.warn('[WARN] _callReserveLambda: JSON パースエラー。楽観的ロック解放。key=' + reservedFlagKey);
    throw new Error('_callReserveLambda: Lambda レスポンスの JSON パースに失敗しました: ' + responseText);
  }

  if (!result.success) {
    if (result.uncertain) {
      // 判定不能(uncertain=true): 実際に予約できた可能性があるため、フラグは 'true' のまま維持する
      // 再送による二重予約を防ぐため、解放しない。手動でバド卓ねっとを確認してもらう。
      console.warn('[WARN] _callReserveLambda: Lambda が uncertain を返した。フラグは維持。key=' + reservedFlagKey +
                   ' message=' + result.message);
    } else {
      // 確実な失敗 → フラグを解放して再試行を可能にする
      PropertiesService.getScriptProperties().setProperty(reservedFlagKey, 'false');
      console.warn('[WARN] _callReserveLambda: Lambda が failure を返した。楽観的ロック解放。key=' + reservedFlagKey +
                   ' message=' + result.message);
    }
  }
  // success=true の場合はフラグは 'true' のまま維持する(呼び出し元で二重呼び出し防止に使う)

  return result;
}

/**
 * Lambda の scan アクションを呼んで空きコートの一覧を取得する(内部用・F-6)
 *
 * @param {string}   date          - 'YYYY-MM-DD' 形式の利用日
 * @param {string}   startTime     - 'HH:mm' 形式の開始時刻（例: '15:00'）
 * @param {number[]} courseGroupIds - スキャン対象のコースグループ ID 配列
 * @returns {{ success: boolean, courts: Array<{courtName: string, courseTimeId: number, courseGroupId: number, facilityName: string, patternName: string}> }}
 * @throws {Error} AWS_RESERVE_URL 未設定 / HTTP エラー / JSON パースエラー
 */
function _callScanLambda(date, startTime, courseGroupIds) {
  var awsUrl   = getProperty('AWS_RESERVE_URL');
  var apiToken = getProperty('RESERVE_API_TOKEN');
  if (!awsUrl) {
    throw new Error('_callScanLambda: AWS_RESERVE_URL が ScriptProperties に設定されていません');
  }

  var response = UrlFetchApp.fetch(awsUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Api-Token': apiToken || '' },
    payload: JSON.stringify({ action: 'scan', date: date, startTime: startTime, courseGroupIds: courseGroupIds }),
    muteHttpExceptions: true
  });

  var statusCode = response.getResponseCode();
  var responseText = response.getContentText();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('_callScanLambda: HTTP エラー status=' + statusCode + ' body=' + responseText);
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    throw new Error('_callScanLambda: JSON パースエラー: ' + responseText);
  }
}

/**
 * コート選択後の即時予約処理(内部用・F-6)
 *
 * handlePostback の action=confirmReserve から呼ばれる。
 * Lambda を呼んで予約し、結果をグループに通知する。
 *
 * @param {string} groupId
 * @param {string} slotKey      - 'YYYY-MM-DD|HH:mm' 形式
 * @param {string} facilityId
 * @param {number} courseTimeId - ユーザーが選択したコートの courseTimeId
 * @private
 */
function _doSelectCourtReserve(groupId, slotKey, facilityId, courseTimeId) {
  var pipeIdx = slotKey.indexOf('|');
  var useDate   = slotKey.substring(0, pipeIdx);
  var slotStart = slotKey.substring(pipeIdx + 1);
  var slotEnd      = _SLOT_ENDS[slotStart] || '?';
  var facilityName = _FACILITY_NAMES[String(facilityId)] || ('施設ID:' + facilityId);

  var d   = new Date(useDate + 'T00:00:00+09:00');
  var m   = d.getMonth() + 1;
  var day = d.getDate();
  var w   = _WEEKDAYS[d.getDay()];
  var dateLabel = m + '月' + day + '日(' + w + ')';

  try {
    var lambdaResult = _callReserveLambda(slotKey, facilityId, courseTimeId);
    if (lambdaResult && lambdaResult.success) {
      pushText(groupId,
        '✅ 予約が完了しました！\n' +
        dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
        facilityName
      );
      console.log('[INFO] _doSelectCourtReserve: 予約成功 slotKey=' + slotKey + ' courseTimeId=' + courseTimeId);
    } else {
      var errMsg = (lambdaResult && lambdaResult.message) ? lambdaResult.message : '不明なエラー';
      pushText(groupId,
        '❌ 予約に失敗しました。\n' +
        dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
        '理由: ' + errMsg + '\n' +
        '手動で予約をお試しください。'
      );
    }
  } catch (err) {
    logError(err, { phase: '_doSelectCourtReserve', slotKey: slotKey });
    try {
      pushText(groupId,
        '❌ 予約処理中にエラーが発生しました。\n' +
        dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
        '手動で予約をお試しください。'
      );
    } catch (_) {}
  }
}

/**
 * パターン名 → 画像URL マッピング(内部定数・F-6)
 *
 * patternName が「大体育室 A」「大体育室　A」のような形式の場合は
 * 末尾のアルファベット（A/B/C）を抽出してキーにする。
 */
var PATTERN_IMAGE_MAP = {
  '鳥屋野総合体育館': {
    'A': 'https://niigata-kaikou.jp/storage/schedule/202604/69ce2999c79b6.jpg',
    'B': 'https://niigata-kaikou.jp/storage/schedule/202604/69ce299e94a72.jpg'
  },
  '東総合スポーツセンター': {
    'A': 'https://niigata-kaikou.jp/storage/schedule/202603/69c895f89f57c.jpg',
    'B': 'https://niigata-kaikou.jp/storage/schedule/202603/69c895fda7225.jpg',
    'C': 'https://niigata-kaikou.jp/storage/schedule/202603/69c8960389849.jpg'
  }
};

/**
 * patternName から画像URLを取得する(内部用)
 *
 * 「大体育室 A」「B」「A」「9-13時 B / 13-15時 C / 15-21時 A」(抽出後)
 * など末尾のアルファベット1文字をキーにする。
 *
 * @param {string} facilityName
 * @param {string} patternName  - 例: 'A' / '大体育室 A' / ''
 * @returns {string} 画像URL（取得できない場合は空文字列）
 */
function _getPatternImageUrl(facilityName, patternName) {
  if (!facilityName || !patternName) return '';
  var facilityMap = PATTERN_IMAGE_MAP[facilityName];
  if (!facilityMap) return '';

  // まず patternName をそのままキーとして試みる
  if (facilityMap[patternName]) return facilityMap[patternName];

  // 末尾のアルファベット（A/B/C）を抽出してキーにする
  var m = patternName.match(/([A-C])\s*$/i);
  if (m) {
    var key = m[1].toUpperCase();
    return facilityMap[key] || '';
  }
  return '';
}

/**
 * コート選択用の Flex Bubble を組み立てる(内部用・F-6)
 *
 * 空きコートの数だけ「コート名」ボタンを並べた Bubble を返す。
 * ボタンを押すと postback で action=selectCourt が飛ぶ（確認Flexを表示）。
 * patternName に対応する画像がある場合は hero セクションに表示する。
 *
 * @param {string}   slotKey
 * @param {string}   facilityId
 * @param {string}   facilityName
 * @param {string}   patternName  - パターン名（例: 'A' / '大体育室 A' / ''）
 * @param {string}   dateLabel    - 表示用日付文字列（例: '5月19日(月)'）
 * @param {string}   slotStart
 * @param {string}   slotEnd
 * @param {Array}    courts       - scan の返り値 courts 配列
 * @returns {Object} LINE Flex Message の bubble オブジェクト
 * @private
 */
function _buildCourtSelectionFlex(slotKey, facilityId, facilityName, patternName, dateLabel, slotStart, slotEnd, courts) {
  var imageUrl = _getPatternImageUrl(facilityName, patternName);

  var buttons = [];
  for (var i = 0; i < courts.length; i++) {
    var court = courts[i];
    var postbackData = 'action=selectCourt' +
      '&slotKey='       + encodeURIComponent(slotKey) +
      '&facilityId='    + encodeURIComponent(facilityId) +
      '&courseTimeId='  + encodeURIComponent(String(court.courseTimeId)) +
      '&patternName='   + encodeURIComponent(patternName || '') +
      '&facilityName='  + encodeURIComponent(facilityName || '');
    buttons.push({
      type: 'button',
      style: 'primary',
      color: '#06C755',
      height: 'sm',
      action: {
        type: 'postback',
        label: court.courtName,
        data: postbackData,
        displayText: court.courtName + 'を選択'
      }
    });
  }

  var headerPatternText = patternName
    ? ('コートを選んでください（' + patternName + '）')
    : 'コートを選んでください';

  var bubble = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#1E88E5',
      contents: [{ type: 'text', text: headerPatternText, weight: 'bold', size: 'lg', color: '#FFFFFF', wrap: true }]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: dateLabel,               weight: 'bold', size: 'xl' },
        { type: 'text', text: slotStart + '〜' + slotEnd, size: 'lg', color: '#333333' },
        { type: 'text', text: facilityName,            size: 'sm',    color: '#888888', wrap: true }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: buttons
    }
  };

  // 画像がある場合は hero セクションを追加する
  if (imageUrl) {
    bubble.hero = {
      type: 'image',
      url: imageUrl,
      size: 'full',
      aspectRatio: '20:13',
      aspectMode: 'cover'
    };
  }

  return bubble;
}

/**
 * 施設選択用の Flex Bubble を組み立てる(内部用・F-6)
 *
 * 施設ごとにボタンを並べた Bubble を返す。同じ施設で複数 courseGroupId がある場合は
 * courseGroupId ごとにボタンを出す。
 * ボタンを押すと postback で action=selectFacility が飛ぶ。
 *
 * @param {string}   slotKey
 * @param {string}   facilityId
 * @param {string}   dateLabel
 * @param {string}   slotStart
 * @param {string}   slotEnd
 * @param {Object}   groups      - { facilityName: [court, ...], ... }
 * @param {Array}    groupOrder  - 施設名の登場順配列
 * @returns {Object} LINE Flex Message の bubble オブジェクト
 * @private
 */
function _buildFacilitySelectionFlex(slotKey, facilityId, dateLabel, slotStart, slotEnd, groups, groupOrder) {
  var buttons = [];

  for (var fi = 0; fi < groupOrder.length; fi++) {
    var fName = groupOrder[fi];
    var fCourts = groups[fName];

    // 同一施設内で courseGroupId ごとにまとめる
    var cgGroups = {};
    var cgOrder = [];
    for (var ci = 0; ci < fCourts.length; ci++) {
      var cgId = String(fCourts[ci].courseGroupId);
      if (!cgGroups[cgId]) {
        cgGroups[cgId] = [];
        cgOrder.push(cgId);
      }
      cgGroups[cgId].push(fCourts[ci]);
    }

    for (var cgi = 0; cgi < cgOrder.length; cgi++) {
      var cgKey    = cgOrder[cgi];
      var cgCourts = cgGroups[cgKey];
      // パターン名は同グループ内で同じはず
      var pName    = (cgCourts[0] && cgCourts[0].patternName) ? cgCourts[0].patternName : '';
      var label    = pName ? (fName + ' / ' + pName) : fName;
      // LINE ボタンのラベルは40文字以内
      if (label.length > 40) label = label.substring(0, 38) + '…';

      var postbackData = 'action=selectFacility' +
        '&slotKey='       + encodeURIComponent(slotKey) +
        '&facilityId='    + encodeURIComponent(facilityId) +
        '&courseGroupId=' + encodeURIComponent(cgKey);

      buttons.push({
        type: 'button',
        style: 'primary',
        color: '#1E88E5',
        height: 'sm',
        action: {
          type: 'postback',
          label: label,
          data: postbackData,
          displayText: label + 'を選択'
        }
      });
    }
  }

  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#1E88E5',
      contents: [{ type: 'text', text: '施設を選んでください', weight: 'bold', size: 'lg', color: '#FFFFFF' }]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: dateLabel,                  weight: 'bold', size: 'xl' },
        { type: 'text', text: slotStart + '〜' + slotEnd, size: 'lg',    color: '#333333' }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: buttons
    }
  };
}

/**
 * 予約確認用の Flex Bubble を組み立てる(内部用・F-6)
 *
 * 選んだコート・施設・日時を表示し、「予約します」ボタンを提供する。
 * ボタンを押すと postback で action=confirmReserve が飛ぶ（実際の予約実行）。
 *
 * @param {string} slotKey
 * @param {string} facilityId
 * @param {number} courseTimeId
 * @param {string} patternName
 * @param {string} facilityName
 * @param {string} useDate       - 'YYYY-MM-DD'
 * @param {string} slotStart     - 'HH:mm'
 * @returns {Object} LINE Flex Message の bubble オブジェクト
 * @private
 */
function _buildReserveConfirmFlex(slotKey, facilityId, courseTimeId, patternName, facilityName, useDate, slotStart) {
  var slotEnd = _SLOT_ENDS[slotStart] || '?';

  var d = new Date(useDate + 'T00:00:00+09:00');
  var dateLabel = (d.getMonth() + 1) + '月' + d.getDate() + '日(' + _WEEKDAYS[d.getDay()] + ')';

  var imageUrl = _getPatternImageUrl(facilityName, patternName);

  var postbackData = 'action=confirmReserve' +
    '&slotKey='      + encodeURIComponent(slotKey) +
    '&facilityId='   + encodeURIComponent(facilityId) +
    '&courseTimeId=' + encodeURIComponent(String(courseTimeId));

  var bodyContents = [
    { type: 'text', text: dateLabel,                  weight: 'bold', size: 'xl' },
    { type: 'text', text: slotStart + '〜' + slotEnd, size: 'lg',    color: '#333333' },
    { type: 'text', text: facilityName,               size: 'sm',    color: '#888888', wrap: true }
  ];
  if (patternName) {
    bodyContents.push({ type: 'text', text: 'パターン: ' + patternName, size: 'sm', color: '#555555' });
  }

  var bubble = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#06C755',
      contents: [{ type: 'text', text: '予約内容の確認', weight: 'bold', size: 'lg', color: '#FFFFFF' }]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: bodyContents
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        style: 'primary',
        color: '#06C755',
        action: {
          type: 'postback',
          label: '予約します',
          data: postbackData,
          displayText: 'この内容で予約します'
        }
      }]
    }
  };

  if (imageUrl) {
    bubble.hero = {
      type: 'image',
      url: imageUrl,
      size: 'full',
      aspectRatio: '20:13',
      aspectMode: 'cover'
    };
  }

  return bubble;
}

/**
 * 施設選択後のコート選択処理(内部用・F-6)
 *
 * 選択された courseGroupId のコートだけを再 scan して _buildCourtSelectionFlex を表示する。
 * （postback 越しに scanResult を保持できないため再スキャンする）
 *
 * @param {string} groupId
 * @param {string} slotKey
 * @param {string} facilityId
 * @param {number} courseGroupId
 * @private
 */
function _doSelectFacilityReserve(groupId, slotKey, facilityId, courseGroupId) {
  var pipeIdx  = slotKey.indexOf('|');
  var useDate  = slotKey.substring(0, pipeIdx);
  var slotStart = slotKey.substring(pipeIdx + 1);
  var slotEnd   = _SLOT_ENDS[slotStart] || '?';

  var d = new Date(useDate + 'T00:00:00+09:00');
  var dateLabel = (d.getMonth() + 1) + '月' + d.getDate() + '日(' + _WEEKDAYS[d.getDay()] + ')';

  var scanResult;
  try {
    scanResult = _callScanLambda(useDate, slotStart, [courseGroupId]);
  } catch (scanErr) {
    logError(scanErr, { phase: '_doSelectFacilityReserve.scan', slotKey: slotKey });
    try {
      pushText(groupId, '❌ コート情報の取得中にエラーが発生しました。もう一度お試しください。');
    } catch (_) {}
    return;
  }

  if (!scanResult || !scanResult.success || !scanResult.courts || scanResult.courts.length === 0) {
    try {
      pushText(groupId,
        '😢 この施設の空きコートが見つかりませんでした。\n' +
        dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
        '手動でご確認ください。'
      );
    } catch (_) {}
    return;
  }

  var courts = scanResult.courts;
  var fName  = (courts[0] && courts[0].facilityName) || '';
  var pName  = (courts[0] && courts[0].patternName)  || '';

  try {
    var selFlex = _buildCourtSelectionFlex(
      slotKey, facilityId, fName, pName, dateLabel, slotStart, slotEnd, courts
    );
    withRetry(function() {
      return pushFlexMessage(groupId,
        'コートを選んでください（' + courts.length + '面空きあり）', selFlex);
    }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'pushCourtSelectionAfterFacility' });
  } catch (flexErr) {
    logError(flexErr, { phase: '_doSelectFacilityReserve.courtFlex', slotKey: slotKey });
  }
}
