/**
 * F1: スクレイピング機能
 *
 * 施設 HP（niigata-kaikou.jp）の個人開放スケジュールを
 * IMPORTHTML で取得・パースし schedules シートに書き込む。
 *
 * セットアップ手順（初回のみ）:
 *   1. GAS エディタで setupScraperSheets() を実行
 *      → scraper-413 / scraper-420 / scraper-429 / -next 版シートが作成される
 *   2. 数分待って IMPORTHTML のデータ読み込みが完了するのを確認
 *   3. debugScrapePreview() を実行して結果をデバッグページで確認
 *   4. scrapeAllFacilities() を実行して schedules シートに書き込み
 *   5. setupScraperTrigger() でタイムトリガーを設定
 *
 * 提供する関数（GAS エディタから手動実行可能）:
 *   - setupScraperSheets()    : IMPORTHTML シートを初期作成（1 回だけ）
 *   - resetSchedulesSheet()   : schedules シートを新スキーマでリセット（1 回だけ）
 *   - scrapeAllFacilities()   : 全施設スクレイピング → schedules シートに書き込み
 *   - debugScrapePreview()    : 書き込みなしのプレビュー JSON を返す（デバッグページ用）
 *   - setupScraperTrigger()   : 毎日午前 9 時トリガーをセットアップ（1 回だけ）
 *
 * 設計メモ:
 *   - UrlFetchApp は WAF にブロックされるため IMPORTHTML/IMPORTXML を使用（D-020）
 *   - schedules シートのスキーマは SPECIFICATION.md セクション 1-1 の新定義に従う
 *   - 亀田の end_time は D-024 のルールで計算する
 *   - floor_map_url の取得（D-022 / IMPORTXML）は別フェーズで追加予定
 */

// ─────────────────────────────────────────────
// 定数: 施設設定
// ─────────────────────────────────────────────

/**
 * スクレイピング対象施設の設定
 * 実際のアクティブ判定は settings シートの status 列で行う（D-021）
 */
var SCRAPER_FACILITIES = [
  {
    facilityId: '413',
    facilityName: '東総合スポーツセンター',
    url: 'https://niigata-kaikou.jp/facility/413/schedule',
    sheetName: 'scraper-413',
    nextSheetName: 'scraper-413-next'
  },
  {
    facilityId: '420',
    facilityName: '鳥屋野総合体育館',
    url: 'https://niigata-kaikou.jp/facility/420/schedule',
    sheetName: 'scraper-420',
    nextSheetName: 'scraper-420-next'
  },
  {
    facilityId: '429',
    facilityName: '亀田総合体育館',
    url: 'https://niigata-kaikou.jp/facility/429/schedule',
    sheetName: 'scraper-429',
    nextSheetName: 'scraper-429-next'
  }
];

// ─────────────────────────────────────────────
// 定数: schedules シート（新スキーマ）
// ─────────────────────────────────────────────

/** schedules シート名 */
var SCHED_SHEET_NAME = 'schedules';

/**
 * schedules シートのヘッダー列（SPECIFICATION.md セクション 1-1）
 *
 * 主キー: (date, start_time, facility_name) の 3 列で一意性を保証する
 */
var SCHED_HEADER = [
  'date',          // A: YYYY-MM-DD
  'start_time',    // B: HH:MM
  'end_time',      // C: HH:MM
  'facility_name', // D: 施設名
  'pattern',       // E: A/B/C/D
  'scraped_at',    // F: ISO datetime（スクレイピング実行日時）
  'floor_map_url'  // G: URL or '' （D-022: 将来 IMPORTXML で取得予定）
];

/** バドミントン列を探す先頭最大行数 */
var SCHED_HEADER_ROWS = 5;

/** バドミントン列が見つからない場合のデフォルト列インデックス（0-based）*/
var SCHED_BADMINTON_COL_DEFAULT = 2;

// ─────────────────────────────────────────────
// パブリック関数
// ─────────────────────────────────────────────

/**
 * IMPORTHTML 用スクレイパーシートを初期セットアップする（1 回だけ実行）
 *
 * 各施設の当月シート（scraper-XXX）と翌月シート（scraper-XXX-next）を作成し、
 * A1 セルに IMPORTHTML 式を設定する。
 * 実行後、数分待って IMPORTHTML データが読み込まれてから
 * debugScrapePreview() で動作確認すること。
 */
