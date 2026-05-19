# 実装メモ — F-5: グループトーク移行

**実装日**: 2026-05-15
**対象フェーズ**: F-5(アーキテクチャ変更)
**参照**: REQUIREMENTS.md §12

---

## 変更ファイル一覧

| ファイル | 変更内容 |
|:--|:--|
| `src/Code.js` | `_routeEvent` に `join`/`memberJoined` 追加、`liffSubmitResponses` と `_handleLiffApi(submit)` に `_checkAndNotifyViableSlots()` 呼び出し追加 |
| `src/handlers.js` | `handleJoin` / `handleMemberJoined` / `_checkAndNotifyViableSlots` / `_resetViableNotifiedSlotFlags` を新規追加。`handleDistributeSurvey` / `handleAggregateAndNotify` をグループ送信に変更 |
| `src/scraper.js` | `_notifyNewFacilityMonth` / `_notifyAllFacilitiesReady` をグループ送信に変更 |
| `src/lineApi.js` | 変更なし(LINEのPush APIはuserId/groupId同一エンドポイントのため対応不要) |

---

## 実装詳細

### Code.js の変更

#### 1. `_routeEvent` への2イベント追加

```javascript
case 'join':
  handleJoin(event);
  break;
case 'memberJoined':
  handleMemberJoined(event);
  break;
```

#### 2. `liffSubmitResponses` の末尾

```javascript
var result = handleLiffSubmitFast(identity.userId, answers);
// F-5: 回答送信後に「4人以上即通知」チェックを実行する
_checkAndNotifyViableSlots();
return result;
```

#### 3. `_handleLiffApi` の `submit` アクション末尾

```javascript
var result = handleLiffSubmitFast(identity.userId, answers);
// F-5: 回答送信後に「4人以上即通知」チェックを実行する
_checkAndNotifyViableSlots();
return _jsonResponse({ ok: true, data: result });
```

---

### handlers.js の変更・追加

#### 追加: `handleJoin(event)`

- `event.source.groupId` を ScriptProperties の `LINE_GROUP_ID` に保存する
- groupId が取得できない場合は warn ログのみ
- グループへのメッセージ送信は行わない(仕様通り)

#### 追加: `handleMemberJoined(event)`

- `event.joined.members` をループして各メンバーを処理
- `type === 'user'` のメンバーのみ対象
- `getLineProfile(userId)` で displayName を取得(失敗時は「名前不明」)
- `upsertMemberAsActive(userId, displayName)` でメンバーシートに登録
- 1人失敗しても次のメンバーへ続行

#### 変更: `handleDistributeSurvey`

- 変更前: 全 active メンバーにループして個別 Push
- 変更後: `LINE_GROUP_ID` を取得してグループに 1 通 Push
- **追加**: `_resetViableNotifiedSlotFlags()` を冒頭で呼び出し(4人以上即通知フラグのリセット)
- LINE_GROUP_ID が未設定の場合: warn ログを出して `{ sent: 0, skipped: 1 }` を返す

#### 追加: `_resetViableNotifiedSlotFlags()`

- `VIABLE_NOTIFIED_SLOT_` で始まる全 ScriptProperties キーを削除する
- 新しいアンケートが始まるタイミングで呼ばれる

#### 変更: `handleAggregateAndNotify`

- 変更前: 全 active メンバーにループして個別 Push
- 変更後: `LINE_GROUP_ID` を取得してグループに 1 通 Push
- LINE_GROUP_ID が未設定の場合: warn ログを出して `{ viable: N, sent: 0, skipped: 1 }` を返す

#### 変更: `handleTextMessage`

- 現状のコードは `source.type` チェックをしていないため変更不要
- `userId !== adminUserId` のチェックは継続(グループでも管理者のみ使用可能)
- `/配信` コマンドの返信メッセージを「送信: N人」→「送信: N件」に修正(グループ送信の場合は「1件」)

#### 追加: `_checkAndNotifyViableSlots()`

