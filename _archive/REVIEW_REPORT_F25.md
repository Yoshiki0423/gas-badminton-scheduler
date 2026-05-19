# コードレビューレポート(実施日時: 2026-05-15T12:00)

**評価対象**: `src/scraper.js` — F-2-5 新月公開通知機能

---

## 総合判定

**PASS ✅** — 必須項目(AC-19 / AC-20)はすべて実装されており、リリースブロッカーなし。
指摘件数: 🔴 0 件 / 🟡 3 件 / 🟢 2 件

---

## チェック観点(6 カテゴリ)

| # | カテゴリ | 結果 | 備考 |
|---|---|---|---|
| 1 | バグ・ロジックエラー | ✅ | 月またぎ検知ロジックに軽微な設計上の考慮事項あり(後述 🟡-1) |
| 2 | セキュリティ | ✅ | ScriptProperties への書き込みは GAS 内部のみ。外部入力を直接 JSON.stringify しているが、攻撃面は scraper シート経由に限定されており許容範囲 |
| 3 | パフォーマンス | ✅ | PropertiesService の呼び出しは _saveScrapedMonths と _checkAndNotifyNewMonths で計 2 回に分離されており N+1 問題なし |
| 4 | コード品質 | ✅ | SRP が概ね守られている。_checkAndNotifyNewMonths が通知判定・全施設揃い判定を兼ねるが規模は許容範囲内 |
| 5 | 可読性・保守性 | ✅ | 各関数に JSDoc + フロー説明コメントあり。Cyclomatic Complexity は最大推定 7 程度で閾値(10)以内 |
| 6 | ベストプラクティス | ✅ | GAS の var 制約・indexOf 代替・Array.includes 不使用を遵守。hasOwnProperty ガードも適切 |

---

## 仕様適合(`REQUIREMENTS.md` Must との突合)

| Must 項目 | 充足 | 根拠(コード参照) |
|---|---|---|
| AC-19: 施設の新月分データ初回スクレイピング時に施設ごと通知 | ✅ | `_checkAndNotifyNewMonths` L876-896 で `lastNotified` と比較して `_notifyNewFacilityMonth` を呼ぶ |
| AC-19: `LAST_NOTIFIED_MONTH_FACILITY_<id>` を通知後に更新 | ✅ | L896 `props.setProperty(lastNotifiedKey, newMonth)` |
| AC-19: 翌日以降の重複通知防止 | ✅ | `lastNotified >= scrapedMonths[j]` の条件により同月に再通知しない |
| AC-20: 全 enabled 施設の新月が揃ったとき LIFF リンク付き一括通知 | ✅ | `_getCommonLastNotifiedMonth` L901 + `_notifyAllFacilitiesReady` L917 |
| AC-20: `ALL_FACILITIES_NOTIFIED_MONTH` を通知後に更新 | ✅ | L923 `props.setProperty(ALL_FACILITIES_NOTIFIED_MONTH_KEY, allNotifiedMonth)` |
| AC-20: 重複通知防止 | ✅ | L908 `allFacilitiesNotified === allNotifiedMonth` チェック |
| F-2-5: `TRIGGER_HOUR` を 7 に変更 | ✅ | L112 `var TRIGGER_HOUR = 7` |
| F-2-5: 月またぎバグ修正(`prevDay` による検知) | ✅ | L410-435 `prevDay` 変数追加、`dayNum < prevDay` で月インクリメント |
| F-2-5: `scrapeFacilitySchedule` 末尾で `_saveScrapedMonths` 呼び出し | ✅ | L316 `_saveScrapedMonths(facility.facilityId, schedules)` |
| F-2-5: `checkAndScrapeIfUpdated` 内で `_checkAndNotifyNewMonths` 呼び出し | ✅ | L553-559 |
| F-2-5: 通知先はアクティブメンバー全員 | ✅ | `_notifyNewFacilityMonth` L982 / `_notifyAllFacilitiesReady` L1022 で `getActiveMembers()` 使用 |
| F-2-5: LIFF_FORM_ID が未設定の場合のフォールバック | ✅ | L1018 `if (liffFormId)` によりリンクなしでもメッセージ送信 |