function setupScraperSheets() {
  var ss = _getSpreadsheet();

  for (var i = 0; i < SCRAPER_FACILITIES.length; i++) {
    var f = SCRAPER_FACILITIES[i];

    // 当月シート: table,2 が個人開放スケジュール表
    _setImportHtmlSheet(ss, f.sheetName, f.url, 2);

    // 翌月シート: table,3 が翌月スケジュール（翌月未公開時は無害な内容が入る）
    _setImportHtmlSheet(ss, f.nextSheetName, f.url, 3);
  }

  console.log('[INFO] setupScraperSheets: 完了。' +
    '数分後にシートを確認し、データが入っていたら debugScrapePreview() を実行してください。');
}

/**
 * schedules シートを新スキーマでリセットする（1 回だけ実行）
 *
 * ⚠️ 既存データがすべて消えます。
 * 旧スキーマのデータが入っている場合にのみ実行してください。
 * 実行後は scrapeAllFacilities() でデータを再取得してください。
 */
function resetSchedulesSheet() {
  var ss = _getSpreadsheet();
  var sheet = ss.getSheetByName(SCHED_SHEET_NAME);
  if (sheet) {
    ss.deleteSheet(sheet);
    console.log('[INFO] resetSchedulesSheet: 旧 schedules シートを削除しました。');
  }
  _getOrInitSchedulesSheet(ss);
  console.log('[INFO] resetSchedulesSheet: 新スキーマで schedules シートを再作成しました。');
}

/**
 * 全施設をスクレイピングして schedules シートに書き込む
 *
 * settings シートの status = 'active' の施設のみ対象（D-021）。
 * GAS タイムトリガー（午前 9〜10 時）から呼ぶ。
 * エラー時はグループに MSG-ERR-01 を送信する。
 *
 * @returns {{ saved: number, errors: Array<string> }}
 */
function scrapeAllFacilities() {
  var ss = _getSpreadsheet();
  var activeIds = _getActiveFacilityIds(ss);

  var totalSaved = 0;
  var errors = [];

  for (var i = 0; i < SCRAPER_FACILITIES.length; i++) {
    var f = SCRAPER_FACILITIES[i];

    if (activeIds.indexOf(f.facilityId) === -1) {
      console.log('[INFO] scrapeAllFacilities: ' + f.facilityName + ' は active でないためスキップ');
      continue;
    }

    try {
      var rows = _scrapeFacility(f, ss);
      _upsertScheduleRows(rows, ss);
      totalSaved += rows.length;
      console.log('[INFO] scrapeAllFacilities: ' + f.facilityName + ' → ' + rows.length + ' 件保存');
    } catch (err) {
      logError(err, { phase: 'scrapeAllFacilities', facilityId: f.facilityId });
      errors.push(f.facilityName + ': ' + err.message);
    }
  }

  // スクレイピング失敗があればグループ通知（MSG-ERR-01）
  if (errors.length > 0) {
    var groupId = getProperty('LINE_GROUP_ID');
    if (groupId) {
      try {
        pushText(
          groupId,
          'スケジュール取得に失敗しました。前回のデータを保持しています。\n' + errors.join('\n')
        );
      } catch (pushErr) {
        logError(pushErr, { phase: 'scrapeAllFacilities.notify' });
      }
    }
  }

  console.log('[INFO] scrapeAllFacilities 完了: saved=' + totalSaved + ' errors=' + errors.length);
  return { saved: totalSaved, errors: errors };
}

/**
 * スクレイピング結果のプレビューを返す（schedules シートには書かない）
 *
 * デバッグページ（docs/debug.html）から doGet 経由で呼ばれる。
 * GAS エディタから手動実行しても動作確認できる（Logger で確認）。
 *
 * @returns {{ ok: boolean, generatedAt: string, facilities: Array, errors: Array }}
 */
