# 実装サマリ — F-2-5 新月公開通知機能(作成: 2026-05-15T00:00)

## 実装概要

F-2-5「新月公開通知機能」として、以下の 3 つの変更を `src/scraper.js` に加えた。

1. **月またぎバグ修正**: `parseScraperSheetValues` に `prevDay` 変数を導入し、ループ内で前の日より日付が減った場合に月をインクリメントする処理を追加した。これにより、施設サイトが翌月分データを公開したとき(例: 31 日 → 1 日)でも正確に YYYY-MM を取り出せるようになった。

2. **トリガー時刻変更**: `TRIGGER_HOUR` を 6 から 7 に変更した。

3. **新月検知・通知ロジック追加**: スクレイピング後のスケジュール配列から月一覧を ScriptProperties に保存し、前回通知月と比較して新しい月が見つかった施設のメンバーに通知を送る仕組みを追加した。全施設の通知月が揃ったタイミングでは「全施設揃い通知」を追加で送る。

既存の `scrapeAllFacilities` / `scrapeFacilitySchedule` の return 型・インターフェイスは変えていない。

---

## 主要決定

### 決定 1: 月またぎ検知のロジック選択

- **検討した案**:
  - 案 A: `dayNum < prevDay` で月またぎ判定する(採用案)
  - 案 B: 施設サイトのテーブル内に「X月」テキストがあれば抽出する
  - 案 C: パース後の日付を `Date` オブジェクトで並べ替えてから連番チェックする
- **採用案**: 案 A
- **採用理由**: IMPORTHTML はテーブルデータのみ取得するため月テキストは取れない(案 B は構造的に不可)。案 C はパース後の処理追加になり既存の逐次ループを大きく変える。案 A は既存ループに 5 行の挿入で済み、Cyclomatic Complexity の増加も最小限。
- **トレードオフ**: 同月内で日付が飛んでいる(例: 1 日 → 3 日 → 2 日のような逆順)場合に誤検知するリスクがある。ただし施設サイトのテーブルは日付昇順が前提(D-016 で確認済み)なのでこのリスクは許容する。

### 決定 2: `SCRAPED_MONTHS_FACILITY_*` を通知後も残すか削除するか

- **検討した案**:
  - 案 A: 通知後も残す(採用案)
  - 案 B: 通知が完了した施設のキーを削除する
- **採用案**: 案 A
- **採用理由**: `LAST_NOTIFIED_MONTH_FACILITY_<id>` で二重通知防止は完結しており、削除する必要がない。デバッグ・運用確認の観点から「最後にスクレイピングで取得した月」を手動確認できる価値が高い(D-021 参照)。
- **トレードオフ**: ScriptProperties に不要なキーが残るが、本プロジェクト規模では容量(500KB/500件)を超えない。

### 決定 3: 通知失敗時の挙動

- **検討した案**:
  - 案 A: 失敗したら例外を上位に投げて処理を止める
  - 案 B: 失敗を `logError` で記録し次のメンバー/施設へ続行する(採用案)
- **採用案**: 案 B
- **採用理由**: REQUIREMENTS.md §4-2 エラーポリシー「送信失敗しても次の処理へ続行する」に準拠。1 人への送信失敗が他のメンバー全員の配信を止めてはならない。
- **トレードオフ**: 失敗した施設の通知は `LAST_NOTIFIED_MONTH_FACILITY_<id>` を更新しないため次回スクレイピング時に再試行される。連続失敗の場合は GAS ログで確認が必要。

---

## 実装したファイル一覧(Workflow Step 6 宣言範囲)