処理フロー:
1. `LINE_GROUP_ID` を確認。未設定ならログのみで return
2. `getAllSlotResponses()` で全回答を取得
3. スロットごとに `can` 票数を集計
4. `MIN_ATTENDEES`(4) 以上かつ未通知のスロットを抽出
5. 未通知スロットがあれば 1 通にまとめてグループに通知
6. 通知済みスロットに `VIABLE_NOTIFIED_SLOT_<date>|<slotStart>` = `'true'` を保存
7. 例外が発生しても呼び出し元に伝えない(try-catch で囲む)

通知メッセージ形式:
```
4人以上参加できる時間帯が見つかりました！🏸

・5/15(土) 17:00〜19:00（○4人）
・5/16(日) 13:00〜15:00（○5人）
```

---

### scraper.js の変更

#### 変更: `_notifyNewFacilityMonth`

- 変更前: 全 active メンバーにループして個別 Push
- 変更後: `LINE_GROUP_ID` を取得してグループに 1 通 Push
- LINE_GROUP_ID が未設定の場合: warn ログを出して return
- Push 失敗時: logError して re-throw する(呼び出し元が lastNotified の更新をスキップするため)

#### 変更: `_notifyAllFacilitiesReady`

- 変更前: 全 active メンバーにループして個別 Push
- 変更後: `LINE_GROUP_ID` を取得してグループに 1 通 Push
- LINE_GROUP_ID が未設定の場合: warn ログを出して return
- Push 失敗時: logError して re-throw する(呼び出し元が ALL_FACILITIES_NOTIFIED_MONTH の更新をスキップするため)

---

### lineApi.js の確認結果

`pushText(to, text)` と `pushFlexMessage(to, altText, contents)` は、
`to` フィールドに userId でも groupId でも同じ LINE Push API エンドポイントに送信する。
LINE のPush APIは userId と groupId を区別しないため、変更不要。

---

## スクリプトプロパティの追加

F-5 実装で新たに使用するプロパティ:

| キー | 型 | 説明 |
|:--|:--|:--|
| `LINE_GROUP_ID` | string | Bot が参加しているグループのID。`join` イベントで自動設定される |
| `VIABLE_NOTIFIED_SLOT_YYYY-MM-DD\|HH:mm` | 'true' | 4人以上即通知済みスロットのフラグ。`handleDistributeSurvey` 時にリセット |

---

## 既存機能への影響

| 機能 | 影響 |
|:--|:--|
| リマインド (`handleSendReminders`) | 変更なし。未回答者への個別 Push を継続 |
| LIFF フォーム | 変更なし |
| LIFF 回答状況確認ページ | 変更なし |
| スクレイピングロジック | 変更なし |
| スプレッドシートのデータ構造 | 変更なし |
| 管理者コマンド | グループからでも動作する(既存の実装でも動作する・変更不要) |

---

## 設計判断メモ

### 1. `handleFollow` を残す理由
1対1チャットへの個別 follow イベントは引き続き発火する可能性があるため後方互換として残す。

### 2. `_checkAndNotifyViableSlots` の配置
`Code.js` に置かず `handlers.js` に置く理由: handlers.js が業務ロジックの置き場所という設計方針に従う。Code.js から呼ばれる関数名 `_checkAndNotifyViableSlots` は、GAS の同一スクリプトプロジェクト内ではファイルをまたいで参照できる。

### 3. `_notifyNewFacilityMonth` の re-throw
変更前はループで1人失敗しても続行する設計だった。変更後はグループに1通送るだけなので、失敗したら呼び出し元に伝えて `lastNotified` の更新をスキップする（次回再試行できるようにする）設計に変更した。

### 4. undecided は `_checkAndNotifyViableSlots` で考慮しない
REQUIREMENTS.md §12 の「4人以上即通知」の発火条件は「`can` 票数が MIN_ATTENDEES 以上」。undecided は含まない。これは最終集計(`handleAggregateAndNotify`)での「○＋△で4人以上」とは異なる判定基準。
