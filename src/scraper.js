/**
 * @fileoverview F-2-1 スクレイピング自動化 / F-2-2 更新検知による自動起動
 *
 * Google スプレッドシートの IMPORTHTML 関数を使って
 * 4 体育館(niigata-kaikou.jp)の個人開放スケジュールを自動取得し、
 * schedules シートへ書き込む。
 *
 * 背景(D-016):
 *   niigata-kaikou.jp は XSERVER WAF が Google の IP をブロックするため、
 *   UrlFetchApp.fetch() が HTTP 501 で失敗する。
 *   代替手段として IMPORTHTML 関数をスプレッドシートに設定し、
 *   GAS から sheet.getDataRange().getValues() で読み込む方式に変更した。
 *
 * セットアップ手順:
 *   1. GAS エディタで setupScraperSheets() を 1 回だけ手動実行する
 *      → scraper-420 / scraper-413 / scraper-495 シートが作成され、
 *        各シートに IMPORTHTML 式が設定される
 *   2. 各シートで IMPORTHTML の読み込みが完了するのを確認する
 *   3. scrapeAllFacilities() または checkAndScrapeIfUpdated() を実行して動作確認する
 *
 * 提供する関数:
 *   - setupScraperSheets()             : IMPORTHTML シートを初期セットアップ(1 回だけ実行)
 *   - scrapeAllFacilities()            : 全体育館をスクレイピングして schedules シートへ保存
 *   - scrapeFacilitySchedule(facility, ss) : 1 体育館のシート読み込み + パース + schedules 保存
 *   - parseScraperSheetValues(values, name) : シートの 2D 配列からスケジュール配列を抽出
 *   - checkAndScrapeIfUpdated()        : シート内容のハッシュ比較 → 更新あり時に scrape + 配信
 *   - setupDailyTrigger()              : checkAndScrapeIfUpdated の毎朝 7 時トリガーを設定
 *
 * エラーポリシー(REQUIREMENTS.md §4-2):
 *   - 体育館シート取得失敗 → 前回データをそのまま使い続ける(即時リトライしない)
 *   - 連続 3 日失敗 → ScriptProperties の連続失敗カウントが FAIL_THRESHOLD に達したら管理者通知
 *   - withRetry は「スプレッドシート書き込み(addSchedule)」には使う
 *     シート読み取りには使わない(IMPORTHTML が更新中の場合は次回で再試行)
 */

// ─────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────

/**
 * スクレイピング対象の施設一覧(D-005 / F-2-1)
 *
 * enabled: false の施設はスキップする(バドミントン個人開放がない施設)
 * sheetName: IMPORTHTML を設置するシート名(null = スキップ対象)
 */
var FACILITIES = [
  {
    facilityId: 442,
    facilityName: '西総合スポーツセンター',
    url: 'https://niigata-kaikou.jp/facility/442/schedule',
    sheetName: null,
    enabled: false  // バドミントン個人開放なし → スキップ
  },
  {
    facilityId: 420,
    facilityName: '鳥屋野総合体育館',
    url: 'https://niigata-kaikou.jp/facility/420/schedule',
    sheetName: 'scraper-420',
    enabled: true
  },
  {
    facilityId: 413,
    facilityName: '東総合スポーツセンター',
    url: 'https://niigata-kaikou.jp/facility/413/schedule',
    sheetName: 'scraper-413',
    enabled: true
  },
  {
    facilityId: 495,
    facilityName: '白根カルチャーセンター',
    url: 'https://niigata-kaikou.jp/facility/495/schedule',
    sheetName: 'scraper-495',
    enabled: true
  }
];

/** 連続失敗カウントのしきい値(これを超えたら管理者通知) */
var FAIL_THRESHOLD = 3;

/** ScriptProperties キー: 最終スクレイピング実行日(YYYY-MM-DD) */
var PROP_LAST_RUN_DATE = 'SCRAPER_LAST_RUN_DATE';

/** ScriptProperties キー: 施設ごとのハッシュ接頭辞(例: HASH_FACILITY_420) */
var HASH_KEY_PREFIX = 'HASH_FACILITY_';

/** ScriptProperties キー: 施設ごとの連続失敗カウント接頭辞(例: FAIL_COUNT_FACILITY_420) */
var FAIL_COUNT_KEY_PREFIX = 'FAIL_COUNT_FACILITY_';

/**
 * ScriptProperties キー: 施設ごとに「スクレイピングで取得した月の一覧」を一時保存する接頭辞
 * 値は JSON.stringify(["2026-05","2026-06"]) のような YYYY-MM 配列(ソート済み)
 * 例: SCRAPED_MONTHS_FACILITY_420
 * (D-018) デバッグ用に通知後も消さずに残す設計
 */
var SCRAPED_MONTHS_KEY_PREFIX = 'SCRAPED_MONTHS_FACILITY_';

/**
 * ScriptProperties キー: 施設ごとに「最後に新月通知を送った月(YYYY-MM)」を記録する接頭辞
 * 例: LAST_NOTIFIED_MONTH_FACILITY_420
 */
var LAST_NOTIFIED_MONTH_KEY_PREFIX = 'LAST_NOTIFIED_MONTH_FACILITY_';

/**
 * ScriptProperties キー: 「全施設の予定が揃った」通知を送った最後の月(YYYY-MM)
 */
var ALL_FACILITIES_NOTIFIED_MONTH_KEY = 'ALL_FACILITIES_NOTIFIED_MONTH';

/** checkAndScrapeIfUpdated を呼ぶトリガーの関数名 */
var TRIGGER_FUNCTION_NAME = 'checkAndScrapeIfUpdated';

/** 毎朝トリガーを起動する時刻(0-23) */
var TRIGGER_HOUR = 7;

