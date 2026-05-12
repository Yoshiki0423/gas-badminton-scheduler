/**
 * @fileoverview Google スプレッドシート操作レイヤー
 *
 * メンバーシート(D-007 で確定した 5 列構造)および
 * スケジュールシート(D-011 / D-012 で確定した 7 列構造)の読み書きを行うファイルです。
 *
 * 提供する関数:
 *   ── メンバーシート ──
 *   - getMembersSheet()                       : メンバーシートを取得・初期化
 *   - upsertMemberAsActive(userId, displayName): 新規追加 or 既存行の active 復活(Lock 付き)
 *   - markMemberInactive(userId)              : 該当行の status を inactive に更新(Lock 付き)
 *
 *   ── スケジュールシート(F-1-2 / D-011 / D-012) ──
 *   - getSchedulesSheet()  : スケジュールシートを取得・初期化(ヘッダー自動生成)
 *   - addSchedule(data)    : スケジュール行を末尾に追加
 *   - getSchedules()       : 全スケジュール行をオブジェクト配列で返す(F-1-3 が使う)
 *
 *   ── メンバーシート追加(F-1-3 / D-008) ──
 *   - getActiveMembers()   : status が "active" のメンバーだけをオブジェクト配列で返す
 *
 * メンバーシート構造(D-007 で確定):
 *   A: userId       (LINE ユーザー ID・主キー・テキスト書式)
 *   B: displayName  (LINE 表示名)
 *   C: followedAt   (友だち追加日時 ISO 8601 + Asia/Tokyo)
 *   D: status       ("active" / "inactive")
 *   E: lastUpdatedAt(最終更新日時 ISO 8601 + Asia/Tokyo)
 *
 * スケジュールシート構造(D-011 命名規則 / D-012 scheduleId 採番ルール):
 *   A: scheduleId   (主キー・"SCH_" + タイムスタンプ + ランダム4桁 形式)
 *   B: date         (開放日・"YYYY-MM-DD" 文字列)
 *   C: startTime    (開始時刻・"HH:mm" 文字列)
 *   D: endTime      (終了時刻・"HH:mm" 文字列)
 *   E: facilityName (体育館名)
 *   F: note         (備考・任意)
 *   G: lastUpdatedAt(最終更新日時 ISO 8601 + Asia/Tokyo)
 *
 * 命名規則(D-011):
 *   - シート名は全小文字 + ハイフン区切り or 単一単語(`members`, `schedules` 等)
 *   - 列名は lowerCamelCase(`userId`, `followedAt` 等)
 *   - 主キー候補は `<種別>Id`(`userId`, `scheduleId`, `responseId` 等)
 *   詳細は DECISION_NOTES.md D-011 を参照。
 */

// ─────────────────────────────────────────────
// メンバーシート 定数
// ─────────────────────────────────────────────

/** メンバーシート名(D-007 で確定 / D-011 命名規則に準拠) */
var MEMBERS_SHEET_NAME = 'members';

/** ヘッダー行(D-007 で確定 / D-011 命名規則:lowerCamelCase) */
var MEMBERS_HEADER = ['userId', 'displayName', 'followedAt', 'status', 'lastUpdatedAt'];

/** 列インデックス(1-based・getRange 用) */
var COL_USER_ID = 1;
var COL_DISPLAY_NAME = 2;
var COL_FOLLOWED_AT = 3;
var COL_STATUS = 4;
var COL_LAST_UPDATED_AT = 5;

// ─────────────────────────────────────────────
// スケジュールシート 定数(F-1-2 / D-011 / D-012)
// ─────────────────────────────────────────────

/**
 * スケジュールシート名(D-011 命名規則:全小文字・単一単語)
 *
 * F-1-2(開放スケジュール手動入力)および F-1-3(質問配信)が共有するシートです。
 * Phase 2 のスクレイピング結果も同じシートに書き込む設計(D-006 後方互換)。
 */