function debugScrapePreview() {
  var ss = _getSpreadsheet();
  var result = {
    ok: true,
    generatedAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    facilities: [],
    errors: []
  };

  for (var i = 0; i < SCRAPER_FACILITIES.length; i++) {
    var f = SCRAPER_FACILITIES[i];
    try {
      var rows = _scrapeFacility(f, ss);
      result.facilities.push({
        facilityId: f.facilityId,
        facilityName: f.facilityName,
        rowCount: rows.length,
        rows: rows
      });
    } catch (err) {
      result.errors.push({
        facilityId: f.facilityId,
        facilityName: f.facilityName,
        error: err.message
      });
      result.ok = false;
    }
  }

  return result;
}

/**
 * 毎日スクレイパーを実行するトリガーをセットアップする（1 回だけ実行）
 *
 * 午前 9〜10 時のタイムトリガーを設定する（D-007）。
 * 既存の scrapeAllFacilities トリガーがある場合は削除してから再作成する。
 */
function setupScraperTrigger() {
  var FUNC = 'scrapeAllFacilities';
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === FUNC) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger(FUNC).timeBased().atHour(9).everyDays(1).create();
  console.log('[INFO] setupScraperTrigger: scrapeAllFacilities の毎日午前 9 時トリガーをセットしました。');
}

// ─────────────────────────────────────────────
// 内部関数: スクレイピング本体
// ─────────────────────────────────────────────

/**
 * 1 施設のスクレイピング処理（当月 + 翌月）
 *
 * @param {{ facilityId, facilityName, sheetName, nextSheetName }} facilityConfig
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Array<Object>}
 * @private
 */
function _scrapeFacility(facilityConfig, ss) {
  var scrapedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
  var rows = [];

  // 当月シート
  var sheet = ss.getSheetByName(facilityConfig.sheetName);
  if (!sheet) {
    throw new Error(
      facilityConfig.sheetName + ' シートが見つかりません。' +
      'setupScraperSheets() を実行してください。'
    );
  }
  var values = sheet.getDataRange().getValues();
  if (values && values.length > 0) {
    rows = rows.concat(
      _parseTableToRows(values, facilityConfig.facilityId, facilityConfig.facilityName, 0, scrapedAt)
    );
  } else {
    console.log('[WARN] _scrapeFacility: ' + facilityConfig.sheetName +
      ' が空です。IMPORTHTML の読み込みを確認してください。');
  }

  // 翌月シート（なければ無視）
  var nextSheet = ss.getSheetByName(facilityConfig.nextSheetName);
  if (nextSheet) {
    try {
      var nextValues = nextSheet.getDataRange().getValues();
      if (nextValues && nextValues.length > 0) {
        var nextRows = _parseTableToRows(
          nextValues, facilityConfig.facilityId, facilityConfig.facilityName, 1, scrapedAt
        );
        if (nextRows.length > 0) {
          rows = rows.concat(nextRows);
          console.log('[INFO] _scrapeFacility: ' + facilityConfig.facilityName +
            ' 翌月シートから ' + nextRows.length + ' 件取得');
        }
      }
    } catch (nextErr) {
      // 翌月シートのエラーは無視して当月分だけ返す
      console.log('[WARN] _scrapeFacility: 翌月シート読み込みエラー（当月分は取得済み）: ' + nextErr.message);
    }
  }

  return rows;
}

/**
 * IMPORTHTML テーブル（2D 配列）からスケジュール行を抽出する
 *
 * テーブル構造（旧コードで確認済み）:
 *   列 0: 日（例: "2日", "23日"）
 *   列 1: 曜日（例: "木", "土"）
 *   列 2: 個人開放バドミントン（セル表記は D-020 参照）
 *   列 3: 個人開放卓球
 *   列 4+: その他
 *
 * @param {Array<Array>} values
 * @param {string} facilityId
 * @param {string} facilityName
 * @param {number} monthOffset - 0: 当月 / 1: 翌月
 * @param {string} scrapedAt - ISO datetime
 * @returns {Array<Object>}
 * @private
 */