---

## 良い点

- ✅ **通知失敗時に `lastNotified` を更新しない設計が正しい**: `_checkAndNotifyNewMonths` L891-895 で、`_notifyNewFacilityMonth` が例外を投げたときは `continue` して `setProperty` をスキップしている。これにより次回実行で再試行できる。エラーポリシー §4-2 に準拠した判断。
- ✅ **`_saveScrapedMonths` の `hasOwnProperty` ガード**: L346 で `for...in` ループに `hasOwnProperty` チェックを入れており、プロトタイプ汚染を防いでいる。GAS 環境での for-in では特に有効。
- ⭐ **`_getCommonLastNotifiedMonth` が `enabled` 状態の動的追従を実現**: 全施設揃い判定を `FACILITIES` 配列を走査して都度計算しているため、将来 `enabled: false` の施設を有効化したり新施設を追加したりしても自動追従する。REQUIREMENTS.md §3-2 の「将来 `enabled` 状態が変わった場合も自動的に追従する」要件をコード変更なしで満たす設計。
- ✅ **`_checkAndNotifyNewMonths` のエラー分離**: 施設ごとの通知失敗を try/catch で包み、1 施設の失敗が他施設の処理をブロックしない。エラーポリシー §4-2 に準拠。
- ✅ **月一覧の抽出を `substring(0, 7)` で行っている**: `date.split('-').slice(0, 2).join('-')` より確実かつ GAS の `var` 環境で余分なオブジェクト生成がない。

---

## 改善優先度リスト

### 🔴 致命的(リリースブロッカー)

なし

---

### 🟡 要改善

#### [バグ・ロジックエラー] 月またぎ検知が「同じ日番号が 2 度現れるケース」で誤作動する可能性

- **場所**: `src/scraper.js:427` (`parseScraperSheetValues` 内)
- **問題**: 月またぎ判定条件が `dayNum < prevDay` のみ。仮に施設サイトのテーブルが何らかの理由で同月内に日付の並び替えや重複行を持つ場合(例: 15日、14日 の降順並び)、誤って月をインクリメントする。また、GAS の `new Date()` は実行タイミングのサーバー時刻(JST)に依存するため、深夜 0 時直前と直後にスクレイピングが月境界をまたいで実行された場合に `year`/`month` の初期値がずれるリスクがある。
- **理由**: 現行テーブルは昇順で並んでいることが D-016 の実機確認で前提とされているため通常運用では問題ない。ただし施設サイトのHTML変更時に silent failure となりうる。GAS 実行時刻誤差は TRIGGER_HOUR=7 なので実際の影響は極めて小さい。リリースブロッカーではないが次回スプリントで対応を推奨。
- **修正案**:
```javascript
// Before（現行）
if (prevDay !== null && dayNum < prevDay) {
  month++;
  ...
}

// After（降順・同値行を防御）
// ひとつ前の行と比べてスキップ量が大きい(例: 28→1)場合のみ月またぎと判定
// 閾値を 15 日とする（同月内で15日以上後退することは暦上ない）
if (prevDay !== null && dayNum < prevDay && (prevDay - dayNum) > 15) {
  month++;
  if (month > 12) { month = 1; year++; }
  console.log('[INFO] ...');
}
```
- **補足**: `prevDay - dayNum > 15` のしきい値は「同月内で日付が 15 日以上後退することはない」という暦の制約から導出。既存の `31→1` ケース(差=30)も正しく月またぎと判定する。

---

#### [可読性・保守性] `setupDailyTrigger` / `checkAndScrapeIfUpdated` のコメントが「毎朝 6 時」のまま