var SCHEDULES_SHEET_NAME = 'schedules';

/**
 * スケジュールシートのヘッダー行(D-011 命名規則:lowerCamelCase)
 *
 * 列順は D-011 §将来追加予定のシート で確定した 7 列に準拠。
 */
var SCHEDULES_HEADER = [
  'scheduleId',   // A: 主キー(D-012 採番ルール)
  'date',         // B: 開放日(YYYY-MM-DD)
  'startTime',    // C: 開始時刻(HH:mm)
  'endTime',      // D: 終了時刻(HH:mm)
  'facilityName', // E: 体育館名
  'note',         // F: 備考(任意)
  'lastUpdatedAt' // G: 最終更新日時(ISO 8601 + Asia/Tokyo)
];

/** スケジュール列インデックス(1-based・getRange 用) */
var SCOL_SCHEDULE_ID   = 1;
var SCOL_DATE          = 2;
var SCOL_START_TIME    = 3;
var SCOL_END_TIME      = 4;
var SCOL_FACILITY_NAME = 5;
var SCOL_NOTE          = 6;
var SCOL_LAST_UPDATED  = 7;

// ─────────────────────────────────────────────
// メンバーシート 関数
// ─────────────────────────────────────────────

/**
 * メンバーシートを取得し、初回起動時はヘッダー行を自動生成する
 *
 * 設計:
 *   - スプレッドシート ID はスクリプトプロパティ `MEMBERS_SPREADSHEET_ID` から取得
 *   - シート名 `members` が無ければ作成し、ヘッダー行も書き込む
 *   - userId 列は文字列誤解釈防止のため `setNumberFormat('@')` を適用
 *
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} スプレッドシート ID 未設定 or シートが開けない場合
 */
function getMembersSheet() {
  var spreadsheetId = getProperty('MEMBERS_SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('MEMBERS_SPREADSHEET_ID is not set in Script Properties');
  }

  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (openError) {
    throw new Error('Failed to open spreadsheet (id=' + spreadsheetId + '): ' + openError.message);
  }

  var sheet = ss.getSheetByName(MEMBERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MEMBERS_SHEET_NAME);
    _initializeMembersSheet(sheet);
  } else if (sheet.getLastRow() === 0) {
    // 既存だが空 → ヘッダーだけ書く
    _initializeMembersSheet(sheet);
  }

  return sheet;
}

/**
 * メンバーシートの初期化(ヘッダー + 列フォーマット)
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @private
 */
function _initializeMembersSheet(sheet) {
  // ヘッダー行
  sheet.getRange(1, 1, 1, MEMBERS_HEADER.length).setValues([MEMBERS_HEADER]);
  sheet.getRange(1, 1, 1, MEMBERS_HEADER.length).setFontWeight('bold');
  sheet.setFrozenRows(1);

  // userId 列をテキスト書式に固定(数値誤解釈防止)
  sheet.getRange(1, COL_USER_ID, sheet.getMaxRows(), 1).setNumberFormat('@');

  // 列幅を見やすく
  sheet.setColumnWidth(COL_USER_ID, 280);
  sheet.setColumnWidth(COL_DISPLAY_NAME, 180);
  sheet.setColumnWidth(COL_FOLLOWED_AT, 200);
  sheet.setColumnWidth(COL_STATUS, 80);
  sheet.setColumnWidth(COL_LAST_UPDATED_AT, 200);
}

/**
 * メンバーを active 状態で登録する(新規追加 or 既存行の復活)
 *
 * 仕様(D-007 / D-008 / D-010):
 *   - 既に該当 userId の行がある場合 → status を "active" に戻し、displayName / lastUpdatedAt を更新
 *     (=再 follow ケース。D-010「TBD-10b-1 簡易先取り正式化」で確定済み。row 増殖を防ぐ重複防止)
 *   - 該当 userId が無い場合 → 末尾に新規追加
 *   - スプレッドシートの同時アクセス競合を防ぐため LockService.getScriptLock() を使用
 *   - リトライは withRetry でラップ
 *
 * @param {string} userId - LINE ユーザー ID
 * @param {string} displayName - LINE 表示名
 * @returns {{action: 'inserted' | 'reactivated', row: number}}
 */