/**
 * バドミントン列のデフォルト列インデックス(0-based)
 * ヘッダー行で「バドミントン」が見つからなかった場合のフォールバック
 */
var DEFAULT_BADMINTON_COL = 2;

/** ヘッダー行を探す最大行数(先頭 N 行以内でバドミントン列を探す) */
var HEADER_SEARCH_LIMIT = 5;

// ─────────────────────────────────────────────
// セットアップ
// ─────────────────────────────────────────────

/**
 * IMPORTHTML 用スクレイパーシートを初期セットアップする
 *
 * 1 回だけ GAS エディタから手動実行する初期化関数。
 * enabled な施設(scraper-420 / scraper-413 / scraper-495)それぞれのシートを作成し、
 * A1 セルに IMPORTHTML 式を設定する。
 * 既存シートがあれば中身を上書き(セットアップ再実行に対応)。
 *
 * 実行後: IMPORTHTML のデータ読み込みが完了するまで数十秒〜数分待ってから
 *         scrapeAllFacilities() を実行すること。
 *
 * @returns {void}
 */
function setupScraperSheets() {
  var spreadsheetId = getProperty('MEMBERS_SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('MEMBERS_SPREADSHEET_ID が設定されていません。スクリプトプロパティを確認してください。');
  }
  var ss = SpreadsheetApp.openById(spreadsheetId);

  for (var i = 0; i < FACILITIES.length; i++) {
    var facility = FACILITIES[i];
    if (!facility.enabled || !facility.sheetName) {
      console.log('[INFO] setupScraperSheets: ' + facility.facilityName + ' はスキップ(enabled=false)');
      continue;
    }

    var sheet = ss.getSheetByName(facility.sheetName);
    if (sheet) {
      // 既存シートがあれば中身をクリアして上書き
      sheet.clearContents();
      console.log('[INFO] setupScraperSheets: ' + facility.sheetName + ' の既存シートをクリアしました。');
    } else {
      sheet = ss.insertSheet(facility.sheetName);
      console.log('[INFO] setupScraperSheets: ' + facility.sheetName + ' シートを新規作成しました。');
    }

    // IMPORTHTML 式を A1 に設定
    // table,2 が対象テーブル(D-016 で確認済み)
    var formula = '=IMPORTHTML("' + facility.url + '","table",2)';
    sheet.getRange('A1').setFormula(formula);
    console.log('[INFO] setupScraperSheets: ' + facility.sheetName + ' に設定: ' + formula);
  }

  console.log('[INFO] setupScraperSheets: 完了。IMPORTHTML の読み込みが完了してから scrapeAllFacilities() を実行してください。');
}

// ─────────────────────────────────────────────
// F-2-1: スクレイピング本体
// ─────────────────────────────────────────────

/**
 * 全体育館をスクレイピングして schedules シートへ保存する
 *
 * 1 日 1 回制限:
 *   ScriptProperties の SCRAPER_LAST_RUN_DATE と今日の日付を比較し、
 *   同日に既に実行済みなら何もせずに返る。
 *   checkAndScrapeIfUpdated 経由で呼ばれる場合はシート内容変化が前提なので
 *   制限チェックをスキップする引数 skipDailyCheck を用意している。
 *
 * @param {boolean} [skipDailyCheck=false] - true にすると 1 日 1 回制限チェックをスキップ
 * @returns {{totalSaved: number, facilityResults: Array}} 保存件数サマリ
 */
function scrapeAllFacilities(skipDailyCheck) {
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  if (!skipDailyCheck) {
    var lastRunDate = getProperty(PROP_LAST_RUN_DATE);
    if (lastRunDate === today) {
      console.log('[INFO] scrapeAllFacilities: 本日は既に実行済みです(' + today + ')。スキップします。');
      return { totalSaved: 0, facilityResults: [] };
    }
  }

  // 実行日を記録してから処理(二重実行防止)
  PropertiesService.getScriptProperties().setProperty(PROP_LAST_RUN_DATE, today);

  var spreadsheetId = getProperty('MEMBERS_SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('MEMBERS_SPREADSHEET_ID が設定されていません。スクリプトプロパティを確認してください。');
  }
  var ss = SpreadsheetApp.openById(spreadsheetId);

  var totalSaved = 0;
  var facilityResults = [];

  for (var i = 0; i < FACILITIES.length; i++) {
    var facility = FACILITIES[i];
    try {
      var saved = scrapeFacilitySchedule(facility, ss);
      totalSaved += saved;
      facilityResults.push({ facilityId: facility.facilityId, saved: saved, error: null });
      // 連続失敗カウントをリセット(成功したため)
      _resetFailCount(facility.facilityId);
      console.log('[INFO] scrapeAllFacilities: ' + facility.facilityName + ' → ' + saved + '件保存');
    } catch (err) {
      logError(err, { phase: 'scrapeAllFacilities.loop', facilityId: facility.facilityId, facilityName: facility.facilityName });
      facilityResults.push({ facilityId: facility.facilityId, saved: 0, error: err.message });
      // 失敗カウントを加算し、しきい値超えなら管理者通知
      _incrementFailCountAndNotifyIfNeeded(facility);
      // エラーが起きても次の体育館は続行する(エラーポリシー §4-2)
    }
  }

  console.log('[INFO] scrapeAllFacilities 完了: totalSaved=' + totalSaved);
  return { totalSaved: totalSaved, facilityResults: facilityResults };
}

/**
 * 1 体育館の IMPORTHTML シートを読み込み、schedules シートへ保存する
 *
 * IMPORTHTML 方式(D-016):
 *   UrlFetchApp の代わりに、スプレッドシートの IMPORTHTML 関数が取得したデータを
 *   sheet.getDataRange().getValues() で読み込む。
 *   WAF ブロック問題を回避し、Google サービス間の通信として安定動作する。
 *
 * @param {{ facilityId: number, facilityName: string, url: string, sheetName: string|null, enabled: boolean }} facility
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} [ss] - 開済みスプレッドシート。省略時は内部で openById する
 * @returns {number} 保存できたスケジュール件数
 * @throws {Error} シートが存在しない場合 or パース結果を書き込めない場合
 */