function _parseTableToRows(values, facilityId, facilityName, monthOffset, scrapedAt) {
  var results = [];

  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1 + (monthOffset || 0);
  if (month > 12) { month -= 12; year++; }

  var badmintonCol = _findBadmintonCol(values);
  var prevDay = null;

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var col0 = String(row[0] || '').trim();

    // "X日" 形式の行だけ処理する（ヘッダー行・空行をスキップ）
    var dayMatch = col0.match(/^(\d{1,2})日/);
    if (!dayMatch) continue;

    var dayNum = parseInt(dayMatch[1], 10);

    // 月またぎ検知: 前日より 15 日以上小さくなったら翌月に繰り上げる
    if (prevDay !== null && (prevDay - dayNum) > 15) {
      month++;
      if (month > 12) { month = 1; year++; }
      console.log('[INFO] _parseTableToRows: ' + facilityName +
        ' 月またぎ検知（' + prevDay + '日→' + dayNum + '日）。' +
        year + '-' + ('0' + month).slice(-2) + ' へ移行。');
    }
    prevDay = dayNum;

    var fullDate = _buildDateStr(year, month, dayNum);
    var cellText = (badmintonCol < row.length) ? String(row[badmintonCol] || '').trim() : '';

    if (_isUnavailable(cellText)) continue;

    var slots = _parseSlotsFromCell(cellText, facilityId, fullDate);

    if (slots.length === 0) {
      console.log('[WARN] _parseTableToRows: スロット抽出できず（スキップ）' +
        ' date=' + fullDate + ' text="' + cellText + '"');
      continue;
    }

    // 亀田のみ: end_time をルールで計算（D-024）
    if (facilityId === '429') {
      slots = _calcKamedaEndTimes(slots, fullDate);
    }

    for (var s = 0; s < slots.length; s++) {
      results.push({
        date: fullDate,
        start_time: slots[s].start_time,
        end_time: slots[s].end_time || '',
        facility_name: facilityName,
        pattern: slots[s].pattern,
        scraped_at: scrapedAt,
        floor_map_url: ''
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// 内部関数: セルテキストパーサー
// ─────────────────────────────────────────────

/**
 * 施設ごとのパーサーにルーティングする
 *
 * 先頭の ○/〇/△ プレフィックスを除去してからパーサーに渡す。
 *
 * @param {string} cellText
 * @param {string} facilityId
 * @param {string} date - 'YYYY-MM-DD'（終日スロットの終了時刻計算に使う）
 * @returns {Array<{start_time, end_time?, pattern}>}
 * @private
 */
function _parseSlotsFromCell(cellText, facilityId, date) {
  // ○/〇/△ プレフィックスを除去
  var text = cellText.replace(/^[○〇△◯]+\s*/, '').trim();

  if (facilityId === '420') return _parseSlotsForToya(text, date);
  if (facilityId === '413') return _parseSlotsForHigashi(text, date);
  if (facilityId === '429') return _parseSlotsForKameda(text);
  return [];
}

/**
 * 鳥屋野（420）セルパーサー
 *
 * セル例: "9-13大体育室 A / 13‐21中体育室 B"
 * 時間なし例: "A"  "終日A"（終日開放）
 * ハイフン 2 種対応: U+002D（半角）/ U+2010（Unicode）（D-020 警告）
 *
 * @param {string} text
 * @param {string} [date] - 'YYYY-MM-DD'（終日スロットの終了時刻計算に使う）
 * @returns {Array<{start_time, end_time, pattern}>}
 * @private
 */
function _parseSlotsForToya(text, date) {
  var slots = [];
  var parts = text.split('/');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    // 例: "9-13大体育室 A" / "13‐21中体育室 B"
    var m = part.match(/(\d{1,2})[\-‐](\d{1,2})[^\s]*\s+([A-D])/);
    if (m) {
      slots.push({
        start_time: _padHour(parseInt(m[1], 10)),
        end_time: _padHour(parseInt(m[2], 10)),
        pattern: m[3]
      });
    }
  }
  // フォールバック: 時間指定なしのパターン文字のみ（例: "A", "B", "終日A"）
  if (slots.length === 0) {
    var single = text.match(/([A-D])/i);
    if (single) {
      var endTime = (date && _isHolidayOrSunday(date)) ? '17:00' : '21:00';
      slots.push({ start_time: '09:00', end_time: endTime, pattern: single[1].toUpperCase() });
    }
  }
  return slots;
}

/**
 * 東総合（413）セルパーサー
 *
 * セル例: "9-17時 A / 17-21時 B"
 * 時間なし例: "B"  "終日B"（終日開放）
 *
 * @param {string} text
 * @param {string} [date] - 'YYYY-MM-DD'（終日スロットの終了時刻計算に使う）
 * @returns {Array<{start_time, end_time, pattern}>}
 * @private
 */
function _parseSlotsForHigashi(text, date) {
  var slots = [];
  var parts = text.split('/');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    // 例: "9-17時 A"
    var m = part.match(/(\d{1,2})[\-‐](\d{1,2})時\s*([A-D])/);
    if (m) {
      slots.push({
        start_time: _padHour(parseInt(m[1], 10)),
        end_time: _padHour(parseInt(m[2], 10)),
        pattern: m[3]
      });
    }
  }
  // フォールバック: 時間指定なしのパターン文字のみ（例: "B", "終日B"）
  if (slots.length === 0) {
    var single = text.match(/([A-D])/i);
    if (single) {
      var endTime = (date && _isHolidayOrSunday(date)) ? '17:00' : '21:00';
      slots.push({ start_time: '09:00', end_time: endTime, pattern: single[1].toUpperCase() });
    }
  }
  return slots;
}

/**
 * 亀田（429）セルパーサー
 *
 * セル例: "9時～Aパターン 19時～Cパターン"
 * 時間なし例: "A"  "終日A"  "Aパターン"（終日開放）
 * end_time はこの関数では返さない（_calcKamedaEndTimes で後から計算する）。
 * 波ダッシュ 3 種対応: U+301C / U+FF5E / U+007E（D-020）
 *
 * @param {string} text
 * @returns {Array<{start_time, pattern}>}  ← end_time は含まない
 * @private
 */
function _parseSlotsForKameda(text) {
  var slots = [];
  // ～ (U+FF5E), 〜 (U+301C), ~ (U+007E) いずれにも対応
  var re = /(\d{1,2})時[〜～~]([A-D])パターン/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    slots.push({
      start_time: _padHour(parseInt(m[1], 10)),
      pattern: m[2]
    });
  }
  // フォールバック: 時間指定なしのパターン文字のみ（例: "A", "終日A", "Aパターン"）
  // end_time は _calcKamedaEndTimes で計算するため不要
  if (slots.length === 0) {
    var single = text.match(/([A-D])/i);
    if (single) {
      slots.push({ start_time: '09:00', pattern: single[1].toUpperCase() });
    }
  }
  return slots;
}

/**
 * 亀田の end_time を計算する（D-024）
 *
 * ルール:
 *   - 同日に複数スロットがある場合: 次のスロットの start_time が end_time
 *   - 最終スロット: 平日（月〜土）→ '21:00' / 日曜・祝日 → '17:00'
 *
 * @param {Array<{start_time, pattern}>} slots
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {Array<{start_time, end_time, pattern}>}
 * @private
 */
function _calcKamedaEndTimes(slots, date) {
  if (!slots || slots.length === 0) return [];

  var result = [];
  for (var i = 0; i < slots.length; i++) {
    var endTime;
    if (i < slots.length - 1) {
      endTime = slots[i + 1].start_time;
    } else {
      endTime = _isHolidayOrSunday(date) ? '17:00' : '21:00';
    }
    result.push({
      start_time: slots[i].start_time,
      end_time: endTime,
      pattern: slots[i].pattern
    });
  }
  return result;
}

// ─────────────────────────────────────────────
// 内部関数: schedules シート読み書き
// ─────────────────────────────────────────────

/**
 * schedules シートに行を upsert する
 *
 * 主キー（date + start_time + facility_name）で既存行を上書き、
 * なければ末尾に追加する。バッチ処理で効率化。
 *
 * @param {Array<Object>} rows
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @private
 */
function _upsertScheduleRows(rows, ss) {
  if (!rows || rows.length === 0) return;

  var sheet = _getOrInitSchedulesSheet(ss);
  var lastRow = sheet.getLastRow();

  // 既存データを一括読み取り
  var existingData = [];
  var keyToIndex = {};
  if (lastRow >= 2) {
    existingData = sheet.getRange(2, 1, lastRow - 1, SCHED_HEADER.length).getValues();
    for (var e = 0; e < existingData.length; e++) {
      // 主キー: date(0) + start_time(1) + facility_name(3)
      var key = existingData[e][0] + '|' + existingData[e][1] + '|' + existingData[e][3];
      keyToIndex[key] = e;
    }
  }

  var newRows = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var rowData = [
      r.date, r.start_time, r.end_time, r.facility_name,
      r.pattern, r.scraped_at, r.floor_map_url || ''
    ];
    var rowKey = r.date + '|' + r.start_time + '|' + r.facility_name;

    if (keyToIndex.hasOwnProperty(rowKey)) {
      existingData[keyToIndex[rowKey]] = rowData;
    } else {
      newRows.push(rowData);
    }
  }

  // 既存行を一括書き戻し
  if (existingData.length > 0) {
    sheet.getRange(2, 1, existingData.length, SCHED_HEADER.length).setValues(existingData);
  }

  // 新規行を一括追加
  if (newRows.length > 0) {
    var startRow = (lastRow < 2 ? 2 : lastRow + 1);
    // 既存行を書き直した後のシートの最終行を再取得
    startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, newRows.length, SCHED_HEADER.length).setValues(newRows);
  }

  SpreadsheetApp.flush();
}