function upsertMemberAsActive(userId, displayName) {
  if (!userId) {
    throw new Error('upsertMemberAsActive: userId is required');
  }

  var lock = LockService.getScriptLock();
  // 最大 10 秒待機。同時 follow が多発しても順次処理されるよう保護。
  // replyToken の有効期限(約 1 分)を圧迫しない時間に留める。
  if (!lock.tryLock(10 * 1000)) {
    throw new Error('upsertMemberAsActive: could not acquire lock');
  }

  try {
    return withRetry(function () {
      var sheet = getMembersSheet();
      var nowIso = _toIsoTokyo(new Date());

      var foundRow = _findRowByUserId(sheet, userId);

      if (foundRow > 0) {
        // 既存行 → 復活(D-010「再 follow 復活フロー(簡易先取り)」)
        sheet.getRange(foundRow, COL_DISPLAY_NAME).setValue(displayName);
        sheet.getRange(foundRow, COL_STATUS).setValue('active');
        sheet.getRange(foundRow, COL_LAST_UPDATED_AT).setValue(nowIso);
        SpreadsheetApp.flush();
        return { action: 'reactivated', row: foundRow };
      }

      // 新規行
      var newRow = sheet.getLastRow() + 1;
      sheet.getRange(newRow, COL_USER_ID).setNumberFormat('@').setValue(userId);
      sheet.getRange(newRow, COL_DISPLAY_NAME).setValue(displayName);
      sheet.getRange(newRow, COL_FOLLOWED_AT).setValue(nowIso);
      sheet.getRange(newRow, COL_STATUS).setValue('active');
      sheet.getRange(newRow, COL_LAST_UPDATED_AT).setValue(nowIso);
      SpreadsheetApp.flush();
      return { action: 'inserted', row: newRow };
    }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'upsertMemberAsActive' });
  } finally {
    lock.releaseLock();
  }
}

/**
 * メンバーを inactive にする(unfollow 処理本体)
 *
 * @param {string} userId
 * @returns {{found: boolean, row: number}}
 */
function markMemberInactive(userId) {
  if (!userId) {
    throw new Error('markMemberInactive: userId is required');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    throw new Error('markMemberInactive: could not acquire lock');
  }

  try {
    return withRetry(function () {
      var sheet = getMembersSheet();
      var foundRow = _findRowByUserId(sheet, userId);

      if (foundRow <= 0) {
        return { found: false, row: -1 };
      }

      var nowIso = _toIsoTokyo(new Date());
      sheet.getRange(foundRow, COL_STATUS).setValue('inactive');
      sheet.getRange(foundRow, COL_LAST_UPDATED_AT).setValue(nowIso);
      SpreadsheetApp.flush();
      return { found: true, row: foundRow };
    }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'markMemberInactive' });
  } finally {
    lock.releaseLock();
  }
}

/**
 * userId から該当行番号を線形検索する(内部用)
 *
 * MVP 想定のメンバー数(4-10 名)では線形検索で十分。
 * Phase 2 以降で 100 名規模を想定する場合は、別途 userId → row のキャッシュを検討。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} userId
 * @returns {number} 1-based の行番号(ヘッダー行は 1)。見つからなければ -1。
 * @private
 */
function _findRowByUserId(sheet, userId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return -1; // ヘッダーのみ・データなし
  }

  // A 列(userId)を一括取得して比較(getRange の往復を最小化 = 高速)
  var values = sheet.getRange(2, COL_USER_ID, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === userId) {
      return i + 2; // ヘッダー行を考慮して +2
    }
  }
  return -1;
}

