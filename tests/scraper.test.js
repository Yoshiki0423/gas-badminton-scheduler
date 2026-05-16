/**
 * @file tests/scraper.test.js
 *
 * scraper.js のパース系関数ユニットテスト
 *
 * テスト対象:
 *   - _extractTimesFromCell(text)       : セルテキストから時刻範囲を抽出
 *   - _isExcluded(text) / _isValid(text): セルの空き判定(依頼書の _isSlotAvailable に相当)
 *   - parseScraperSheetValues(values)   : 2D 配列 → スケジュール配列に変換
 *   - _checkAndNotifyNewMonths()        : 新月検知・通知フラグロジック
 *
 * GAS 固有 API は global.xxx = { ... } 形式でモックする。
 * src/ 以下のコードは一切変更しない。
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// GAS グローバル API モック
// ─────────────────────────────────────────────────────────────

// --- PropertiesService ---
// テストごとに書き込み・読み取りをシミュレートするためにインメモリストアを使う
let _propStore = {};

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (key) => _propStore[key] !== undefined ? _propStore[key] : null,
    setProperty: (key, value) => { _propStore[key] = value; },
    deleteProperty: (key) => { delete _propStore[key]; }
  })
};

// --- Logger ---
global.Logger = {
  log: jest.fn()
};

// --- console.log / warn は Node.js ネイティブを使うのでモック不要 ---
// ただしテスト出力を汚さないよう jest.spyOn で抑制する
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.warn.mockRestore();
});

// --- Utilities (SHA-256 等) ---
global.Utilities = {
  // テストでは使わないが scraper.js のトップレベルに参照がないため空実装で OK
};

// --- SpreadsheetApp ---
global.SpreadsheetApp = {
  openById: jest.fn()
};

// --- ScriptApp ---
global.ScriptApp = {
  getProjectTriggers: jest.fn(() => [])
};

// ─────────────────────────────────────────────────────────────
// scraper.js が依存するヘルパー関数のグローバルモック
// (scraper.js から呼ばれるが別ファイルに定義されている関数)
// ─────────────────────────────────────────────────────────────

// getProperty: ScriptProperties から値を取得するラッパー
global.getProperty = jest.fn((key) => _propStore[key] !== undefined ? _propStore[key] : null);

// logError: エラーログ(テストでは何もしない)
global.logError = jest.fn();

// pushText: LINE への Push 送信(テストではモック)
global.pushText = jest.fn();

// addSchedule: schedules シートへの書き込み(テストではモック)
global.addSchedule = jest.fn();

// withRetry: リトライ付き実行ラッパー(テストではコールバックをそのまま呼ぶ)
global.withRetry = jest.fn((fn) => fn());

// DEFAULT_MAX_ATTEMPTS: withRetry のデフォルト試行回数(scraper.js の定数)
global.DEFAULT_MAX_ATTEMPTS = 3;

// handleDistributeSurvey: アンケート配信(scraper.js から呼ばれる・テストでは空実装)
global.handleDistributeSurvey = jest.fn();

// ─────────────────────────────────────────────────────────────
// scraper.js を読み込む
// ─────────────────────────────────────────────────────────────
// GAS の var 宣言はグローバルスコープに展開される。
// Node.js で require すると module スコープになるが、
// GAS 形式の var 宣言はグローバルに「漏れ出る」ため、
// eval + fs.readFileSync で window(global)に展開する。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const scraperSrc = fs.readFileSync(
  path.join(__dirname, '../src/scraper.js'),
  'utf8'
);

// Jest の global オブジェクトをサンドボックスとして scraper.js を実行する。
// var 宣言が global のプロパティとして登録されるので、テスト内で直接呼び出せる。
vm.runInContext(scraperSrc, vm.createContext(global));

// ─────────────────────────────────────────────────────────────
// 各テストの前後処理
// ─────────────────────────────────────────────────────────────

beforeEach(() => {
  // PropertiesService のストアをリセット
  _propStore = {};
  // getProperty モックもストアに追従させる
  global.getProperty.mockImplementation((key) =>
    _propStore[key] !== undefined ? _propStore[key] : null
  );
  // 各モック関数の呼び出し履歴をリセット
  jest.clearAllMocks();
  // pushText はデフォルトで成功(何もしない)
  global.pushText.mockImplementation(() => {});
});

// ─────────────────────────────────────────────────────────────
// テスト 1: _extractTimesFromCell
// ─────────────────────────────────────────────────────────────

describe('_extractTimesFromCell', () => {
  // --- パターン1: コロンなし時刻範囲 ---

  test('半角ハイフン区切り "9-11" を "09:00"〜"11:00" に変換する', () => {
    const result = _extractTimesFromCell('〇9-11');
    expect(result.startTime).toBe('09:00');
    expect(result.endTime).toBe('11:00');
  });

  test('全角ハイフン区切り "13－21" を "13:00"〜"21:00" に変換する', () => {
    const result = _extractTimesFromCell('〇13－21');
    expect(result.startTime).toBe('13:00');
    expect(result.endTime).toBe('21:00');
  });

  test('波ダッシュ区切り "9〜11" を "09:00"〜"11:00" に変換する', () => {
    const result = _extractTimesFromCell('〇9〜11');
    expect(result.startTime).toBe('09:00');
    expect(result.endTime).toBe('11:00');
  });

  test('全角チルダ区切り "9～11" を "09:00"〜"11:00" に変換する', () => {
    const result = _extractTimesFromCell('〇9～11');
    expect(result.startTime).toBe('09:00');
    expect(result.endTime).toBe('11:00');
  });

  test('Unicode ハイフン(U+2010) "13‐21" を "13:00"〜"21:00" に変換する', () => {
    // U+2010 = ‐ (HYPHEN、全角ハイフンとは別の文字)
    const result = _extractTimesFromCell('〇13‐21');
    expect(result.startTime).toBe('13:00');
    expect(result.endTime).toBe('21:00');
  });

  test('"9日" のような日付パターンは時刻として誤検知しない', () => {
    // 月またぎの日付テキストが混入しても時刻として拾わない
    const result = _extractTimesFromCell('9日');
    expect(result.startTime).toBe('終日');
    expect(result.endTime).toBe('終日');
  });

  // --- パターン2: HH:mm〜HH:mm 形式 ---

  test('"18:00〜20:00" を "18:00"〜"20:00" に変換する(コロンあり形式)', () => {
    const result = _extractTimesFromCell('〇18:00〜20:00');
    expect(result.startTime).toBe('18:00');
    expect(result.endTime).toBe('20:00');
  });

  test('"9:00-11:00" を "9:00"〜"11:00" に変換する(コロンあり・半角ハイフン)', () => {
    const result = _extractTimesFromCell('〇9:00-11:00');
    expect(result.startTime).toBe('9:00');
    expect(result.endTime).toBe('11:00');
  });

  test('コロンあり形式はコロンなし形式より優先して解釈される', () => {
    // "13:00〜21:00" が含まれるテキストで、数字部分 "13〜21" にも誤マッチしないこと
    const result = _extractTimesFromCell('〇13:00〜21:00');
    expect(result.startTime).toBe('13:00');
    expect(result.endTime).toBe('21:00');
  });

  // --- フォールバック: 時刻なし ---

  test('時刻パターンがない "〇" 単体は "終日" を返す', () => {
    const result = _extractTimesFromCell('〇');
    expect(result.startTime).toBe('終日');
    expect(result.endTime).toBe('終日');
  });

  test('時刻パターンがない "△要確認" は "終日" を返す', () => {
    const result = _extractTimesFromCell('△要確認');
    expect(result.startTime).toBe('終日');
    expect(result.endTime).toBe('終日');
  });

  test('時刻の数値が 0〜24 の範囲外(例: "25-30")は "終日" にフォールバックする', () => {
    // 25 > 24 なので有効な時刻ではない
    const result = _extractTimesFromCell('25-30');
    expect(result.startTime).toBe('終日');
    expect(result.endTime).toBe('終日');
  });
});

// ─────────────────────────────────────────────────────────────
// テスト 2: _isExcluded / _isValid (空き判定ロジック)
//
// 依頼書の _isSlotAvailable に相当する2関数をセットでテストする。
// 「空きあり」= _isExcluded が false かつ _isValid が true
// ─────────────────────────────────────────────────────────────

describe('_isExcluded', () => {
  test('空文字列は除外される', () => {
    expect(_isExcluded('')).toBe(true);
  });

  test('null / undefined は除外される', () => {
    expect(_isExcluded(null)).toBe(true);
    expect(_isExcluded(undefined)).toBe(true);
  });

  test('"×" 始まりは除外される', () => {
    expect(_isExcluded('×')).toBe(true);
    expect(_isExcluded('×バドミントン')).toBe(true);
  });

  test('"✕"(U+2715) 始まりは除外される', () => {
    expect(_isExcluded('✕')).toBe(true);
  });

  test('"ー" (長音符)のみは除外される', () => {
    expect(_isExcluded('ー')).toBe(true);
  });

  test('半角ハイフン "-" のみは除外される', () => {
    expect(_isExcluded('-')).toBe(true);
  });

  test('"休館日" を含む文字列は除外される', () => {
    expect(_isExcluded('休館日')).toBe(true);
    expect(_isExcluded('本日休館日です')).toBe(true);
  });

  test('"〇9-11" は除外されない', () => {
    expect(_isExcluded('〇9-11')).toBe(false);
  });

  test('"△" は除外されない', () => {
    expect(_isExcluded('△')).toBe(false);
  });
});

describe('_isValid', () => {
  test('"〇" 始まりは有効', () => {
    expect(_isValid('〇')).toBe(true);
    expect(_isValid('〇9-11')).toBe(true);
  });

  test('"○" 始まりは有効(異なる Unicode コードポイントの丸)', () => {
    expect(_isValid('○')).toBe(true);
  });

  test('"△" 始まりは有効(要確認扱い)', () => {
    expect(_isValid('△')).toBe(true);
    expect(_isValid('△13‐21中体育室')).toBe(true);
  });

  test('"×" 始まりは有効でない', () => {
    expect(_isValid('×')).toBe(false);
  });

  test('空文字列は有効でない', () => {
    expect(_isValid('')).toBe(false);
  });

  test('数字始まりのテキストは有効でない', () => {
    expect(_isValid('9-11')).toBe(false);
  });
});

describe('空き判定の組み合わせ(_isExcluded が false かつ _isValid が true = 空きあり)', () => {
  test('"〇9-11" は空きあり', () => {
    expect(_isExcluded('〇9-11')).toBe(false);
    expect(_isValid('〇9-11')).toBe(true);
  });

  test('"×" は空きなし(_isExcluded が true)', () => {
    expect(_isExcluded('×')).toBe(true);
  });

  test('"△" は要確認扱い(空きあり)', () => {
    expect(_isExcluded('△')).toBe(false);
    expect(_isValid('△')).toBe(true);
  });

  test('"休館日" は空きなし(_isExcluded が true)', () => {
    expect(_isExcluded('休館日')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// テスト 3: parseScraperSheetValues
// ─────────────────────────────────────────────────────────────

describe('parseScraperSheetValues', () => {
  // new Date() のモック: 2026-05-01 固定(テスト実行日に依存しないように)
  const MOCK_YEAR = 2026;
  const MOCK_MONTH = 5; // 5月

  let originalDate;

  beforeEach(() => {
    originalDate = global.Date;
    // new Date() を呼ぶとモック日付を返す
    const MockDate = class extends Date {
      constructor(...args) {
        if (args.length === 0) {
          super(MOCK_YEAR, MOCK_MONTH - 1, 1); // 2026-05-01
        } else {
          super(...args);
        }
      }
      getFullYear() { return MOCK_YEAR; }
      getMonth() { return MOCK_MONTH - 1; } // 0-based
    };
    global.Date = MockDate;
  });

  afterEach(() => {
    global.Date = originalDate;
  });

  // --- 基本動作 ---

  test('ヘッダー行が含まれていても日付行のみをパースする', () => {
    const values = [
      ['日', '曜日', 'バドミントン', '卓球', 'ランニング', '備考'],
      ['1日', '木', '〇9-11', '×', '〇', ''],
      ['2日', '金', '×', '×', '〇', '']
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    // 1日の〇のみヒット、2日の×はスキップ
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-05-01');
    expect(result[0].startTime).toBe('09:00');
    expect(result[0].endTime).toBe('11:00');
    expect(result[0].facilityName).toBe('テスト体育館');
  });

  test('空の配列を渡すと空配列を返す', () => {
    const result = parseScraperSheetValues([], 'テスト体育館');
    expect(result).toHaveLength(0);
  });

  test('× のみの行はすべてスキップされる', () => {
    const values = [
      ['日', '曜日', 'バドミントン'],
      ['1日', '木', '×'],
      ['2日', '金', '×']
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    expect(result).toHaveLength(0);
  });

  test('ヘッダーにバドミントン列がない場合はデフォルト列(列2)を使う', () => {
    // 列0: 日, 列1: 曜日, 列2: バドミントン(ヘッダーにキーワードなし)
    const values = [
      ['日', '曜日', '個人開放'],  // ヘッダーにバドミントンなし
      ['3日', '土', '〇13-21']
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-05-03');
  });

  test('バドミントン列のセルが〇で時刻なしの場合は "終日" になる', () => {
    const values = [
      ['日', '曜日', 'バドミントン'],
      ['5日', '月', '〇']
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    expect(result).toHaveLength(1);
    expect(result[0].startTime).toBe('終日');
    expect(result[0].endTime).toBe('終日');
  });

  test('△(要確認)の行も結果に含まれ note が設定される', () => {
    const values = [
      ['日', '曜日', 'バドミントン'],
      ['10日', '土', '△']
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    expect(result).toHaveLength(1);
    expect(result[0].note).toBe('要確認');
  });

  // --- 月またぎ検知(D-018) ---

  test('日付が 31→1 のように大きく減った場合は翌月に移行する', () => {
    // 5月31日 → 6月1日 のパターン
    const values = [
      ['日', '曜日', 'バドミントン'],
      ['31日', '日', '〇9-11'],   // 5月31日
      ['1日', '月', '〇13-21']    // 6月1日(月またぎ)
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe('2026-05-31');
    expect(result[1].date).toBe('2026-06-01'); // 翌月に移行
  });

  test('同月内で日付が増えていく場合は月をまたがない', () => {
    const values = [
      ['日', '曜日', 'バドミントン'],
      ['1日', '木', '〇9-11'],
      ['15日', '木', '〇9-11'],
      ['31日', '日', '〇9-11']
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    expect(result).toHaveLength(3);
    expect(result[0].date).toBe('2026-05-01');
    expect(result[1].date).toBe('2026-05-15');
    expect(result[2].date).toBe('2026-05-31');
  });

  test('月またぎが 12月→1月 の場合は年も繰り上がる', () => {
    // モック日付を 12月に変更するため一時上書き
    global.Date = class extends originalDate {
      constructor(...args) {
        if (args.length === 0) {
          super(2026, 11, 1); // 2026-12-01
        } else {
          super(...args);
        }
      }
      getFullYear() { return 2026; }
      getMonth() { return 11; } // 0-based → 12月
    };

    const values = [
      ['日', '曜日', 'バドミントン'],
      ['31日', '水', '〇9-11'],  // 12月31日
      ['1日', '木', '〇9-11']    // 1月1日(年またぎ)
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe('2026-12-31');
    expect(result[1].date).toBe('2027-01-01'); // 翌年に繰り上がる
  });

  test('しきい値15日の境界: 日付が 16→1 は月またぎと判定される', () => {
    // prevDay=16, dayNum=1 → 差分15 > 15 は false なのでまたぎ判定されない
    // prevDay=17, dayNum=1 → 差分16 > 15 は true なのでまたぎ判定される
    const values = [
      ['日', '曜日', 'バドミントン'],
      ['17日', '火', '〇9-11'],
      ['1日', '水', '〇9-11']  // 17-1=16 > 15 → 翌月
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    expect(result[0].date).toBe('2026-05-17');
    expect(result[1].date).toBe('2026-06-01');
  });

  test('しきい値15日の境界: 日付が 16→1 は月またぎと判定されない', () => {
    // prevDay=16, dayNum=1 → 差分15 > 15 は false なので同月扱い
    const values = [
      ['日', '曜日', 'バドミントン'],
      ['16日', '月', '〇9-11'],
      ['1日', '火', '〇9-11']  // 16-1=15 ≤ 15 → 同月
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    expect(result[0].date).toBe('2026-05-16');
    expect(result[1].date).toBe('2026-05-01'); // 同月のまま
  });

  // --- 結果オブジェクトの構造 ---

  test('返却オブジェクトに date / startTime / endTime / facilityName / note が含まれる', () => {
    const values = [
      ['日', '曜日', 'バドミントン'],
      ['1日', '木', '〇9-11']
    ];
    const result = parseScraperSheetValues(values, 'テスト体育館');
    expect(result[0]).toHaveProperty('date');
    expect(result[0]).toHaveProperty('startTime');
    expect(result[0]).toHaveProperty('endTime');
    expect(result[0]).toHaveProperty('facilityName');
    expect(result[0]).toHaveProperty('note');
  });
});

// ─────────────────────────────────────────────────────────────
// テスト 4: _checkAndNotifyNewMonths
// ─────────────────────────────────────────────────────────────

describe('_checkAndNotifyNewMonths', () => {
  // FACILITIES 定数(scraper.js から読み込まれたグローバル)を参照する。
  // テストでは enabled: true な施設(420, 413, 495)を前提とする。

  const ENABLED_IDS = [420, 413, 495];

  /**
   * 指定施設の SCRAPED_MONTHS を PropertiesService に書き込むヘルパー
   */
  function setScrapedMonths(facilityId, months) {
    _propStore['SCRAPED_MONTHS_FACILITY_' + facilityId] = JSON.stringify(months);
  }

  /**
   * 指定施設の LAST_NOTIFIED_MONTH を PropertiesService に書き込むヘルパー
   */
  function setLastNotified(facilityId, month) {
    _propStore['LAST_NOTIFIED_MONTH_FACILITY_' + facilityId] = month;
  }

  /**
   * 指定施設の LAST_NOTIFIED_MONTH を PropertiesService から読み取るヘルパー
   */
  function getLastNotified(facilityId) {
    return _propStore['LAST_NOTIFIED_MONTH_FACILITY_' + facilityId] || null;
  }

  // --- 基本動作 ---

  test('SCRAPED_MONTHS が未設定の施設はスキップされ pushText を呼ばない', () => {
    // 全施設の SCRAPED_MONTHS を未設定のまま実行
    _checkAndNotifyNewMonths();
    expect(pushText).not.toHaveBeenCalled();
  });

  test('新月(lastNotified より大きい月)が存在すれば pushText を呼ぶ', () => {
    // 施設420のみ設定
    setScrapedMonths(420, ['2026-05', '2026-06']);
    setLastNotified(420, '2026-05');
    // LINE_GROUP_ID を設定しておかないと pushText が呼ばれない
    _propStore['LINE_GROUP_ID'] = 'Cxxxx_test_group';

    _checkAndNotifyNewMonths();

    // 施設420の新月(2026-06)が検知されて pushText が呼ばれる
    expect(pushText).toHaveBeenCalledWith(
      'Cxxxx_test_group',
      expect.stringContaining('6月分が公開されました')
    );
    // LAST_NOTIFIED_MONTH が更新されている
    expect(getLastNotified(420)).toBe('2026-06');
  });

  test('lastNotified と同じ月しかない場合は pushText を呼ばない', () => {
    setScrapedMonths(420, ['2026-05']);
    setLastNotified(420, '2026-05');
    _propStore['LINE_GROUP_ID'] = 'Cxxxx_test_group';

    _checkAndNotifyNewMonths();

    expect(pushText).not.toHaveBeenCalled();
  });

  test('LINE_GROUP_ID が未設定の場合は pushText を呼ばない', () => {
    setScrapedMonths(420, ['2026-06']);
    setLastNotified(420, '2026-05');
    // LINE_GROUP_ID をセットしない

    _checkAndNotifyNewMonths();

    expect(pushText).not.toHaveBeenCalled();
  });

  // --- 全施設揃い通知 ---

  test('全 enabled 施設の LAST_NOTIFIED_MONTH が同じになったとき全施設揃い通知を送る', () => {
    _propStore['LINE_GROUP_ID'] = 'Cxxxx_test_group';

    // 3施設すべてに2026-06の予定が公開済み
    ENABLED_IDS.forEach(id => {
      setScrapedMonths(id, ['2026-05', '2026-06']);
      setLastNotified(id, '2026-05'); // まだ05までしか通知していない
    });

    _checkAndNotifyNewMonths();

    // 3施設分の個別通知 + 全施設揃い通知の計4回呼ばれる
    expect(pushText).toHaveBeenCalledTimes(4);

    // 全施設揃い通知のメッセージに「6月」が含まれる
    const allReadyCalls = pushText.mock.calls.filter(call =>
      call[1].includes('全施設の予定が揃いました')
    );
    expect(allReadyCalls).toHaveLength(1);
    expect(allReadyCalls[0][1]).toContain('6月');

    // ALL_FACILITIES_NOTIFIED_MONTH が更新されている
    expect(_propStore['ALL_FACILITIES_NOTIFIED_MONTH']).toBe('2026-06');
  });

  test('全施設揃い通知を既に送済みの場合は再送しない', () => {
    _propStore['LINE_GROUP_ID'] = 'Cxxxx_test_group';
    // 全施設 06 通知済みとしてマーク
    _propStore['ALL_FACILITIES_NOTIFIED_MONTH'] = '2026-06';
    ENABLED_IDS.forEach(id => {
      setScrapedMonths(id, ['2026-06']);
      setLastNotified(id, '2026-06');
    });

    _checkAndNotifyNewMonths();

    // 新月なし・全施設揃い通知も送済みなので pushText は 0 回
    expect(pushText).not.toHaveBeenCalled();
  });

  test('一部施設の LAST_NOTIFIED_MONTH が揃っていない場合は全施設揃い通知を送らない', () => {
    _propStore['LINE_GROUP_ID'] = 'Cxxxx_test_group';

    // 施設420は06通知済み、413と495は05止まり
    setScrapedMonths(420, ['2026-06']);
    setLastNotified(420, '2026-06');

    setScrapedMonths(413, ['2026-05']);
    setLastNotified(413, '2026-05');

    setScrapedMonths(495, ['2026-05']);
    setLastNotified(495, '2026-05');

    _checkAndNotifyNewMonths();

    // 全施設揃い通知は送られない
    const allReadyCalls = pushText.mock.calls.filter(call =>
      call[1].includes('全施設の予定が揃いました')
    );
    expect(allReadyCalls).toHaveLength(0);
  });

  // --- pushText が失敗した場合の lastNotified 更新 ---

  test('pushText が例外をスローした場合は LAST_NOTIFIED_MONTH を更新しない', () => {
    _propStore['LINE_GROUP_ID'] = 'Cxxxx_test_group';
    setScrapedMonths(420, ['2026-06']);
    setLastNotified(420, '2026-05');
    // 他の施設は設定なし

    // pushText を失敗させる
    pushText.mockImplementation(() => { throw new Error('LINE API error'); });

    _checkAndNotifyNewMonths();

    // 通知失敗なので LAST_NOTIFIED_MONTH は更新されない
    expect(getLastNotified(420)).toBe('2026-05');
  });
});
