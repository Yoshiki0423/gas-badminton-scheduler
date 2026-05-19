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

## 残タスク（プロジェクト完了後に実施）

### プロジェクト完了後にやること
- [ ] **AI_KB（個人資産）への反映**：今回のプロジェクトで得た「意思決定ログの置き場所ルール」「LIFFキャッシュ問題の回避策」などを `C:\Users\Yoshiki\.claude\AI_knowledge_base\` に追記する
- [ ] **global CLAUDE.md の更新**：「CRITIC/REVIEW/TEST/IMPLEMENTATIONレポートはgit管理しない」「決定事項の置き場所ルール（仕様→REQUIREMENTS.md / 判断理由→DECISION_NOTES.md / Claude指示→CLAUDE.md）」を `C:\Users\Yoshiki\.claude\CLAUDE.md` に追記する
- [ ] **`_archive/` フォルダの完全削除**：再検証・コード整理が終わったタイミングで中身ごと削除する

---

## 未解決タスク・検討事項

### 月またぎローテーション処理（要確認）
IMPORTHTML式のURLが固定（月パラメータなし）なので、施設HPが切り替われば
スプレッドシートも自動更新される見込み。実際に6月になったとき確認が必要。