/**
 * Date を ISO 8601(Asia/Tokyo)文字列に変換する(内部用)
 *
 * 例: 2026-05-10T14:30:00+09:00
 *
 * @param {Date} date
 * @returns {string}
 * @private
 */
function _toIsoTokyo(date) {
  return Utilities.formatDate(date, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

// ─────────────────────────────────────────────
// スケジュールシート 関数(F-1-2 追加 / D-011 / D-012)
// ─────────────────────────────────────────────

/**
 * スケジュールシートを取得し、初回起動時はヘッダー行を自動生成する
 *
 * 設計(getMembersSheet と同じパターン):
 *   - スプレッドシート ID はスクリプトプロパティ `MEMBERS_SPREADSHEET_ID` から取得
 *     (メンバーシートと同じスプレッドシートファイル内に `schedules` シートを作成する)
 *   - シート名 `schedules` が無ければ作成し、ヘッダー行も書き込む
 *   - 全列に `setNumberFormat('@')` を適用し、日付・時刻列の数値自動変換を防止
 *
 * 用語補足:
 *   setNumberFormat('@') = スプレッドシートのセル書式を「テキスト」に固定する設定。
 *   これをしないと、例えば "2026-05-10" が日付型の数値として読み込まれてしまい、
 *   "2026-05-10" ではなく謎の数字が表示されることがある。
 *
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} スプレッドシート ID 未設定 or シートが開けない場合
 */
function getSchedulesSheet() {
  var spreadsheetId = getProperty('MEMBERS_SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('MEMBERS_SPREADSHEET_ID is not set in Script Properties');
  }

  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (openError) {
    throw new Error('Failed to open spreadsheet (id=' + spreadsheetId + '): ' + openError.message);
  }

  var sheet = ss.getSheetByName(SCHEDULES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SCHEDULES_SHEET_NAME);
    _initializeSchedulesSheet(sheet);
  } else if (sheet.getLastRow() === 0) {
    // 既存だが空 → ヘッダーだけ書く
    _initializeSchedulesSheet(sheet);
  }

  return sheet;
}

/**
 * スケジュールシートの初期化(ヘッダー + 列フォーマット)
 *
 * 設計ポイント:
 *   - 全列を `setNumberFormat('@')` でテキスト書式に固定する。
 *     date 列(B)/ startTime 列(C)/ endTime 列(D)が
 *     スプレッドシートに「日付型」や「時刻型」として誤解釈されるのを防ぐ。
 *   - 管理者が手入力するため、列幅も見やすく設定する。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @private
 */
function _initializeSchedulesSheet(sheet) {
  // ヘッダー行を書き込む
  sheet.getRange(1, 1, 1, SCHEDULES_HEADER.length).setValues([SCHEDULES_HEADER]);
  sheet.getRange(1, 1, 1, SCHEDULES_HEADER.length).setFontWeight('bold');
  sheet.setFrozenRows(1);

  // 全列をテキスト書式に固定(日付・時刻の数値変換防止)
  // getMaxRows() = シートの現在の最大行数。初期化直後は 1000 行程度。
  sheet.getRange(1, 1, sheet.getMaxRows(), SCHEDULES_HEADER.length).setNumberFormat('@');

  // 列幅を管理者が入力しやすいサイズに設定
  sheet.setColumnWidth(SCOL_SCHEDULE_ID,   200); // scheduleId
  sheet.setColumnWidth(SCOL_DATE,          120); // date
  sheet.setColumnWidth(SCOL_START_TIME,     80); // startTime
  sheet.setColumnWidth(SCOL_END_TIME,       80); // endTime
  sheet.setColumnWidth(SCOL_FACILITY_NAME, 200); // facilityName
  sheet.setColumnWidth(SCOL_NOTE,          240); // note
  sheet.setColumnWidth(SCOL_LAST_UPDATED,  200); // lastUpdatedAt
}

/**
 * スケジュール行を末尾に追加する
 *
 * scheduleId の採番ルール(D-012):
 *   "SCH_" + yyyyMMddHHmmss(Asia/Tokyo) + "_" + 4桁ランダム数字
 *   例: SCH_20260510143022_4831
 *
 *   採用理由(D-012):
 *   - 「SCH_」プレフィックスで目視識別が容易(他 ID と区別できる)
 *   - タイムスタンプ部分で挿入順ソートが文字列比較で可能
 *   - ランダム4桁で同一秒内の衝突確率を 1/10000 に抑える
 *   - GAS には UUID 生成 API がないため、シンプルかつ十分な一意性を自力実現
 *   - 管理者がシート上で目視するため短くて読みやすい形式を優先
 *
 * @param {{
 *   date: string,         - 開放日(YYYY-MM-DD 形式)
 *   startTime: string,    - 開始時刻(HH:mm 形式)
 *   endTime: string,      - 終了時刻(HH:mm 形式)
 *   facilityName: string, - 体育館名
 *   note?: string         - 備考(省略可)
 * }} scheduleData
 * @returns {{scheduleId: string, row: number}} 採番された scheduleId と挿入行番号
 * @throws {Error} 必須フィールド未入力 or スプレッドシート書き込み失敗
 */
function addSchedule(scheduleData) {
  if (!scheduleData || !scheduleData.date || !scheduleData.startTime ||
      !scheduleData.endTime || !scheduleData.facilityName) {
    throw new Error('addSchedule: date / startTime / endTime / facilityName は必須です');
  }

  var scheduleId = _generateScheduleId();
  var nowIso = _toIsoTokyo(new Date());
  var note = scheduleData.note || '';

  var sheet = getSchedulesSheet();
  var newRow = sheet.getLastRow() + 1;

  // 1 行分を一括書き込み(setValues は getRange の往復が 1 回で済むため高速)
  var rowValues = [[
    scheduleId,
    scheduleData.date,
    scheduleData.startTime,
    scheduleData.endTime,
    scheduleData.facilityName,
    note,
    nowIso
  ]];
  sheet.getRange(newRow, 1, 1, SCHEDULES_HEADER.length).setValues(rowValues);
  SpreadsheetApp.flush();

  return { scheduleId: scheduleId, row: newRow };
}

/**
 * スケジュールシートの全行をオブジェクト配列で返す
 *
 * F-1-3(質問配信機能)が使う想定。ヘッダー行は除外して返す。
 * データが 1 件もない場合は空配列を返す(エラーにしない)。
 *
 * 返却するオブジェクトの形:
 *   [{
 *     scheduleId: "SCH_20260510143022_4831",
 *     date: "2026-05-15",
 *     startTime: "18:00",
 *     endTime: "20:00",
 *     facilityName: "鳥屋野総合体育館",
 *     note: "",
 *     lastUpdatedAt: "2026-05-10T14:30:22+09:00"
 *   }, ...]
 *
 * @returns {Array<Object>} スケジュールオブジェクトの配列
 */
function getSchedules() {
  var sheet = getSchedulesSheet();
  var lastRow = sheet.getLastRow();

  // データ行が 1 行もない場合(ヘッダーのみ)
  if (lastRow < 2) {
    return [];
  }

  // 2 行目以降(データ行)を全列一括取得
  var dataRange = sheet.getRange(2, 1, lastRow - 1, SCHEDULES_HEADER.length);
  var values = dataRange.getValues();

  // 2 次元配列 → オブジェクト配列に変換
  return values.map(function (row) {
    return {
      scheduleId:    row[SCOL_SCHEDULE_ID   - 1],
      date:          row[SCOL_DATE          - 1],
      startTime:     row[SCOL_START_TIME    - 1],
      endTime:       row[SCOL_END_TIME      - 1],
      facilityName:  row[SCOL_FACILITY_NAME - 1],
      note:          row[SCOL_NOTE          - 1],
      lastUpdatedAt: row[SCOL_LAST_UPDATED  - 1]
    };
  });
}

/**
 * status が "active" のメンバーだけをオブジェクト配列で返す(F-1-3 質問配信用)
 *
 * D-008 で「F-1-3 実装時に `status === 'active'` のメンバーだけに送る
 * フィルタを必ず入れる」と確定済みのため、本関数でその責務を担う。
 *
 * データが 1 件もない(またはアクティブメンバーがいない)場合は空配列を返す。
 *
 * 返却するオブジェクトの形:
 *   [{
 *     userId: "Uxxxxxxxxxxxx",
 *     displayName: "山田太郎",
 *     followedAt: "2026-05-10T14:30:00+09:00",
 *     status: "active",
 *     lastUpdatedAt: "2026-05-10T14:30:00+09:00"
 *   }, ...]
 *
 * @returns {Array<Object>} active なメンバーオブジェクトの配列
 */
function getActiveMembers() {
  var sheet = getMembersSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return []; // ヘッダーのみ・データなし
  }

  var values = sheet.getRange(2, 1, lastRow - 1, MEMBERS_HEADER.length).getValues();

  return values
    .filter(function (row) { return row[COL_STATUS - 1] === 'active'; })
    .map(function (row) {
      return {
        userId:        row[COL_USER_ID       - 1],
        displayName:   row[COL_DISPLAY_NAME  - 1],
        followedAt:    row[COL_FOLLOWED_AT   - 1],
        status:        row[COL_STATUS        - 1],
        lastUpdatedAt: row[COL_LAST_UPDATED_AT - 1]
      };
    });
}