- **場所**: `src/scraper.js:27` (ファイルヘッダー JSDoc) / `L480` / `L582`
- **問題**: `TRIGGER_HOUR` を 6→7 に変更したにもかかわらず、以下 3 箇所のコメント文字列が「6 時」のまま残っている。コードと仕様書(REQUIREMENTS.md §3-2)は「7 時」なのでコメントが誤情報になる。Long Method ではなく Magic Comment(コメントとコードが乖離)のアンチパターン。
  - L27: `checkAndScrapeIfUpdated の毎朝 6 時トリガーを設定`
  - L480: `GAS の time-based trigger から毎朝 6 時に呼ばれる。`
  - L582: `checkAndScrapeIfUpdated を毎朝 6 時に実行するトリガーを設定する`
- **理由**: コメントは仕様書の一部として機能する。次の開発者が 6 時と認識してトリガーを設定し直す恐れがある。
- **修正案**:
```javascript
// Before
// L27:   checkAndScrapeIfUpdated の毎朝 6 時トリガーを設定
// L480:  GAS の time-based trigger から毎朝 6 時に呼ばれる。
// L582:  checkAndScrapeIfUpdated を毎朝 6 時に実行するトリガーを設定する

// After
// L27:   checkAndScrapeIfUpdated の毎朝 7 時トリガーを設定
// L480:  GAS の time-based trigger から毎朝 7 時(TRIGGER_HOUR=7)に呼ばれる。
// L582:  checkAndScrapeIfUpdated を毎朝 7 時に実行するトリガーを設定する
```

---

#### [コード品質] `_checkAndNotifyNewMonths` 内で複数月が新規に現れた場合、最新月しか通知されない

- **場所**: `src/scraper.js:875-880`
- **問題**: `scrapedMonths` の中から `lastNotified` より大きいものをすべて走査しているが、`newMonth` は最後に見つかった値(最新月)で上書きされる。結果として通知されるのは最大 1 件。
  - 例: `lastNotified = "2026-04"`, `scrapedMonths = ["2026-04", "2026-05", "2026-06"]` の場合、`2026-05` の通知は送られず `2026-06` のみ通知される。
- **理由**: 現実的には施設サイトは 1 サイクルで 1 ヶ月分を追加公開するため、複数月スキップは稀。ただし初回セットアップ時(ScriptProperties が空の状態で 2 ヶ月分がスクレイピングされた場合)や `lastNotified` のリセット後に発生しうる。`lastNotified` が空文字 `""` のとき全月が `>` を満たすため初回は必ず最新月のみの通知になる。
- **修正案**:
```javascript
// Before: 最後に見つかった値(最新月)で上書き
var newMonth = null;
for (var j = 0; j < scrapedMonths.length; j++) {
  if (scrapedMonths[j] > lastNotified) {
    newMonth = scrapedMonths[j]; // 上書きされていく
  }
}

// After: 新月を「ソート済みの最小値(次の未通知月)」から順に処理
// scrapedMonths はソート済みなので、先頭から lastNotified を超える最初の値が「次に通知すべき月」
var newMonth = null;
for (var j = 0; j < scrapedMonths.length; j++) {
  if (scrapedMonths[j] > lastNotified) {
    newMonth = scrapedMonths[j]; // 最初にヒットした月を採用して break
    break;
  }
}
```
- **補足**: この変更により「最も古い未通知月から順に 1 件ずつ処理」となる。複数スキップは次回実行で順次処理される。仕様(REQUIREMENTS.md §3-2)には「複数月を一度に通知する」記述がないため 1 件ずつが仕様に忠実。

---

### 🟢 提案

#### [可読性・保守性] `_notifyNewFacilityMonth` / `_notifyAllFacilitiesReady` の `getActiveMembers()` 二重呼び出し