/**
 * schedules シートを取得する。存在しない場合は新スキーマで作成する。
 *
 * スキーマが古い場合はログで警告する（resetSchedulesSheet() の実行を促す）。
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 * @private
 */
function _getOrInitSchedulesSheet(ss) {
  var sheet = ss.getSheetByName(SCHED_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SCHED_SHEET_NAME);
    sheet.getRange(1, 1, 1, SCHED_HEADER.length).setValues([SCHED_HEADER]);
    sheet.getRange(1, 1, 1, SCHED_HEADER.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // 全列をテキスト書式に固定（日付・時刻の自動変換防止）
    sheet.getRange(1, 1, sheet.getMaxRows(), SCHED_HEADER.length).setNumberFormat('@');
    _setSchedulesColumnWidths(sheet);
    console.log('[INFO] _getOrInitSchedulesSheet: schedules シートを新規作成しました（新スキーマ）。');
    return sheet;
  }

  // 既存シートのスキーマを確認
  if (sheet.getLastRow() >= 1) {
    var existingHeader = sheet.getRange(1, 1, 1, SCHED_HEADER.length).getValues()[0];
    if (String(existingHeader[0]) !== 'date') {
      console.log('[WARN] _getOrInitSchedulesSheet: schedules シートが旧スキーマです。' +
        'resetSchedulesSheet() を実行して新スキーマに移行してください。');
    }
  }

  return sheet;
}