/**
 * scheduleId を採番する(内部用)
 *
 * 形式: "SCH_" + yyyyMMddHHmmss(Asia/Tokyo) + "_" + 4桁ランダム数字
 * 詳細は addSchedule の JSDoc および DECISION_NOTES.md D-012 を参照。
 *
 * @returns {string}
 * @private
 */
function _generateScheduleId() {
  var now = new Date();
  var timestamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMddHHmmss');
  // 0〜9999 のランダム整数を 4 桁ゼロ埋めで生成
  var rand = Math.floor(Math.random() * 10000);
  var randPadded = ('0000' + rand).slice(-4);
  return 'SCH_' + timestamp + '_' + randPadded;
}

// ─────────────────────────────────────────────
// responses シート 定数・関数(F-1-4 回答収集)
// ─────────────────────────────────────────────

/**
 * responses シート名(D-011 命名規則)
 *
 * members / schedules と同じスプレッドシートファイル内に作成する。
 */
var RESPONSES_SHEET_NAME = 'responses';

/**
 * responses シートのヘッダー行(D-011 命名規則:lowerCamelCase)
 *
 * 列構造(F-1-4 / D-011):
 *   A: responseId    — 主キー(RES_yyyyMMddHHmmss_XXXX 形式)
 *   B: userId        — LINE ユーザー ID
 *   C: scheduleId    — 回答対象スケジュールの ID
 *   D: canAttend     — 参加可否(ボタンタップ = 参加できる = true)
 *   E: respondedAt   — 初回回答日時(ISO 8601 + Asia/Tokyo)
 *   F: lastUpdatedAt — 最終更新日時(ISO 8601 + Asia/Tokyo)
 */
