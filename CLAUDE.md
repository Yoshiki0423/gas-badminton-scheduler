# gas-badminton-scheduler プロジェクトメモ

---

## ⚠️ 次のセッション開始時の案内（2026-05-19 夜 更新）

このセクションは次のセッションで読み込んだ後、削除してよいか確認してください。

### 今回セッション（2026-05-19）でやったこと

**完了した実装**:
- D-034: `liff/reserve.html` カード重複バグ修正・clasp push 済み
- D-035: 未解禁スロット（5/29・6/1 等）の施設選択画面にスクレイパーパターン表示を実装
  - `src/scraper.js`：`_extractPatternForHour`・`getScraperPatternForSlot` 追加
  - `src/handlers.js`：`!isUnlocked` 時に `scraperPattern` を courseGroup に付加
  - `liff/reserve.html`：ノースキャンフロー追加（未解禁+available → Lambda スキャンスキップ）
  - clasp push 済み・git commit **未実施**（次のセッション冒頭で実施要）

### 次回セッションでやること

#### ① git commit と push

```powershell
git add src/scraper.js src/handlers.js liff/reserve.html DECISION_NOTES.md
git commit -m "feat: 未解禁スロットの施設選択画面をスクレイパーパターンで表示（D-035）

- scraper.js: _extractPatternForHour / getScraperPatternForSlot を追加
  施設ごとの表記ゆれ（東総合・鳥屋野・亀田）を網羅した4フォーマット解析
- handlers.js: !isUnlocked 時に scraperPattern を courseGroup に付加
- reserve.html: 未解禁+available は Lambda スキャンをスキップし
  スクレイパーパターンで施設ごと1枚のカードを表示するノースキャンフロー追加"
git push
```

#### ② 実機テスト
- 5/29（スケジュール公開済み・予約未解禁）の9時スロットで施設カードが3枚表示されるか確認
- 6/1（翌月）で同様に確認

---

## 未解決タスク・検討事項

### 月またぎローテーション処理（要確認）
IMPORTHTML式のURLが固定（月パラメータなし）なので、施設HPが切り替われば
スプレッドシートも自動更新される見込み。実際に6月になったとき確認が必要。