function scrapeFacilitySchedule(facility, ss) {
  // enabled=false の施設はスキップ(西総合スポーツセンターなど)
  if (!facility.enabled) {
    console.log('[INFO] scrapeFacilitySchedule: ' + facility.facilityName + ' は enabled=false のためスキップ');
    return 0;
  }

  if (!ss) {
    var spreadsheetId = getProperty('MEMBERS_SPREADSHEET_ID');
    if (!spreadsheetId) {
      throw new Error('MEMBERS_SPREADSHEET_ID が設定されていません。');
    }
    ss = SpreadsheetApp.openById(spreadsheetId);
  }

  // シートの存在確認
  var sheet = ss.getSheetByName(facility.sheetName);
  if (!sheet) {
    throw new Error(
      facility.facilityName + ' のシート(' + facility.sheetName + ')が見つかりません。' +
      'setupScraperSheets() を先に実行してください。'
    );
  }

  // IMPORTHTML が読み込んだデータを 2D 配列で取得
  var values = sheet.getDataRange().getValues();

  if (!values || values.length === 0) {
    console.log('[WARN] scrapeFacilitySchedule: ' + facility.facilityName + ' のシートが空です。IMPORTHTML の読み込みを確認してください。');
    return 0;
  }

  // パース
  var schedules = parseScraperSheetValues(values, facility.facilityName);

  if (schedules.length === 0) {
    // パース結果が 0 件はシート構造変化の可能性があるため警告ログのみ(エラーにしない)
    console.log('[WARN] scrapeFacilitySchedule: ' + facility.facilityName + ' のパース結果が 0 件です。シート構造を確認してください。');
    return 0;
  }

  // スプレッドシートへ保存(addSchedule を withRetry でラップ)
  // IIFE で schedule をキャプチャ: var はブロックスコープを持たないため
  // コールバック内で直接ループ変数を参照すると最後の値に固定されるバグを防ぐ
  // 個別 try/catch で 1 件失敗しても次の件を続行する(エラーポリシー §4-2)
  var savedCount = 0;
  for (var i = 0; i < schedules.length; i++) {
    (function (schedule) {
      try {
        withRetry(function () {
          addSchedule(schedule);
        }, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'addSchedule.' + facility.facilityName });
        savedCount++;
      } catch (saveErr) {
        logError(saveErr, {
          phase: 'scrapeFacilitySchedule.save',
          facilityName: facility.facilityName,
          date: schedule.date
        });
        // 1 件失敗しても次の件は続行する
      }
    })(schedules[i]);
  }

  // ─── 月一覧を ScriptProperties に一時保存(D-018: 新月検知用) ───
  // パース済みの schedules から "YYYY-MM" を重複なく抽出してソートして保存する
  // キー: SCRAPED_MONTHS_FACILITY_<facilityId>
  // 通知後も残す(デバッグ用・D-018)
  _saveScrapedMonths(facility.facilityId, schedules);

  return savedCount;
}

/**
 * パース済みスケジュール配列から月一覧を抽出して ScriptProperties に保存する(内部用)
 *
 * スケジュールの date("YYYY-MM-DD")から "YYYY-MM" 部分を抽出し、
 * 重複を除いてソートした配列を JSON.stringify して ScriptProperties に保存する。
 * 通知後も消さず残す(デバッグ用・D-018)。
 *
 * @param {number} facilityId - 施設 ID
 * @param {Array<{date: string}>} schedules - parseScraperSheetValues の戻り値
 * @private
 */
function _saveScrapedMonths(facilityId, schedules) {
  // "YYYY-MM" の重複なし一覧を作る
  var monthMap = {};
  for (var i = 0; i < schedules.length; i++) {
    var date = schedules[i].date; // "YYYY-MM-DD"
    if (date && date.length >= 7) {
      var ym = date.substring(0, 7); // "YYYY-MM"
      monthMap[ym] = true;
    }
  }

  // キーを配列にしてソート
  var months = [];
  for (var ym in monthMap) {
    if (monthMap.hasOwnProperty(ym)) {
      months.push(ym);
    }
  }
  months.sort();

  var key = SCRAPED_MONTHS_KEY_PREFIX + facilityId;
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(months));
  console.log('[INFO] _saveScrapedMonths: facilityId=' + facilityId + ' → ' + JSON.stringify(months));
}

/**
 * IMPORTHTML シートの 2D 配列からバドミントン開放スケジュールを抽出する
 *
 * IMPORTHTML はテーブルのデータ行のみをインポートするため、
 * 年・月は new Date() から取得する(ページの「2026年5月」形式テキストは取得不可)。
 *
 * テーブル構造(確認済み・D-016):
 *   列0: 日(例: "2日", "23日")
 *   列1: 曜日(例: "木", "土")
 *   列2: 個人開放バドミントン
 *   列3: 個人開放卓球
 *   列4: 個人利用ランニングコース
 *   列5: 備考
 *
 * @param {Array<Array>} values - sheet.getDataRange().getValues() の戻り値(2D 配列)
 * @param {string} facilityName - 施設名(返却オブジェクトの facilityName に使用)
 * @returns {Array<{date: string, startTime: string, endTime: string, facilityName: string, note: string}>}
 */