var RESPONSES_HEADER = [
  'responseId',
  'userId',
  'scheduleId',
  'canAttend',
  'respondedAt',
  'lastUpdatedAt'
];

/** responses シート列インデックス(1-based・getRange 用) */
var RCOL_RESPONSE_ID  = 1;
var RCOL_USER_ID      = 2;
var RCOL_SCHEDULE_ID  = 3;
var RCOL_CAN_ATTEND   = 4;
var RCOL_RESPONDED_AT = 5;
var RCOL_LAST_UPDATED = 6;

/**
 * responses シートを取得し、初回起動時はヘッダー行を自動生成する
 *
 * getMembersSheet / getSchedulesSheet と同じパターン。
 * シートが存在しない場合は自動作成するため、管理者が手動でシートを作る必要はない。
 *
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} スプレッドシート ID 未設定 or シートが開けない場合
 */
function getResponsesSheet() {
  var spreadsheetId = getProperty('MEMBERS_SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('MEMBERS_SPREADSHEET_ID is not set in Script Properties');
  }

  var ss;
  try {
    ss = SpreadsheetApp.openById(spreadsheetId);
  } catch (openError) {
    throw new Error('Failed to open spreadsheet (id=' + spreadsheetId + '): ' + openError.message);
  }

  var sheet = ss.getSheetByName(RESPONSES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RESPONSES_SHEET_NAME);
    _initializeResponsesSheet(sheet);
  } else if (sheet.getLastRow() === 0) {
    _initializeResponsesSheet(sheet);
  }

  return sheet;
}