/**
 * schedules シートの列幅を見やすく設定する（内部用）
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @private
 */
function _setSchedulesColumnWidths(sheet) {
  sheet.setColumnWidth(1, 120); // date
  sheet.setColumnWidth(2, 80);  // start_time
  sheet.setColumnWidth(3, 80);  // end_time
  sheet.setColumnWidth(4, 200); // facility_name
  sheet.setColumnWidth(5, 60);  // pattern
  sheet.setColumnWidth(6, 200); // scraped_at
  sheet.setColumnWidth(7, 320); // floor_map_url
}

// ─────────────────────────────────────────────
// 内部関数: settings シート読み取り
// ─────────────────────────────────────────────

/**
 * settings シートから status='active' の facilityId 一覧を返す（D-021）
 *
 * settings シートが存在しない場合は全 SCRAPER_FACILITIES を対象とする
 * （後方互換・初期セットアップ前でも動作するよう）。
 *
 * settings シートの列構造（SPECIFICATION.md 1-5）:
 *   A: facility_id / B: facility_name / C: status / D: last_checked_at / E: notes
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @returns {Array<string>} facilityId の文字列配列
 * @private
 */
function _getActiveFacilityIds(ss) {
  var sheet = ss.getSheetByName('settings');
  if (!sheet || sheet.getLastRow() < 2) {
    console.log('[INFO] _getActiveFacilityIds: settings シートがないため全施設を対象とします。');
    return SCRAPER_FACILITIES.map(function (f) { return f.facilityId; });
  }

  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var activeIds = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][2]).trim() === 'active') {
      activeIds.push(String(values[i][0]).trim());
    }
  }
  return activeIds;
}