function parseScraperSheetValues(values, facilityName) {
  var results = [];
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1; // getMonth() は 0-based なので +1

  // ─── バドミントン列インデックスをヘッダー行から探す ───
  // 最初の HEADER_SEARCH_LIMIT 行以内で「バドミントン」を含む列を探す
  var badmintonCol = DEFAULT_BADMINTON_COL;
  var headerFound = false;

  for (var r = 0; r < Math.min(HEADER_SEARCH_LIMIT, values.length); r++) {
    var row = values[r];
    for (var c = 0; c < row.length; c++) {
      var cellStr = String(row[c]).trim();
      if (cellStr.indexOf('バドミントン') !== -1) {
        badmintonCol = c;
        headerFound = true;
        console.log('[INFO] parseScraperSheetValues: ' + facilityName + ' バドミントン列を発見: 列' + c + ' (行' + r + ')');
        break;
      }
    }
    if (headerFound) {
      break;
    }
  }

  if (!headerFound) {
    console.log('[WARN] parseScraperSheetValues: ' + facilityName + ' バドミントン列が見つかりません。デフォルト列' + DEFAULT_BADMINTON_COL + 'を使用します。');
  }

  // ─── データ行をループ ───
  // prevDay: 直前のデータ行の「日」の値。月またぎ検知に使う(D-018 修正)
  // 月またぎ判定: 今の日(dayNum)が直前の日(prevDay)より大きく減った場合 → 月が変わった
  // 例: 31日 → 1日 のように dayNum < prevDay のときに month を 1 増やす
  var prevDay = null;

  for (var i = 0; i < values.length; i++) {
    var dataRow = values[i];

    // 列0のテキストを取り出す
    var col0Text = String(dataRow[0]).trim();

    // /^(\d{1,2})日/ にマッチしない行はスキップ(ヘッダー行・空行など)
    var dateMatch = col0Text.match(/^(\d{1,2})日/);
    if (!dateMatch) {
      continue;
    }

    var dayNum = parseInt(dateMatch[1], 10);

    // 月またぎ検知(D-018): 直前の日より15日以上減った場合のみ翌月と判定する
    // しきい値15: 同月内で15日以上後退する暦上のケースはないため誤検知を防ぐ
    if (prevDay !== null && (prevDay - dayNum) > 15) {
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
      console.log('[INFO] parseScraperSheetValues: ' + facilityName + ' 月またぎを検知(' + prevDay + '日 → ' + dayNum + '日)。' + year + '-' + ('0' + month).slice(-2) + ' に移行。');
    }
    prevDay = dayNum;

    var fullDate = _buildDate(year, month, dayNum);

    // バドミントン列の値を取得
    if (badmintonCol >= dataRow.length) {
      continue; // 行の列数が足りない場合はスキップ
    }
    var cellText = String(dataRow[badmintonCol]).trim();

    // × 始まり / 休館日 / 空 / ー /  などは除外
    if (_isExcluded(cellText)) {
      continue;
    }

    // 〇 / ○ / △ 始まりでなければスキップ
    if (!_isValid(cellText)) {
      continue;
    }

    // 時刻を抽出
    var times = _extractTimesFromCell(cellText);

    // note を生成
    var note = _buildNoteFromCell(cellText);

    results.push({
      date: fullDate,
      startTime: times.startTime,
      endTime: times.endTime,
      facilityName: facilityName,
      note: note
    });
  }

  return results;
}

// ─────────────────────────────────────────────
// F-2-2: 更新検知による自動起動
// ─────────────────────────────────────────────

/**
 * 更新検知 → スクレイピング → 質問配信 のメインフロー
 *
 * GAS の time-based trigger から毎朝 7 時に呼ばれる。
 * 処理の流れ:
 *   1. enabled な施設それぞれの IMPORTHTML シートを読み込む
 *   2. 前回取得時の SHA-256 ハッシュ(ScriptProperties に保存)と比較する
 *   3. 1 つでも変化があれば scrapeAllFacilities() → handleDistributeSurvey() を実行
 *   4. 変化がなければ何もしない
 *   5. 新しいハッシュを ScriptProperties に保存する
 *
 * ハッシュキー名(D-013 で確定):
 *   'HASH_FACILITY_<facilityId>' — 例: 'HASH_FACILITY_420'
 *
 * シートが存在しない施設はスキップ(setupScraperSheets 未実行でも他施設は続行)。
 *
 * @returns {{updated: boolean, changedFacilities: Array<number>}}
 */