/**
 * responses シートの初期化(ヘッダー + 列フォーマット)
 *
 * userId / scheduleId 列はテキスト書式に固定し、数値変換を防ぐ。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @private
 */
function _initializeResponsesSheet(sheet) {
  sheet.getRange(1, 1, 1, RESPONSES_HEADER.length).setValues([RESPONSES_HEADER]);
  sheet.getRange(1, 1, 1, RESPONSES_HEADER.length).setFontWeight('bold');
  sheet.setFrozenRows(1);

  sheet.getRange(1, RCOL_USER_ID,     sheet.getMaxRows(), 1).setNumberFormat('@');
  sheet.getRange(1, RCOL_SCHEDULE_ID, sheet.getMaxRows(), 1).setNumberFormat('@');

  sheet.setColumnWidth(RCOL_RESPONSE_ID,  200);
  sheet.setColumnWidth(RCOL_USER_ID,      280);
  sheet.setColumnWidth(RCOL_SCHEDULE_ID,  200);
  sheet.setColumnWidth(RCOL_CAN_ATTEND,    80);
  sheet.setColumnWidth(RCOL_RESPONDED_AT, 200);
  sheet.setColumnWidth(RCOL_LAST_UPDATED, 200);
}

/**
 * 回答を登録する(同一 userId + scheduleId があれば上書き、なければ新規追加)
 *
 * upsert とは「あれば更新、なければ挿入」の略称。
 * 同じ人が同じ日程に何度もボタンを押しても、行が増殖せず最新の状態に上書きされる。
 *
 * ボタンをタップした = 参加できる、なので canAttend は常に true を書き込む。
 * (参加不可の取り消しは Phase 2 以降の TBD として将来拡張予定)
 *
 * @param {string} userId    - LINE ユーザー ID
 * @param {string} scheduleId - 回答対象のスケジュール ID
 * @returns {{action: 'inserted' | 'updated', row: number, responseId: string}}
 */
function upsertResponse(userId, scheduleId) {
  if (!userId) {
    throw new Error('upsertResponse: userId is required');
  }
  if (!scheduleId) {
    throw new Error('upsertResponse: scheduleId is required');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    throw new Error('upsertResponse: could not acquire lock');
  }

  try {
    return withRetry(function () {
      var sheet = getResponsesSheet();
      var nowIso = _toIsoTokyo(new Date());
      var foundRow = _findResponseRow(sheet, userId, scheduleId);

      if (foundRow > 0) {
        // 既存行を上書き
        sheet.getRange(foundRow, RCOL_CAN_ATTEND).setValue(true);
        sheet.getRange(foundRow, RCOL_LAST_UPDATED).setValue(nowIso);
        SpreadsheetApp.flush();
        var existingId = sheet.getRange(foundRow, RCOL_RESPONSE_ID).getValue();
        return { action: 'updated', row: foundRow, responseId: existingId };
      }

      // 新規行 — 6 列を 1 回の setValues で一括書き込み(API 呼び出し 6→1 回に削減)
      // userId・scheduleId 列のテキスト書式は _initializeResponsesSheet で列ごと設定済み
      var responseId = _generateResponseId();
      var newRow = sheet.getLastRow() + 1;
      sheet.getRange(newRow, 1, 1, RESPONSES_HEADER.length).setValues([[
        responseId, userId, scheduleId, true, nowIso, nowIso
      ]]);
      SpreadsheetApp.flush();
      return { action: 'inserted', row: newRow, responseId: responseId };
    }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'upsertResponse' });
  } finally {
    lock.releaseLock();
  }
}