// ─────────────────────────────────────────────
// 内部関数: IMPORTHTML シート管理
// ─────────────────────────────────────────────

/**
 * スプレッドシートを取得する（内部用）
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 * @private
 */
function _getSpreadsheet() {
  var id = getProperty('MEMBERS_SPREADSHEET_ID');
  if (!id) {
    throw new Error('MEMBERS_SPREADSHEET_ID が ScriptProperties に設定されていません。');
  }
  return SpreadsheetApp.openById(id);
}

/**
 * IMPORTHTML 式を持つシートを作成・更新する（内部用）
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} sheetName
 * @param {string} url
 * @param {number} tableIndex
 * @private
 */
function _setImportHtmlSheet(ss, sheetName, url, tableIndex) {
  var sheet = ss.getSheetByName(sheetName);
  if (sheet) {
    sheet.clearContents();
  } else {
    sheet = ss.insertSheet(sheetName);
  }
  var formula = '=IMPORTHTML("' + url + '","table",' + tableIndex + ')';
  sheet.getRange('A1').setFormula(formula);
  console.log('[INFO] _setImportHtmlSheet: ' + sheetName + ' ← ' + formula);
}

/**
 * 2D 配列の先頭数行から「バドミントン」を含む列のインデックスを返す（内部用）
 *
 * @param {Array<Array>} values
 * @returns {number} 0-based 列インデックス
 * @private
 */
function _findBadmintonCol(values) {
  for (var r = 0; r < Math.min(SCHED_HEADER_ROWS, values.length); r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (String(values[r][c]).indexOf('バドミントン') !== -1) {
        return c;
      }
    }
  }
  console.log('[WARN] _findBadmintonCol: バドミントン列が見つかりません。' +
    'デフォルト列 ' + SCHED_BADMINTON_COL_DEFAULT + ' を使用します。');
  return SCHED_BADMINTON_COL_DEFAULT;
}

// ─────────────────────────────────────────────
// 内部関数: 汎用ユーティリティ
// ─────────────────────────────────────────────

/**
 * セルテキストが「利用不可」かどうかを判定する（内部用）
 *
 * @param {string} text
 * @returns {boolean}
 * @private
 */
function _isUnavailable(text) {
  if (!text || !text.trim()) return true;
  var t = text.trim();
  if (t === '-' || t === 'ー') return true;
  // × (利用不可) / 休 (休館) / 閉 (閉館) を含む場合は利用不可
  if (/[×]/.test(t)) return true;
  if (/休/.test(t)) return true;
  if (/閉/.test(t)) return true;
  return false;
}

/**
 * 年・月・日から 'YYYY-MM-DD' 形式の文字列を組み立てる（内部用）
 *
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string}
 * @private
 */
function _buildDateStr(year, month, day) {
  return year + '-' + ('0' + month).slice(-2) + '-' + ('0' + day).slice(-2);
}

/**
 * 時（0〜23 の整数）を 'HH:00' 形式に変換する（内部用）
 *
 * @param {number} hour
 * @returns {string}
 * @private
 */
function _padHour(hour) {
  return ('0' + hour).slice(-2) + ':00';
}

/**
 * 指定日が日曜日または祝日かどうかを判定する（内部用）
 *
 * D-024 の亀田 end_time 計算ルールで使用する。
 * CalendarApp が使えない場合は日曜判定のみで代替する。
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {boolean}
 * @private
 */
function _isHolidayOrSunday(date) {
  var d = new Date(date + 'T00:00:00+09:00');

  if (d.getDay() === 0) return true; // 日曜日

  // 日本祝日カレンダーで確認（D-024 推奨方法）
  try {
    var cal = CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com');
    if (cal) {
      var dayStart = new Date(date + 'T00:00:00+09:00');
      var dayEnd   = new Date(date + 'T23:59:59+09:00');
      return cal.getEvents(dayStart, dayEnd).length > 0;
    }
  } catch (calErr) {
    console.log('[WARN] _isHolidayOrSunday: カレンダー API エラー（日曜判定のみで代替）: ' + calErr.message);
  }

  return false;
}