function checkAndScrapeIfUpdated() {
  var changedFacilities = [];
  var newHashes = {};

  var spreadsheetId = getProperty('MEMBERS_SPREADSHEET_ID');
  if (!spreadsheetId) {
    logError(new Error('MEMBERS_SPREADSHEET_ID が設定されていません。'), { phase: 'checkAndScrapeIfUpdated' });
    return { updated: false, changedFacilities: [] };
  }
  var ss = SpreadsheetApp.openById(spreadsheetId);

  // ─── 各施設のシート内容を取得してハッシュを計算 ───
  for (var i = 0; i < FACILITIES.length; i++) {
    var facility = FACILITIES[i];

    if (!facility.enabled || !facility.sheetName) {
      continue; // 無効施設はスキップ
    }

    var sheet = ss.getSheetByName(facility.sheetName);
    if (!sheet) {
      // setupScraperSheets 未実行の場合はログを出してスキップ(エラーにしない)
      console.log('[WARN] checkAndScrapeIfUpdated: ' + facility.sheetName + ' シートが存在しません。setupScraperSheets() を実行してください。');
      continue;
    }

    try {
      var values = sheet.getDataRange().getValues();
      // JSON.stringify でシート内容全体をテキスト化してハッシュ計算
      var sheetText = JSON.stringify(values);
      var newHash = _computeSha256Hex(sheetText);
      newHashes[facility.facilityId] = newHash;

      // 前回ハッシュと比較
      var hashKey = HASH_KEY_PREFIX + facility.facilityId;
      var prevHash = getProperty(hashKey);

      if (prevHash !== newHash) {
        changedFacilities.push(facility.facilityId);
        console.log('[INFO] checkAndScrapeIfUpdated: ' + facility.facilityName + ' の更新を検知しました。');
      }
    } catch (err) {
      logError(err, { phase: 'checkAndScrapeIfUpdated.hash', facilityId: facility.facilityId });
      // 取得失敗の施設は変化なしとして扱う(前回データを維持)
    }
  }

  // ─── 更新があれば scrape + 配信 ───
  if (changedFacilities.length > 0) {
    console.log('[INFO] checkAndScrapeIfUpdated: ' + changedFacilities.length + ' 施設で更新を検知。スクレイピングを実行します。');

    try {
      // skipDailyCheck=true: シート変化が確認済みなので 1 日 1 回制限をスキップ
      scrapeAllFacilities(true);
    } catch (scrapeErr) {
      logError(scrapeErr, { phase: 'checkAndScrapeIfUpdated.scrape' });
    }

    // 新月検知・通知(D-018 F-2-5)
    // scrapeAllFacilities 実行後に SCRAPED_MONTHS_FACILITY_* が更新済みであることを前提とする
    try {
      _checkAndNotifyNewMonths();
    } catch (notifyErr) {
      logError(notifyErr, { phase: 'checkAndScrapeIfUpdated.notify' });
    }

    try {
      var currentMonth = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
      var autoDistributedMonth = getProperty('SURVEY_AUTO_DISTRIBUTED_MONTH') || '';
      if (autoDistributedMonth !== currentMonth) {
        handleDistributeSurvey();
        PropertiesService.getScriptProperties().setProperty('SURVEY_AUTO_DISTRIBUTED_MONTH', currentMonth);
        console.log('[INFO] checkAndScrapeIfUpdated: アンケートを自動配信しました(' + currentMonth + ')。');
      } else {
        console.log('[INFO] checkAndScrapeIfUpdated: アンケートは今月(' + currentMonth + ')既に自動配信済み。スキップします。');
      }
    } catch (distributeErr) {
      logError(distributeErr, { phase: 'checkAndScrapeIfUpdated.distribute' });
    }
  } else {
    console.log('[INFO] checkAndScrapeIfUpdated: 更新なし。何もしません。');
  }

  // ─── 新しいハッシュを保存(取得できた施設のみ) ───
  var props = PropertiesService.getScriptProperties();
  for (var facilityId in newHashes) {
    if (newHashes.hasOwnProperty(facilityId)) {
      props.setProperty(HASH_KEY_PREFIX + facilityId, newHashes[facilityId]);
    }
  }

  return { updated: changedFacilities.length > 0, changedFacilities: changedFacilities };
}

/**
 * checkAndScrapeIfUpdated を毎朝 7 時に実行するトリガーを設定する
 *
 * 既存トリガーがある場合は重複作成しない。
 * GAS のスクリプトエディタから 1 回だけ手動実行して設定する。
 *
 * 使い方:
 *   GAS エディタの「関数を選択」で setupDailyTrigger を選び「実行」ボタンを押す。
 *
 * @returns {void}
 */
function setupDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();

  // 既存トリガーを確認して重複作成を防ぐ
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TRIGGER_FUNCTION_NAME) {
      console.log('[INFO] setupDailyTrigger: トリガーは既に設定済みです。スキップします。');
      return;
    }
  }

  // 毎朝 TRIGGER_HOUR 時(7:00-8:00 の間)に実行するトリガーを作成
  ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME)
    .timeBased()
    .everyDays(1)
    .atHour(TRIGGER_HOUR)
    .create();

  console.log('[INFO] setupDailyTrigger: ' + TRIGGER_FUNCTION_NAME + ' のトリガーを毎朝 ' + TRIGGER_HOUR + ' 時に設定しました。');
}

// ─────────────────────────────────────────────
// 内部ユーティリティ
// ─────────────────────────────────────────────

/**
 * セル内容が「除外対象」かを判定する(内部用)
 *
 * 除外条件: × 始まり / ー / - / 空文字 / 「休館日」を含む / ー のみ
 *
 * @param {string} text - セルのテキスト(String().trim() 後)
 * @returns {boolean} true なら除外
 * @private
 */
function _isExcluded(text) {
  if (!text) {
    return true;
  }
  // × またはその全角変種(半角 x は含めない — IMPORTHTML では文字化けせず正確に × が取れる)
  if (/^[×✕]/.test(text)) {
    return true;
  }
  // ー(長音符)または半角ハイフンのみ
  if (/^[ー\-]$/.test(text)) {
    return true;
  }
  // 「休館日」を含む場合はスキップ
  if (text.indexOf('休館日') !== -1) {
    return true;
  }
  return false;
}

/**
 * セル内容が「有効」(〇 / ○ / △)かを判定する(内部用)
 *
 * @param {string} text
 * @returns {boolean} true なら有効
 * @private
 */
function _isValid(text) {
  // 〇・○・△ のいずれかで始まる
  return /^[〇○△]/.test(text);
}

/**
 * セルテキストから開始・終了時刻を抽出する(内部用)
 *
 * 対応パターン:
 *   パターン1: "9-11" / "9〜11" / "9～11" / "13‐21" 形式(コロンなしの時刻範囲)
 *     対象区切り文字: 半角ハイフン(-) / 全角ハイフン(－) / 波ダッシュ(〜～) / Unicodeハイフン(‐ U+2010)
 *     「9日」などとの誤マッチを防ぐため後方否定先読みで「日」を除外
 *     時刻が 0〜24 の範囲なら有効(それ以外は 終日 にフォールバック)
 *   パターン2: "18:00〜20:00" 形式(コロンあり HH:mm 形式)
 *   上記なし: startTime / endTime ともに "終日"
 *
 * @param {string} text
 * @returns {{ startTime: string, endTime: string }}
 * @private
 */
