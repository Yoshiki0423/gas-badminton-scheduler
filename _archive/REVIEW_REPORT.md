# コードレビューレポート(実施日時: 2026-05-11T13:00)

## 総合判定

**[PASS ✅]** — 必須項目(F-2-1 / F-2-2)はすべて充足。指摘件数: 🔴 0 件 / 🟡 3 件 / 🟢 3 件

---

## チェック観点(6 カテゴリ)

| # | カテゴリ | 結果 | 備考 |
|---|---|---|---|
| 1 | バグ・ロジックエラー | ✅ | 月またぎ問題は D-016 で既知・許容済み。後述 🟡-1 |
| 2 | セキュリティ | ✅ | ScriptProperties でシークレット管理。MEMBERS_SPREADSHEET_ID / ADMIN_USER_ID のハードコードなし |
| 3 | パフォーマンス | ✅ | SpreadsheetApp.openById をループ内で個別呼び出しする冗長性あり(後述 🟡-2) |
| 4 | コード品質 | ✅ | ES5 制約下で IIFE によるクロージャ捕捉を正しく適用。グローバル汚染の最小化が適切 |
| 5 | 可読性・保守性 | ✅ | JSDoc・インラインコメント・セクション区切り充実。checkAndScrapeIfUpdated の Cyclomatic Complexity が高め(後述 🟢-1) |
| 6 | ベストプラクティス | ✅ | GAS ES5 制約に準拠。var / function・IIFE クロージャ・hasOwnProperty チェックすべて適切 |

---

## 仕様適合(`REQUIREMENTS.md` Must との突合)

| Must 項目 | 充足 | 根拠(コード参照) |
|---|---|---|
| F-2-1: 1 日 1 回制限 | ✅ | `scraper.js:174-183` — PROP_LAST_RUN_DATE との日付比較 + 実行前に記録して二重実行防止 |
| F-2-1: × 印の日付を除外 | ✅ | `scraper.js:536` — `_isExcluded()` で `/^[×✕]/` を除外 |
| F-2-1: スクレイピング結果を schedules シートへ保存 | ✅ | `scraper.js:269-271` — `withRetry` + `addSchedule` でリトライ付き書き込み |
| F-2-2: ハッシュ比較で更新検知 | ✅ | `scraper.js:438-446` — `_computeMd5Hex(JSON.stringify(values))` で前回ハッシュと比較 |
| F-2-2: 更新あり時に scrape + 配信 | ✅ | `scraper.js:461-469` — `scrapeAllFacilities(true)` → `handleDistributeSurvey()` を順次呼び出し |
| F-2-2: 毎朝 6 時トリガー | ✅ | `scraper.js:509-513` — `ScriptApp.newTrigger().timeBased().everyDays(1).atHour(6)` |
| §4-2: 体育館取得失敗時は前回データ維持(即時リトライなし) | ✅ | `scraper.js:197-203` — catch で `_incrementFailCountAndNotifyIfNeeded` のみ呼び次施設へ続行 |
| §4-2: 連続 3 日失敗で管理者通知 | ✅ | `scraper.js:706-719` — `newCount >= FAIL_THRESHOLD` で `pushText` |
| §4-2: スプレッドシート書き込みには withRetry を使う | ✅ | `scraper.js:269-271` — `withRetry(function() { addSchedule(schedule) }, ...)` |
| D-016: IMPORTHTML シートから getValues() で読み込む | ✅ | `scraper.js:245` — `sheet.getDataRange().getValues()` |
| D-016: table,2 を IMPORTHTML 式に設定 | ✅ | `scraper.js:147` — `=IMPORTHTML("...", "table", 2)` |
| D-013: ハッシュキー名 `HASH_FACILITY_<id>` | ✅ | `scraper.js:84, 442` — `HASH_KEY_PREFIX + facility.facilityId` |
| D-015: skipDailyCheck 引数 | ✅ | `scraper.js:171, 461` — 引数定義 + checkAndScrapeIfUpdated 呼び出し時に `true` を渡す |

---

## 良い点(70:30 のバランスで必ず明記)

- ✅ **IIFE によるクロージャ捕捉が正確に適用されている**(`scraper.js:267-281`): ES5 の `var` はブロックスコープを持たないため、ループ変数をコールバック内で使うとすべて最終値に固定される古典的なバグが発生する。IIFE で `schedule` をキャプチャして防いでおり、コメントにもその理由が明記されている。GAS ES5 環境では特に重要な防衛策。