/**
 * userId + scheduleId の組み合わせで既存行を探す(内部用)
 *
 * B 列(userId)と C 列(scheduleId)を一括取得して両方一致する行を返す。
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {string} userId
 * @param {string} scheduleId
 * @returns {number} 1-based の行番号。見つからなければ -1。
 * @private
 */
function _findResponseRow(sheet, userId, scheduleId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return -1;
  }
  // B〜C 列(userId, scheduleId)を一括取得して比較
  var values = sheet.getRange(2, RCOL_USER_ID, lastRow - 1, 2).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === userId && values[i][1] === scheduleId) {
      return i + 2;
    }
  }
  return -1;
}

/**
 * responseId を採番する(内部用)
 *
 * 形式: "RES_" + yyyyMMddHHmmss(Asia/Tokyo) + "_" + 4桁ランダム数字
 * scheduleId(_generateScheduleId)と同じルール・フォーマット(D-011 / D-012 命名規則)。
 *
 * @returns {string}
 * @private
 */
function _generateResponseId() {
  var now = new Date();
  var timestamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMddHHmmss');
  var rand = Math.floor(Math.random() * 10000);
  var randPadded = ('0000' + rand).slice(-4);
  return 'RES_' + timestamp + '_' + randPadded;
}

// ─────────────────────────────────────────────
// responses シート 読み取り関数(F-1-5 / F-1-6 用)
// ─────────────────────────────────────────────

/**
 * responses シートの全行をオブジェクト配列で返す
 *
 * getSchedules() と同じパターン。
 * F-1-6(集計判定)が scheduleId ごとの票数を計算するために使う。
 *
 * データが 1 件もない場合は空配列を返す(エラーにしない)。
 *
 * @returns {Array<Object>} response オブジェクトの配列
 */
function getAllResponses() {
  var sheet = getResponsesSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  var values = sheet.getRange(2, 1, lastRow - 1, RESPONSES_HEADER.length).getValues();

  return values.map(function (row) {
    return {
      responseId:    row[RCOL_RESPONSE_ID  - 1],
      userId:        row[RCOL_USER_ID      - 1],
      scheduleId:    row[RCOL_SCHEDULE_ID  - 1],
      canAttend:     row[RCOL_CAN_ATTEND   - 1],
      respondedAt:   row[RCOL_RESPONDED_AT - 1],
      lastUpdatedAt: row[RCOL_LAST_UPDATED - 1]
    };
  });
}

/**
 * responses シートに 1 件以上回答のある userId を重複なしで返す
 *
 * F-1-5(リマインド)が「まだ誰も回答していないメンバー」を割り出すために使う。
 * F-1-6(集計判定)が「全員回答したか」を判定するためにも使う。
 *
 * @returns {Array<string>} userId の配列(重複なし)
 */
function getRespondedUserIds() {
  var responses = getAllResponses();
  var seen = {};
  var result = [];
  for (var i = 0; i < responses.length; i++) {
    var uid = responses[i].userId;
    if (uid && !seen[uid]) {
      seen[uid] = true;
      result.push(uid);
    }
  }
  return result;
}