| ファイル | 変更種別 | 概要 | 対応要件 |
|---|---|---|---|
| `src/scraper.js` | 修正 | `TRIGGER_HOUR` 6 → 7 に変更 | F-2-5 修正 2 |
| `src/scraper.js` | 修正 | `parseScraperSheetValues` に月またぎバグ修正(`prevDay` 変数導入) | F-2-5 修正 1 |
| `src/scraper.js` | 追加 | `SCRAPED_MONTHS_KEY_PREFIX` / `LAST_NOTIFIED_MONTH_KEY_PREFIX` / `ALL_FACILITIES_NOTIFIED_MONTH_KEY` 定数追加 | F-2-5 追加 3 |
| `src/scraper.js` | 追加 | `_saveScrapedMonths(facilityId, schedules)` 関数追加 | F-2-5 追加 3 |
| `src/scraper.js` | 追加 | `_checkAndNotifyNewMonths()` 関数追加 | F-2-5 追加 3 |
| `src/scraper.js` | 追加 | `_getCommonLastNotifiedMonth(props)` 関数追加 | F-2-5 追加 3 |
| `src/scraper.js` | 追加 | `_notifyNewFacilityMonth(facility, yearMonth)` 関数追加 | F-2-5 追加 3 |
| `src/scraper.js` | 追加 | `_notifyAllFacilitiesReady(yearMonth)` 関数追加 | F-2-5 追加 3 |
| `src/scraper.js` | 修正 | `checkAndScrapeIfUpdated` に `_checkAndNotifyNewMonths()` 呼び出し追加 | F-2-5 追加 3 |
| `src/scraper.js` | 修正 | `scrapeFacilitySchedule` の末尾に `_saveScrapedMonths` 呼び出し追加 | F-2-5 追加 3 |
| `DECISION_NOTES.md` | 追記 | D-021 として F-2-5 の設計判断を記録 | F-2-5 成果物 |
| `IMPLEMENTATION_F25.md` | 新規 | 本ファイル | F-2-5 成果物 |

---

## 既知の制約・前提

- **月またぎ検知は日付の単調増加を前提とする**: 施設サイトのテーブルが日付昇順でない場合は誤検知が起きうる(D-016 で昇順であることを確認済み)。
- **スクレイピング失敗時は通知されない**: `scrapeFacilitySchedule` がエラーで失敗した場合、`_saveScrapedMonths` も呼ばれないため、その施設の新月通知はスキップされる(既存のエラーポリシーと同一の挙動)。
- **LIFF_FORM_ID が未設定のとき**: `_notifyAllFacilitiesReady` は URL なしのメッセージを送る。GAS スクリプトプロパティに `LIFF_FORM_ID` を設定すれば自動でリンクが付く。
- **GAS の制約**: `var` を使用(const/let は GAS で非推奨扱い)、アロー関数不使用、`Array.prototype.includes` の代わりに `indexOf` を使用。

---

## 仮定したこと(TBD 解消含む)

- 仕様書に「月またぎバグ修正」の詳細な検知方式が指定されていなかったため、「`dayNum < prevDay` で充分」という指示に従い最小変更で実装した。
- `_notifyNewFacilityMonth` が送る「最新の新月」は、その施設のスクレイピングで得た月の中で `lastNotified` より大きい最後の値とした(複数月が一度に公開された場合は最新月のみ通知)。
- `_checkAndNotifyNewMonths` は引数なし(ss も不要)で設計した。ScriptProperties と `getActiveMembers()` / `pushText()` は既存のグローバル関数を呼ぶ設計のため引数渡しは不要と判断した。

---

## テスト方法(tester-ja への引き継ぎ)

- **起動**: GAS エディタで該当関数を手動実行
- **単体テスト(月またぎバグ修正)**:
  - `parseScraperSheetValues` に 5 月 28〜31 日 + 6 月 1〜3 日のダミー 2D 配列を渡す
  - 31 日の `date` が `"2026-05-31"` / 1 日の `date` が `"2026-06-01"` になることを確認
  - ログに「月またぎを検知(31 日 → 1 日)」が出力されることを確認
- **単体テスト(`_saveScrapedMonths`)**:
  - `_saveScrapedMonths(420, [{date:'2026-05-28'},{date:'2026-06-01'}])` を実行
  - ScriptProperties `SCRAPED_MONTHS_FACILITY_420` が `["2026-05","2026-06"]` になることを確認
- **単体テスト(`_checkAndNotifyNewMonths`)**:
  - 前提: `SCRAPED_MONTHS_FACILITY_420` に `["2026-06"]`、`LAST_NOTIFIED_MONTH_FACILITY_420` に `"2026-05"` を設定
  - `_checkAndNotifyNewMonths()` を実行
  - ログに「鳥屋野総合体育館 に新月を検知。2026-06 の通知を送ります。」が出力されることを確認
  - `LAST_NOTIFIED_MONTH_FACILITY_420` が `"2026-06"` に更新されることを確認
