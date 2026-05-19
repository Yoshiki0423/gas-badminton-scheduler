# gas-badminton-scheduler プロジェクトメモ

---

## ⚠️ ファイル構成の重要ルール

### LIFFが配信するHTMLは `docs/reserve.html`（GitHub Pages）

| ファイル | 用途 | 更新方法 |
|---|---|---|
| `docs/reserve.html` | **LIFFが実際に読み込むファイル**（GitHub Pages配信） | `git push` |
| `liff/reserve.html` | GASの雛形ファイル（`<?= ... ?>` 記法あり）。LIFFからは使われていない | `clasp push`（GAS側のみ） |
| `src/handlers.js` `src/scraper.js` | GASサーバー側のロジック | `clasp push` |

**→ HTML の見た目・動作を変えるときは必ず `docs/reserve.html` を編集し `git push` すること。**  
`liff/reserve.html` を直してもLIFFには反映されない（過去に何度も引っかかった）。

---

## ⚠️ 次のセッション開始時の案内（2026-05-19 夜 更新）

このセクションは次のセッションで読み込んだ後、削除してよいか確認してください。

### 今回セッション（2026-05-19 夜）でやったこと

- **① コート優先順位画面のボタンが出ない問題を修正 ✅**
  - **根本原因**：`initData` は初期化関数のローカル変数で `showCourtScreen` から参照不可（ReferenceError）
  - `initData.savedPriority` → `state.savedPriority` 経由に変更
  - あわせて `const renderPriority = function()` に変更（iOS Safari の `if/else` ブロック内 `function` 宣言問題）
  - `simpleLabel` 正規化で `COURT_NAMES` キーのヒット漏れも修正
  - 確認画面まで正常動作確認済み ✅
- **LIFF キャッシュ問題を発見**：LINE キャッシュクリアでは解消せず、LINE Developers で
  エンドポイント URL に `?v=2` を追加して回避。詳細は KB ケーススタディ03 §14 参照。

### 次回セッションでやること

#### ① デバッグコードのクリーンアップ（優先度低）

- `liff/reserve.html`：`_dbgPre` 変数・デバッグパネルHTML・`[v035]` ローディングテキストを削除
- `src/handlers.js`：`_debugToday` 戻り値を削除

---

## 未解決タスク・検討事項

### 月またぎローテーション処理（要確認）
IMPORTHTML式のURLが固定（月パラメータなし）なので、施設HPが切り替われば
スプレッドシートも自動更新される見込み。実際に6月になったとき確認が必要。