function _extractTimesFromCell(text) {
  // パターン2: "HH:mm〜HH:mm" 形式(先にチェック・より具体的なパターン)
  var colonRange = text.match(/(\d{1,2}:\d{2})[〜\-～](\d{1,2}:\d{2})/);
  if (colonRange) {
    return { startTime: colonRange[1], endTime: colonRange[2] };
  }

  // パターン1: "9-11" / "9〜11" / "13‐21" 形式(コロンなし)
  // [－\-〜～‐] = 全角ハイフン / 半角ハイフン / 波ダッシュ2種 / Unicode U+2010 ハイフン
  // 後方否定先読み (?![\d日]) で "9日" や "11-12日" との誤マッチを防ぐ
  var hourRange = text.match(/(\d{1,2})[－\-〜～‐](\d{1,2})(?![\d日])/);
  if (hourRange) {
    var startH = parseInt(hourRange[1], 10);
    var endH = parseInt(hourRange[2], 10);
    // 時刻が 0〜24 の範囲であることを確認
    if (startH >= 0 && startH <= 24 && endH >= 0 && endH <= 24) {
      var startStr = (startH < 10 ? '0' : '') + startH + ':00';
      var endStr = (endH < 10 ? '0' : '') + endH + ':00';
      return { startTime: startStr, endTime: endStr };
    }
  }

  // どちらにもマッチしない場合は「終日」
  return { startTime: '終日', endTime: '終日' };
}

/**
 * セルテキストから note(備考)を生成する(内部用)
 *
 * 処理の流れ:
 *   1. "△" のみ → "要確認" を返す
 *   2. "△ + テキスト" → △ 以降のテキスト部分を返す(空なら "要確認")
 *   3. "〇/○" 始まり → 記号・時刻部分を除去した残りを返す
 *
 * @param {string} text
 * @returns {string}
 * @private
 */