- ✅ **エラーポリシー §4-2 の実装が仕様と完全に整合している**: 「体育館シート取得失敗 → 前回データ維持」「連続 3 日失敗 → 管理者通知」「スプレッドシート書き込みは withRetry」「シート読み取りは withRetry なし」という 4 段の使い分けがすべてコードに反映されており、REQUIREMENTS.md との矛盾がない。

- ✅ **`hasOwnProperty` チェックを `for...in` ループに適用している**(`scraper.js:478`): `for (var facilityId in newHashes)` のループで `newHashes.hasOwnProperty(facilityId)` を確認しており、プロトタイプチェーン上のプロパティが混入しない。ES5 の定番の安全パターンを正しく踏襲している。

- ✅ **月またぎ問題を DECISION_NOTES.md(D-016)に明示して許容判断を記録している**: 月末に `new Date()` で年月を取得する仕様上の制約を既知問題として文書化し、「1 日 1 回制限・月初再実行で解消」という運用方針を添えている。技術的負債を暗黙に放置せず、意思決定の根拠として記録している点は適切。

- ⭐ **バドミントン列をヘッダー行から動的探索するフォールバック機構が実装されている**(`scraper.js:311-334`): テーブル構造が変わった場合でも `HEADER_SEARCH_LIMIT` 行以内で「バドミントン」を含む列を探し、見つからなければ `DEFAULT_BADMINTON_COL` にフォールバックしてワーニングログを出す。施設サイトの HTML 変更に対して過度に壊れにくい設計になっており、必須要件を超えた堅牢性。

- ✅ **`_computeMd5Hex` の符号付き byte 変換処理にコメントが明記されている**(`scraper.js:664-676`): `Utilities.computeDigest` が返す `-128~127` の符号付き整数を `b < 0 ? b + 256 : b` で `0~255` に変換する理由が JSDoc に説明されている。同じ処理を後から読む人がハマりやすい落とし穴を文書化している。

---

## 改善優先度リスト

### 🔴 致命的(リリースブロッカー)

なし

---

### 🟡 要改善

#### [バグ・ロジックエラー] 🟡-1: 月またぎ時に翌月の日付データが当月として誤登録される可能性がある

- **場所**: `src/scraper.js:307-309`
- **問題**: `parseScraperSheetValues` 内で `new Date()` から `year` / `month` を取得し、すべての行の年月として使用している。月末(例: 5 月 30 日)に実行した場合、IMPORTHTML シートに翌月(6 月)の「1 日」「2 日」行が含まれると `2026-05-01` / `2026-05-02` として誤登録される。
- **理由**: D-016 で「MVP 運用では許容する」と記録されているが、誤登録されたデータは上書きされず `schedules` シートに残存し、質問配信の候補日時に過去日(または誤った月の日付)が混入するリスクがある。`addSchedule` に重複排除がない場合は複数件の誤レコードが蓄積する可能性もある。
- **修正案(段階的対応)**: 日付の妥当性チェックを `_buildDate` の呼び出し前に追加する。

```javascript
// _buildDate を呼ぶ前に当月末日との比較を追加する
// 修正例: parseScraperSheetValues 内の _buildDate 呼び出し箇所(scraper.js:350)
var dayNum = parseInt(dateMatch[1], 10);

// 当月の末日を求める(翌月の 0 日 = 当月末日)
var lastDayOfMonth = new Date(year, month, 0).getDate();
var targetYear = year;
var targetMonth = month;
if (dayNum > lastDayOfMonth) {
  // 当月に存在しない日 = 翌月として扱う
  targetMonth = month === 12 ? 1 : month + 1;
  targetYear = month === 12 ? year + 1 : year;
}
var fullDate = _buildDate(targetYear, targetMonth, dayNum);
```

> D-016 の「MVP 運用では許容」という判断を変更する設計変更になります。実際に適用する前にユーザーの確認を推奨します。

---

#### [パフォーマンス] 🟡-2: SpreadsheetApp.openById をループ内で個別呼び出ししている

