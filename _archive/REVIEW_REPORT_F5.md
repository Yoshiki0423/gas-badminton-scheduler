# コードレビューレポート — F-5: グループトーク移行

**レビュー日**: 2026-05-15
**対象**: `src/Code.js`, `src/handlers.js`, `src/scraper.js`
**参照**: REQUIREMENTS.md §12 / IMPLEMENTATION_F5.md

---

## 総合判定: PASS ✅

致命的指摘 0件 / 軽微な指摘 2件 / 提案 2件

---

## カテゴリ別評価

### 1. 正確性・機能要件との一致

✅ **合格**

- `join` イベント: `event.source.groupId` を `LINE_GROUP_ID` に保存 — REQUIREMENTS.md §12(F-5-2)通り
- `memberJoined` イベント: `event.joined.members` ループ → `upsertMemberAsActive` — REQUIREMENTS.md §12(F-5-4)通り
- `handleDistributeSurvey`: グループへ 1 通 Push に変更 — REQUIREMENTS.md §12(F-5-3)通り
- `handleAggregateAndNotify`: グループへ 1 通 Push に変更 — REQUIREMENTS.md §12(F-5-3)通り
- `_notifyNewFacilityMonth` / `_notifyAllFacilitiesReady`: グループへ 1 通 Push に変更 — REQUIREMENTS.md §12(F-5-3)通り
- `handleSendReminders`: 変更なし(個別 Push 継続) — REQUIREMENTS.md §12(F-5-3)通り
- `_checkAndNotifyViableSlots`: can 票数 >= 4 の初回のみ通知、ScriptProperties でフラグ管理 — REQUIREMENTS.md §12(F-5-5)通り
- `_resetViableNotifiedSlotFlags`: `/配信` 実行時にフラグ全削除 — REQUIREMENTS.md §12(F-5-5)通り
- `handleTextMessage`: `source.type` チェックなしで `userId === ADMIN_USER_ID` 照合のみ → グループ内でも管理者コマンドが動作する — REQUIREMENTS.md §12(F-5-6)通り

### 2. ES5 準拠

✅ **合格**

`const`/`let`/アロー関数のコード使用なし(コメント内の `...` 表記はコメントのみで問題なし)。
`var` / `function` / `forEach` / IIFE など ES5 スタイルで統一されている。

### 3. エラーハンドリング

✅ **合格** (軽微な指摘あり)

- `handleJoin`: groupId 未取得時は warn ログのみ → 仕様通り
- `handleMemberJoined`: 1人失敗しても続行する設計 → 仕様通り
- `handleDistributeSurvey`: LINE_GROUP_ID 未設定時は warn ログを出して skipped: 1 を返す → 仕様通り
- `handleAggregateAndNotify`: 同上
- `_notifyNewFacilityMonth`: LINE_GROUP_ID 未設定は return / Push 失敗は re-throw → 呼び出し元で lastNotified 更新をスキップ(次回再試行設計・合理的)
- `_checkAndNotifyViableSlots`: 全体を try-catch で囲み、例外は re-throw しない → 回答送信処理に影響しない設計

🟡 **軽微な指摘1**: `handleMemberJoined` の `getLineProfile` にリトライなし
`handleFollow` では `withRetry` でラップしているが、`handleMemberJoined` では直接呼んでいる。
プロフィール取得失敗でも登録自体は続行されるため致命的ではない。
複数メンバーが一括参加する場合にリトライによるタイムアウトリスクが増すことも考慮すると、現状でも受容可能。

### 4. ログ出力の一貫性

✅ **合格**

`[INFO]` / `[WARN]` / `[ERROR]` 形式で既存コードと一貫している。
主要な処理の完了・スキップはすべてログに記録されている。

### 5. ScriptProperties キー管理

✅ **合格** (軽微な指摘あり)

`VIABLE_NOTIFIED_SLOT_` + スロットキーの命名は REQUIREMENTS.md §12(F-5-5)と一致。
`LINE_GROUP_ID` キーは REQUIREMENTS.md §12(F-5-2)と一致。
IMPLEMENTATION_F5.md に追加プロパティ一覧を記載済み。

🟡 **軽微な指摘2**: `_resetViableNotifiedSlotFlags` での `for...in` ループに `hasOwnProperty` チェックなし

```javascript
for (var key in props) {
  if (key.indexOf(prefix) === 0) { ... }
}
```

`getProperties()` が返すオブジェクトは GAS 内部の実装に依存するが、実際には `Object.prototype` を汚染しないためリスクはほぼゼロ。ただし、既存コードの `_saveScrapedMonths` では `hasOwnProperty` チェックを使っているため、一貫性のために追加することを推奨する。

### 6. 変更しないものへの影響

✅ **合格**

- `src/lineApi.js` が変更不要な理由が IMPLEMENTATION_F5.md に明記されている
- LIFF フォーム / スプレッドシートデータ構造 / スクレイピングロジックは変更なし
- `handleSendReminders` は変更なし
- `_checkAllRespondedAndNotify` は変更なし(全員回答後の自動集計・グループ送信に変わった `handleAggregateAndNotify` を呼ぶため自動的に対応)

---

## 提案(対応任意)

🟢 **提案1**: `handleMemberJoined` での `getLineProfile` を `withRetry` でラップする

```javascript
// 変更前
var profile = getLineProfile(userId);

// 変更後(handleFollow と同じスタイル)
var profile = withRetry(function () {
  return getLineProfile(userId);
}, { maxAttempts: DEFAULT_MAX_ATTEMPTS, baseDelayMs: 1000, label: 'getLineProfile' });
```

ネットワーク一時障害への耐性が向上する。

🟢 **提案2**: `_resetViableNotifiedSlotFlags` に `hasOwnProperty` チェックを追加

```javascript
for (var key in props) {
  if (props.hasOwnProperty(key) && key.indexOf(prefix) === 0) {
    keysToDelete.push(key);
  }
}
```

既存コード(`_saveScrapedMonths`)との一貫性が向上する。

---

## セルフリファイン採点: 46/50

- 機能要件との一致: 10/10
- ES5 準拠: 10/10  
- エラーハンドリング: 9/10 (リトライなし指摘)
- ログ一貫性: 9/10
- ScriptProperties 管理: 8/10 (hasOwnProperty 指摘)

---

## AI_KB 追記候補

なし