- **場所**: `src/scraper.js:982` / `L1022`
- **問題**: `_checkAndNotifyNewMonths` が 1 回の実行で両関数を呼んだ場合、`getActiveMembers()` がスプレッドシートに 2 回アクセスする。現在のメンバー数では GAS の実行時間に影響しないが、将来的な拡張(メンバー増加・施設増加)に備えた設計上の考慮。
- **理由**: `getActiveMembers()` はシート読み込みを伴う I/O 操作。GAS の実行時間制限(90 秒/日・無料枠)を意識すると呼び出し回数を減らす方向が望ましい。
- **修正案**:
```javascript
// _checkAndNotifyNewMonths 内でメンバー一覧を 1 回だけ取得して引数で渡す
var members = getActiveMembers(); // ここで 1 回だけ取得
// ... 施設ループ内で _notifyNewFacilityMonth(facility, newMonth, members) に変更
// ... 全施設揃い通知でも _notifyAllFacilitiesReady(allNotifiedMonth, members) に変更
```
- **補足**: 関数シグネチャが変わるため、呼び出し側(将来の単体テストなど)も変更が必要。優先度は低い。

---

#### [コード品質] `_saveScrapedMonths` が `schedules.length === 0` のケースを明示的に扱っていない

- **場所**: `src/scraper.js:332-354`
- **問題**: `schedules` が空配列の場合、`monthMap` も空 → `months` も空配列 `[]` が `JSON.stringify` されて ScriptProperties に書き込まれる。次回 `_checkAndNotifyNewMonths` 実行時に `scrapedMonths.length === 0` で `continue` されるため実害はない。ただし空配列を保存する必要がないなら早期 return の方が意図が明確。
- **理由**: DRY / KISS 原則。コードの意図が読み手に伝わりやすくなる。
- **修正案**:
```javascript
function _saveScrapedMonths(facilityId, schedules) {
  if (!schedules || schedules.length === 0) {
    console.log('[INFO] _saveScrapedMonths: facilityId=' + facilityId + ' schedules 空のため保存スキップ');
    return; // 空の場合は既存の値を上書きしない
  }
  // ... 以降は現行と同じ
}
```

> ✅ 合格 / ⭐ 優秀 は本「改善優先度リスト」には出さず、上記「良い点」セクションに集約しています。

---

## 視覚的検証が必要な箇所

該当なし(本変更はサーバーサイドロジックのみ。LINE Push 通知の文面確認は別途 AC-19/AC-20 の実機テストで対応)

---

## critic-ja 再委譲推奨

以下の観点は本エージェントの合格基準評価の範囲外です。卓越基準の観点で評価が必要な場合は `critic-ja` に再委譲してください。

- **業界水準での設計評価**: `_checkAndNotifyNewMonths` が「通知判定」と「全施設揃い判定」を 1 関数内に持つ点が SRP(単一責任の原則)の業界水準観点でどう評価されるか
- **スケーラビリティ評価**: 施設数が増えた場合の PropertiesService 書き込み回数と GAS クォータ消費の業界水準到達度

---

## スコープ外発見

該当なし(今回の評価対象は `src/scraper.js` の F-2-5 変更箇所に限定。他ファイルの変更は Phase 3 / F-4 スコープとして別途評価済み)

---

## 次のアクション

全レビュー合格。`critic-ja`(卓越基準・W1-W10 × 100 点採点)へ進みます。
🟡 要改善 3 件は次回スプリントの申し送り事項として `developer-ja` に共有することを推奨します。

---

## AI_KB 追記候補

- [ ] AI_KB 第五部アンチパターンへの追記: GAS `var` + `for...in` 環境での月またぎ検知の実装パターン。`dayNum < prevDay` のみの条件は降順テーブルで誤作動するため `prevDay - dayNum > 15` のしきい値で月暦の制約を利用する防御手法が有効。
- [ ] AI_KB case_studies への追記: ScriptProperties を「通知冪等性保証の状態ストア」として使うパターン。通知失敗時は状態を更新しない設計が再試行を可能にする。GAS クォータ制限下でのシンプルな冪等性実装例として記録価値あり。