- **場所**: `src/scraper.js:229-233`(scrapeFacilitySchedule)、`src/scraper.js:412-417`(checkAndScrapeIfUpdated)
- **問題**: `scrapeAllFacilities` は `scrapeFacilitySchedule` を FACILITIES の件数(現状 3 回)ループ呼び出しする。各呼び出し内で `SpreadsheetApp.openById(spreadsheetId)` が実行されるため、1 回の `scrapeAllFacilities` 実行で `openById` が 3 回呼ばれる。GAS の外部サービス呼び出しは実行時間クオータ(無料枠 90 分/日・REQUIREMENTS.md §4-4)を消費する。
- **理由**: 施設数が現状 3 件では影響は軽微だが、将来施設数が増えた場合に O(n) でオープンが増加する。また GAS のベストプラクティスとして「スプレッドシートのオープンは 1 回に集約する」が定番パターン(Google Apps Script 公式ドキュメント「Best practices」)。
- **修正案**: `scrapeFacilitySchedule` の引数に `ss`(Spreadsheet オブジェクト)を追加して呼び出し元から渡す。

```javascript
// scrapeFacilitySchedule のシグネチャを変更して ss を受け取る
function scrapeFacilitySchedule(facility, ss) {
  if (!facility.enabled) { return 0; }
  // ss は呼び出し元(scrapeAllFacilities)から渡してもらうため
  // openById を削除する
  if (!ss) {
    var spreadsheetId = getProperty('MEMBERS_SPREADSHEET_ID');
    if (!spreadsheetId) { throw new Error('MEMBERS_SPREADSHEET_ID が設定されていません。'); }
    ss = SpreadsheetApp.openById(spreadsheetId);
  }
  var sheet = ss.getSheetByName(facility.sheetName);
  // ...以降は変更なし
}

// scrapeAllFacilities 側でオープンを 1 回に集約
function scrapeAllFacilities(skipDailyCheck) {
  // ...既存の日付チェック処理...
  var spreadsheetId = getProperty('MEMBERS_SPREADSHEET_ID');
  if (!spreadsheetId) { throw new Error('MEMBERS_SPREADSHEET_ID が設定されていません。'); }
  var ss = SpreadsheetApp.openById(spreadsheetId); // 1 回だけ開く
  for (var i = 0; i < FACILITIES.length; i++) {
    var facility = FACILITIES[i];
    try {
      var saved = scrapeFacilitySchedule(facility, ss); // ss を渡す
      // ...
    }
  }
}
```

---

#### [コード品質] 🟡-3: `_isExcluded` のダッシュ系文字の網羅が不完全な可能性がある

- **場所**: `src/scraper.js:540`
- **問題**: 「ー(長音符)または半角ハイフンのみ」の除外正規表現が `/^[ー\-]$/` であり、カタカナ長音符(U+30FC)と半角ハイフン(U+002D)のみを対象としている。体育館サイトの HTML に全角ダッシュ `—`(U+2014)、水平線 `―`(U+2015)、全角ハイフンマイナス `－`(U+FF0D)が使われた場合は除外されず、`_isValid` の `^[〇○△]` にもマッチしないため処理がスキップされる(データへの混入はない)。ただし `_isValid` でフィルタされるため実害は現状ゼロ。
- **理由**: 防御的プログラミングの観点で、サイト側の HTML 変更(フォント・エンコーディングの変化でダッシュ文字が変わるケース)があった場合に無言でスキップされてしまう。警告ログが出ないため運用上気づきにくい。
- **修正案**: 対象文字を拡張するか、除外・有効のどちらにも分類されなかったセルに対してワーニングログを出す。

```javascript
// 修正案A: 対象文字を拡張する
// U+30FC カタカナ長音符 / U+002D 半角ハイフン / U+FF0D 全角ハイフンマイナス
// U+2014 全角ダッシュ / U+2015 水平線 / U+2011 ノーブレークハイフン
if (/^[ー\-－—―‑]$/.test(text)) {
  return true;
}

// 修正案B: parseScraperSheetValues で除外・有効どちらにも当たらなかった行を警告ログ
// _isExcluded が false かつ _isValid も false のセル値をログに残す
if (!_isExcluded(cellText) && !_isValid(cellText)) {
  console.log('[DEBUG] parseScraperSheetValues: 未分類のセル値: "' + cellText + '" (行' + i + ')');
  continue;
}
```

> 実際に問題が発生してから対応でも十分です。現状のサイトで取れる文字を確認してからの適用を推奨します。

---

### 🟢 提案

#### [可読性・保守性] 🟢-1: checkAndScrapeIfUpdated の Cyclomatic Complexity が高い