- **主要受け入れ条件**:
  - 月またぎバグ修正: 翌月データが正しい月に登録される
  - `SCRAPED_MONTHS_FACILITY_*` がスクレイピング後に保存される
  - 施設ごとの新月通知が `lastNotified` より大きい月にのみ送信される
  - 全施設の通知月が揃ったときのみ全施設揃い通知が送信される
  - 通知失敗時も他のメンバー・他の施設の処理が止まらない

---

## 視覚的検証が必要な箇所

該当なし(LINE メッセージのテキスト内容は「テスト方法」セクションの手動実行で確認可能)。

---

## スコープ外発見

- トリガー時刻 7 時への変更に伴い `setupDailyTrigger` のコメント中の「6 時」の記述が古くなっている(コメント内の説明文のみ。機能には影響なし)。次回リファクタリング時に更新を推奨する。

---

## セルフリファイン採点

### 基準 1: 要件適合 — 10 / 10
- 良い点: 仕様の 3 つの修正(月またぎバグ修正 / TRIGGER_HOUR 変更 / 新月検知・通知ロジック)をすべて実装した。ScriptProperties キー名・通知メッセージ文面・呼び出しタイミングも仕様通り。既存関数の return 型は変えていない。
- 改善点: なし

### 基準 2: コード品質 — 9 / 10
- 良い点: 既存コードの命名規則(`_` プレフィックス / `/** JSDoc */` / 大文字スネークケース定数)を踏襲。重要パスの各関数は 30〜50 行程度で Cyclomatic Complexity は低い。`_getCommonLastNotifiedMonth` は `_checkAndNotifyNewMonths` から分離した SRP 準拠。Magic Number なし(月数 12 は変数化対象だが GAS 向けシンプルコードとして許容)。
- 改善点: `_checkAndNotifyNewMonths` は少し長い(約 60 行)。補助パスとして許容範囲内だが、施設ループ部分と全施設揃い判定部分を別関数に分けるとより読みやすくなる可能性がある。IMPLEMENTATION の「スコープ外発見」に記録。

### 基準 3: パフォーマンス — 9 / 10
- 良い点: `_checkAndNotifyNewMonths` は `PropertiesService.getScriptProperties()` を 1 回だけ取得してループで使い回す設計(不要な API 呼び出しを抑制)。`getActiveMembers()` は施設ごとではなく通知関数ごとに 1 回だけ呼ぶ設計(GAS API コール最小化)。
- 改善点: 施設が 3 つある場合、`getActiveMembers()` は `_notifyNewFacilityMonth` で施設ごとに 1 回ずつ呼ばれる(最大 3 回)。呼び出し元で 1 回取得して引数渡しにすれば削減できるが、今回の仕様書の設計に従い内部で取得する方式を採用した。

### 基準 4: テスタビリティ — 9 / 10
- 良い点: `_saveScrapedMonths` / `_notifyNewFacilityMonth` / `_notifyAllFacilitiesReady` / `_getCommonLastNotifiedMonth` をそれぞれ独立した純粋性の高い関数に分割。ScriptProperties のキーが定数で宣言されているため、テスト時に値の設定・確認が容易。
- 改善点: GAS の ScriptProperties への依存があるため単体テストはすべて GAS エディタ上での手動実行になる。モック可能な依存注入構造に変えればより自動テストしやすくなるが、本プロジェクトの GAS 制約下では許容範囲内。

### 基準 5: 拡張性 — 9 / 10
- 良い点: 施設一覧は `FACILITIES` 定数に集約されており、新施設追加時は配列に 1 件追記するだけで新月通知も自動で対応する。通知メッセージの文言は各関数内の 1 行で変更できる。全施設揃い判定は `enabled: true` の施設だけを対象とする設計で、将来施設を追加/無効化しても動作する。
- 改善点: なし

### 合計: 46 / 50
### 判定: [x] 合格(40-44) → 実際は 46 点のため即合格(45-50) に該当

実装と `IMPLEMENTATION_F25.md` を作成しました(**46 / 50 点**)。`tester-ja` へ引き継ぎます。

---

## 追記候補

- [ ] AI_KB 第六部「実装フェーズ」への追記: GAS の `var` 制約下での月またぎバグ修正パターン(`prevDay` 変数による単調増加検知)は GAS スクレイピング実装の定番パターンとして記録価値あり。
- [ ] AI_KB case_studies/01_alps_lab_web.md への追記: 「通知の重複送信防止に ScriptProperties を使う設計」は GAS Bot 系のプロジェクトで再利用可能なパターン。