function _buildNoteFromCell(text) {
  // △ 始まりの処理
  if (/^△/.test(text)) {
    var afterDelta = text.match(/^△\s*(.*)/);
    if (afterDelta) {
      // △ 以降のテキストから時刻部分を除去する(○ の処理と同じルール)
      // 例: "13‐21中体育室" → "中体育室" / "18時頃開放予定" → そのまま保持
      var deltaRemainder = afterDelta[1]
        .replace(/\d{1,2}:\d{2}[〜\-～]\d{1,2}:\d{2}/g, ' ')   // "HH:mm〜HH:mm" 形式を除去
        .replace(/\d{1,2}:\d{2}/g, ' ')                          // 単体時刻を除去
        .replace(/\d{1,2}[－\-〜～‐]\d{1,2}(?![\d日])/g, ' ')  // "9-11" / "13‐21" 形式を除去
        .replace(/\s+/g, ' ')
        .trim();
      return deltaRemainder || '要確認';
    }
    return '要確認';
  }

  // 〇 / ○ 始まりの処理
  // 時刻パターンはスペースに置き換えてから正規化する(除去すると前後の単語が詰まるため)
  var cleaned = text
    .replace(/^[〇○]/, '')                                    // 先頭の記号を除去
    .replace(/\d{1,2}:\d{2}[〜\-～]\d{1,2}:\d{2}/g, ' ')    // "HH:mm〜HH:mm" 形式をスペースに置換
    .replace(/\d{1,2}:\d{2}/g, ' ')                          // 単体時刻をスペースに置換
    .replace(/\d{1,2}[－\-〜～‐]\d{1,2}(?![\d日])/g, ' ')   // "9-11" / "13‐21" 形式をスペースに置換
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

/**
 * 年・月・日から YYYY-MM-DD 形式の日付文字列を返す(内部用)
 *
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string} 例: '2026-05-15'
 * @private
 */
function _buildDate(year, month, day) {
  var mm = ('0' + month).slice(-2);
  var dd = ('0' + day).slice(-2);
  return year + '-' + mm + '-' + dd;
}

/**
 * 文字列の SHA-256 ハッシュを 16 進文字列で返す(内部用)
 *
 * Utilities.computeDigest は byte 配列を返すため、16 進文字列に変換する。
 * byte は -128〜127 の符号付き整数なので、負の場合は 256 を足して 0〜255 に変換する。
 *
 * @param {string} text
 * @returns {string} SHA-256 の 16 進文字列(64 文字)
 * @private
 */
function _computeSha256Hex(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var hex = (b < 0 ? b + 256 : b).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

/**
 * 施設の連続失敗カウントをリセットする(内部用)
 *
 * @param {number} facilityId
 * @private
 */
function _resetFailCount(facilityId) {
  PropertiesService.getScriptProperties()
    .setProperty(FAIL_COUNT_KEY_PREFIX + facilityId, '0');
}

/**
 * 施設の連続失敗カウントを加算し、しきい値超えなら管理者通知を送る(内部用)
 *
 * 連続失敗カウントのキー: 'FAIL_COUNT_FACILITY_<facilityId>'
 * FAIL_THRESHOLD(3) に達したら pushText で管理者に通知する。
 * 管理者の userId は ScriptProperties 'ADMIN_USER_ID' から取得する。
 *
 * @param {{ facilityId: number, facilityName: string }} facility
 * @private
 */
function _incrementFailCountAndNotifyIfNeeded(facility) {
  var key = FAIL_COUNT_KEY_PREFIX + facility.facilityId;
  var currentCount = parseInt(getProperty(key) || '0', 10);
  var newCount = currentCount + 1;
  PropertiesService.getScriptProperties().setProperty(key, String(newCount));

  if (newCount >= FAIL_THRESHOLD) {
    console.log('[WARN] ' + facility.facilityName + ' が ' + newCount + ' 日連続でスクレイピングに失敗しています。管理者に通知します。');
    var adminUserId = getProperty('ADMIN_USER_ID');
    if (adminUserId) {
      try {
        pushText(
          adminUserId,
          '[Bot 警告] ' + facility.facilityName + ' のスケジュール取得が ' + newCount + ' 日連続で失敗しています。シートの IMPORTHTML を確認してください。'
        );
      } catch (notifyErr) {
        logError(notifyErr, { phase: '_incrementFailCountAndNotifyIfNeeded.push', facilityId: facility.facilityId });
      }
    }
  }
}

// ─────────────────────────────────────────────
// F-2-5: 新月検知・通知ロジック
// ─────────────────────────────────────────────

/**
 * 全施設を対象に新月の公開を検知し、メンバーへ通知する(内部用・D-018)
 *
 * 処理の流れ:
 *   1. FACILITIES の enabled: true な施設をループ
 *   2. SCRAPED_MONTHS_FACILITY_<id> を読む(なければスキップ)
 *   3. LAST_NOTIFIED_MONTH_FACILITY_<id> を読む(なければ空文字)
 *   4. スクレイピングで得た月のうち lastNotified より大きいものがあれば新月ありと判定
 *   5. 新月が見つかった施設に対して _notifyNewFacilityMonth() を呼ぶ
 *   6. LAST_NOTIFIED_MONTH_FACILITY_<id> を新月に更新
 *   7. 全 enabled 施設の LAST_NOTIFIED_MONTH_FACILITY_<id> が同じ値になったら
 *      ALL_FACILITIES_NOTIFIED_MONTH と比較して新規なら _notifyAllFacilitiesReady() を呼ぶ
 *   8. ALL_FACILITIES_NOTIFIED_MONTH を更新
 *
 * エラーポリシー(D-018): 各施設の通知失敗は logError で記録して次の施設へ続行する
 *
 * @private
 */
function _checkAndNotifyNewMonths() {
  var props = PropertiesService.getScriptProperties();

  for (var i = 0; i < FACILITIES.length; i++) {
    var facility = FACILITIES[i];
    if (!facility.enabled) {
      continue;
    }

    // ScriptProperties から SCRAPED_MONTHS_FACILITY_<id> を読む
    var scrapedKey = SCRAPED_MONTHS_KEY_PREFIX + facility.facilityId;
    var scrapedRaw = props.getProperty(scrapedKey);
    if (!scrapedRaw) {
      // スクレイピング結果が保存されていない場合はスキップ
      console.log('[INFO] _checkAndNotifyNewMonths: ' + facility.facilityName + ' の SCRAPED_MONTHS が未設定。スキップします。');
      continue;
    }

    var scrapedMonths;
    try {
      scrapedMonths = JSON.parse(scrapedRaw);
    } catch (parseErr) {
      logError(parseErr, { phase: '_checkAndNotifyNewMonths.parse', facilityId: facility.facilityId });
      continue;
    }

    if (!scrapedMonths || scrapedMonths.length === 0) {
      continue;
    }

    // LAST_NOTIFIED_MONTH_FACILITY_<id> を読む(なければ空文字)
    var lastNotifiedKey = LAST_NOTIFIED_MONTH_KEY_PREFIX + facility.facilityId;
    var lastNotified = props.getProperty(lastNotifiedKey) || '';

    // scrapedMonths のうち lastNotified より大きい最小の月(次の未通知月)を探す
    // scrapedMonths はソート済みなので最初にヒットした値が最も古い未通知月
    // 複数月まとめてスクレイピングされた場合も順番通りに1件ずつ処理する
    var newMonth = null;
    for (var j = 0; j < scrapedMonths.length; j++) {
      if (scrapedMonths[j] > lastNotified) {
        newMonth = scrapedMonths[j];
        break;
      }
    }

    if (!newMonth) {
      console.log('[INFO] _checkAndNotifyNewMonths: ' + facility.facilityName + ' に新月なし(lastNotified=' + lastNotified + ')');
      continue;
    }

    // 新月あり → 施設ごと通知 + lastNotified を更新
    console.log('[INFO] _checkAndNotifyNewMonths: ' + facility.facilityName + ' に新月を検知。' + newMonth + ' の通知を送ります。');
    try {
      _notifyNewFacilityMonth(facility, newMonth);
    } catch (notifyErr) {
      logError(notifyErr, { phase: '_checkAndNotifyNewMonths.notifyFacility', facilityId: facility.facilityId });
      // 通知失敗でも lastNotified は更新しない(次回再試行できるように)
      continue;
    }
    props.setProperty(lastNotifiedKey, newMonth);
  }

  // ─── 全施設揃い通知の判定 ───
  // 全 enabled 施設の LAST_NOTIFIED_MONTH_FACILITY_<id> が同じ値かチェック
  var allNotifiedMonth = _getCommonLastNotifiedMonth(props);
  if (!allNotifiedMonth) {
    // 全施設が揃っていない(施設ごとに異なる月または未設定)
    return;
  }

  var allFacilitiesNotified = props.getProperty(ALL_FACILITIES_NOTIFIED_MONTH_KEY) || '';
  if (allFacilitiesNotified === allNotifiedMonth) {
    // 全施設揃い通知は既に送済み
    console.log('[INFO] _checkAndNotifyNewMonths: 全施設揃い通知は送済み(' + allNotifiedMonth + ')。スキップします。');
    return;
  }

  // 新規の全施設揃い通知
  console.log('[INFO] _checkAndNotifyNewMonths: 全施設で ' + allNotifiedMonth + ' が揃いました。全施設揃い通知を送ります。');
  try {
    _notifyAllFacilitiesReady(allNotifiedMonth);
  } catch (allNotifyErr) {
    logError(allNotifyErr, { phase: '_checkAndNotifyNewMonths.notifyAll' });
    // 通知失敗時は ALL_FACILITIES_NOTIFIED_MONTH を更新しない(次回再試行)
    return;
  }
  props.setProperty(ALL_FACILITIES_NOTIFIED_MONTH_KEY, allNotifiedMonth);
}

/**
 * 全 enabled 施設の LAST_NOTIFIED_MONTH_FACILITY_<id> が同じ値かチェックする(内部用)
 *
 * 全施設が同じ YYYY-MM を持っていればその値を、揃っていなければ null を返す。
 * enabled 施設が 1 件もない場合も null を返す。
 *
 * @param {GoogleAppsScript.Properties.Properties} props - PropertiesService.getScriptProperties()
 * @returns {string|null} 全施設共通の YYYY-MM、揃っていなければ null
 * @private
 */
function _getCommonLastNotifiedMonth(props) {
  var commonMonth = null;
  var enabledCount = 0;

  for (var i = 0; i < FACILITIES.length; i++) {
    var facility = FACILITIES[i];
    if (!facility.enabled) {
      continue;
    }
    enabledCount++;

    var key = LAST_NOTIFIED_MONTH_KEY_PREFIX + facility.facilityId;
    var month = props.getProperty(key) || '';

    if (!month) {
      // 未設定施設がある場合は揃っていない
      return null;
    }

    if (commonMonth === null) {
      commonMonth = month;
    } else if (commonMonth !== month) {
      // 施設間で値が異なる
      return null;
    }
  }

  // enabled 施設が 0 件 または 全施設が同じ値
  return enabledCount > 0 ? commonMonth : null;
}

/**
 * 施設の新月公開をグループトークに通知する(内部用・D-018 / F-5 グループ送信対応)
 *
 * F-5 変更点:
 *   全 active メンバーへの個別 Push から「グループに 1 通」に変更。
 *   グループ ID が未設定の場合はログのみ・処理をスキップ(エラーにしない)。
 *
 * メッセージ形式: "<施設名>の<月>月分が公開されました！"
 *
 * @param {{ facilityId: number, facilityName: string }} facility - 施設情報
 * @param {string} yearMonth - "YYYY-MM" 形式(例: "2026-06")
 * @private
 */
function _notifyNewFacilityMonth(facility, yearMonth) {
  // "YYYY-MM" から月の数字を取り出す(先頭ゼロ除去のため parseInt を使う)
  var monthLabel = parseInt(yearMonth.split('-')[1], 10);
  var message = facility.facilityName + 'の' + monthLabel + '月分が公開されました！';

  // F-5: グループに 1 通送信する
  var groupId = getProperty('LINE_GROUP_ID');
  if (!groupId) {
    console.warn('[WARN] _notifyNewFacilityMonth: LINE_GROUP_ID が未設定です。通知をスキップします。' +
                 ' facility=' + facility.facilityName + ' yearMonth=' + yearMonth);
    return;
  }

  console.log('[INFO] _notifyNewFacilityMonth: ' + facility.facilityName + ' ' + yearMonth + ' → グループ(' + groupId + ')に通知');
  try {
    pushText(groupId, message);
  } catch (pushErr) {
    logError(pushErr, {
      phase: '_notifyNewFacilityMonth.push',
      facilityId: facility.facilityId,
      yearMonth: yearMonth,
      groupId: groupId
    });
    // Push 失敗は例外として re-throw する(呼び出し元の _checkAndNotifyNewMonths が lastNotified 更新をスキップするため)
    throw pushErr;
  }
}

/**
 * 全施設の予定が揃ったことをグループトークに通知する(内部用・D-018 / F-5 グループ送信対応)
 *
 * F-5 変更点:
 *   全 active メンバーへの個別 Push から「グループに 1 通」に変更。
 *   グループ ID が未設定の場合はログのみ・処理をスキップ(エラーにしない)。
 *
 * メッセージ形式:
 *   "[<月>月の全施設の予定が揃いました！\n日程入力はこちら👇\nhttps://liff.line.me/<LIFF_FORM_ID>]"
 *   LIFF_FORM_ID が取得できない場合はリンク部分を省略してメッセージは送る
 *
 * @param {string} yearMonth - "YYYY-MM" 形式(例: "2026-06")
 * @private
 */
function _notifyAllFacilitiesReady(yearMonth) {
  var monthLabel = parseInt(yearMonth.split('-')[1], 10);
  var liffFormId = getProperty('LIFF_FORM_ID');

  var message = monthLabel + '月の全施設の予定が揃いました！';
  if (liffFormId) {
    message += '\n日程入力はこちら👇\nhttps://liff.line.me/' + liffFormId;
  }

  // F-5: グループに 1 通送信する
  var groupId = getProperty('LINE_GROUP_ID');
  if (!groupId) {
    console.warn('[WARN] _notifyAllFacilitiesReady: LINE_GROUP_ID が未設定です。通知をスキップします。' +
                 ' yearMonth=' + yearMonth);
    return;
  }

  console.log('[INFO] _notifyAllFacilitiesReady: ' + yearMonth + ' 全施設揃い通知 → グループ(' + groupId + ')に送信');
  try {
    pushText(groupId, message);
  } catch (pushErr) {
    logError(pushErr, {
      phase: '_notifyAllFacilitiesReady.push',
      yearMonth: yearMonth,
      groupId: groupId
    });
    // Push 失敗は例外として re-throw する(呼び出し元の _checkAndNotifyNewMonths が ALL_FACILITIES_NOTIFIED_MONTH 更新をスキップするため)
    throw pushErr;
  }
}