- **場所**: `src/scraper.js:408-484`(76 行)
- **問題**: `for` ループ × 2 + `if` × 3 + `try/catch` × 3 の組み合わせで、Cyclomatic Complexity が約 10 に達している(McCabe の推奨上限は 10)。現状は読めるが、将来の施設追加や処理変更時にテストすべきパスが増える。
- **修正案**: ハッシュ計算ループ部分を `_computeAllHashes(ss)` などの内部関数に切り出すと、関数の責務が「ハッシュ比較 → scrape 判断 → ハッシュ保存」の 3 ステップに整理される。

---

#### [ベストプラクティス] 🟢-2: `_isValid` と `_isExcluded` の呼び出し順序に暗黙の依存関係がある

- **場所**: `src/scraper.js:359-366`
- **問題**: `parseScraperSheetValues` 内で `_isExcluded(cellText)` → `_isValid(cellText)` の順で呼び出している。両者の判定条件に重複がない保証が暗黙的であり、将来どちらかに条件を追加した場合に予期しない振る舞いになりうる。
- **修正案**: JSDoc に「`_isExcluded` が false かつ `_isValid` が true の両条件をすべて満たす場合のみデータ行として扱う」旨のコメントを `parseScraperSheetValues` 内の当該箇所に追記する。コード変更不要。

---

#### [コード品質] 🟢-3: `scrapeAllFacilities` の戻り値が `checkAndScrapeIfUpdated` で使われていない

- **場所**: `src/scraper.js:461`
- **問題**: `checkAndScrapeIfUpdated` が `scrapeAllFacilities(true)` を呼び出しているが、戻り値 `{ totalSaved, facilityResults }` を捨てている。デバッグ時に「何件保存されたか」を外部から確認する手段がない。
- **修正案**:

```javascript
// Before
try {
  scrapeAllFacilities(true);
} catch (scrapeErr) {
  logError(scrapeErr, { phase: 'checkAndScrapeIfUpdated.scrape' });
}

// After: 戻り値をログに残す(既存の try/catch 構造は変えない)
try {
  var scrapeResult = scrapeAllFacilities(true);
  console.log('[INFO] checkAndScrapeIfUpdated: scrapeAllFacilities 完了 totalSaved=' + scrapeResult.totalSaved);
} catch (scrapeErr) {
  logError(scrapeErr, { phase: 'checkAndScrapeIfUpdated.scrape' });
}
```

---

> ✅ 合格 / ⭐ 優秀 は本「改善優先度リスト」には出さず、上記「良い点」セクションに集約する。

---

## 視覚的検証が必要な箇所

なし(本ファイルは GAS バックエンドコードのみ。UI 要素なし)

---

## critic-ja 再委譲推奨

以下の観点は合格基準の判定範囲外となるため、`critic-ja` への再委譲を推奨します。

- **IMPORTHTML キャッシュ遅延の業界水準評価**: Google スプレッドシートの IMPORTHTML は数時間単位でキャッシュされる可能性がある(D-016 記載)。これが「更新検知の鮮度」という要件を業界標準の更新検知システム(Webhook / Diff API 等)と比較してどの水準にあるかは、`critic-ja` による W 軸採点が適切。
- **`_computeMd5Hex` のハッシュアルゴリズム選定根拠**: MD5 は衝突耐性が低く(CWE-327)、セキュリティ用途には推奨されない。本用途は「スケジュールデータの変化検知」であり改ざん検知ではないため実用上問題はないが、業界水準(SHA-256 等への置換余地)の観点は `critic-ja` で評価してもらう方が適切。

---

## スコープ外発見

本レビューで評価したのは `src/scraper.js`(依頼で指定された変更ファイル)のみです。以下はスコープ外で発見した観察事項です。ユーザーの判断に委ねます。

- `src/utils.js` の `withRetry` / `logError` / `getProperty` / `DEFAULT_MAX_ATTEMPTS` を `scraper.js` が呼び出しているが、これらの実装は本レビューの評価対象外。

---

## 次のアクション

全レビュー合格。`critic-ja`(卓越基準・W1-W10 × 100 点採点)へ進みます。

---

## AI_KB 追記候補

- [ ] AI_KB 第五部アンチパターンへの追記: GAS ES5 環境での `for` ループ + `var` + コールバックの組み合わせで発生するクロージャ変数固定バグは IIFE で防げる。`scraper.js:267-281` が参照実装として有効。
- [ ] AI_KB case_studies への追記: IMPORTHTML + getValues() 方式は WAF ブロック回避の有効手段。UrlFetchApp が 501/403 で失敗する場合の代替パターンとして記録する価値あり(D-016 に設計根拠あり)。
