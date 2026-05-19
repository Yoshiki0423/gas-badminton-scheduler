# 実装設計書 — Phase 3 LIFF UX リニューアル

**作成日**: 2026-05-12
**スコープ**: F-3-4（LIFF 回答フォーム）/ F-3-5（LIFF 回答状況確認）/ F-3-6（Bot メッセージ 2 ボタン化）
**前提**: REQUIREMENTS.md v0.5 承認済み（critic-ja 85/100）/ DECISION_NOTES.md D-017・D-018 追記済み

---

## 1. ファイル構成（変更後）

```
src/
├── Code.js          — 変更: doGet() をLIFF ルーターに / google.script.run 用サーバー関数追加
├── handlers.js      — 変更: distributeSurvey/Reminder を2ボタン化 / LIFF ハンドラー追加
├── lineApi.js       — 変更: verifyLineIdToken() 追加
├── sheets.js        — 変更: upsertResponse に canAttend 引数追加 / LIFF 用 get/delete 関数追加
├── liff.html        — 新規: LIFF 回答フォーム（F-3-4）
└── liffResults.html — 新規: LIFF 回答状況確認ページ（F-3-5）
utils.js             — 変更なし
```

---

## 2. 新規作成ファイル

### 2-1. `src/liff.html`（F-3-4 回答フォーム）

GAS の `HtmlService.createTemplateFromFile('liff')` で配信する LIFF ページ。

**サーバー側テンプレート変数（GAS で埋め込み）：**
| 変数 | 内容 |
|:--|:--|
| `liffId` | スクリプトプロパティ `LIFF_FORM_ID` の値 |

**クライアント動作フロー：**
1. LIFF SDK 読み込み → `liff.init({ liffId })` → ログイン済みチェック
2. `liff.getIDToken()` でトークン取得
3. `google.script.run.liffGetSchedulesAndResponses(idToken)` → サーバーからスケジュール一覧 + 当該ユーザーの回答を JSON で受け取る
4. 一覧をレンダリング（各スケジューに「行ける」「未定」トグルボタン）
5. 前回の回答がある場合、対応するボタンを選択済み状態で表示（AC-10 対応）
6. `[送信する]` タップ → `google.script.run.liffSubmitResponses(idToken, answers)` → 完了メッセージ表示 → `liff.closeWindow()`（AC-11：チャットにメッセージを返さない）

**`answers` の型：**
```
{ scheduleId1: 'can', scheduleId2: 'undecided', ... }
// 未選択のスケジュールは含まれない
```

### 2-2. `src/liffResults.html`（F-3-5 回答状況確認）

**サーバー側テンプレート変数：**
| 変数 | 内容 |
|:--|:--|
| `liffId` | スクリプトプロパティ `LIFF_RESULTS_ID` の値 |

**クライアント動作フロー：**
1. LIFF SDK → `liff.init()` → `liff.getIDToken()`
2. `google.script.run.liffGetAllResponses(idToken)` → サーバーから全回答状況を受け取る
3. スケジュールごとに「行ける：〇〇・〇〇 / 未定：〇〇」形式で表示（AC-12）

---

## 3. 既存ファイルへの変更

### 3-1. `src/Code.js`

**変更1: `doGet()` を LIFF ページルーターに変更**

```
現在: 常に "gas-badminton-scheduler is running." テキストを返す
変更後:
  ?page=form    → liff.html を HtmlService で配信（XFrameOptionsMode.ALLOWALL 付き）
  ?page=results → liffResults.html を HtmlService で配信
  (それ以外)    → 従来のヘルスチェックテキストを返す（後方互換）
```

**変更2: `google.script.run` 用サーバー関数を追加**

| 関数名 | 役割 |
|:--|:--|
| `liffGetSchedulesAndResponses(idToken)` | IDToken 検証 → 直近14日スケジュール + 当該ユーザーの回答を返す |
| `liffSubmitResponses(idToken, answers)` | IDToken 検証 → `handleLiffSubmit()` を呼ぶ |
| `liffGetAllResponses(idToken)` | IDToken 検証 → `handleLiffGetAllResponses()` を呼ぶ |

これらの関数は `handlers.js` の実装関数に処理を委譲する（Code.js はルーティングのみ）。

**変更なし：**
- `doPost()` — LINE Webhook 処理は一切変えない
- `distributeSurvey()` / `sendReminders()` / `aggregateAndNotify()` の外側シェル

---

### 3-2. `src/handlers.js`

**変更1（F-3-6）: `handleDistributeSurvey()` のメッセージ内容**

```
現在: Flex Message Carousel（スケジュールごとにボタンを並べる）を pushFlexMessage で送信
変更後: テキスト + 2ボタン Flex Message を送信
```

2ボタン Flex の構造（Bubble 1枚）：
```json
{
  "type": "bubble",
  "body": {
    "type": "box",
    "layout": "vertical",
    "contents": [
      { "type": "text", "text": "直近のスケジュールが届きました！", "wrap": true }
    ]
  },
  "footer": {
    "type": "box",
    "layout": "horizontal",
    "contents": [
      { "type": "button", "action": { "type": "uri", "label": "回答する", "uri": "<LIFF_FORM_URL>" } },
      { "type": "button", "action": { "type": "uri", "label": "回答状況を見る", "uri": "<LIFF_RESULTS_URL>" } }
    ]
  }
}
```

LIFF URL の形式: `https://liff.line.me/{LIFF_ID}`  
スクリプトプロパティ `LIFF_FORM_ID` / `LIFF_RESULTS_ID` から生成。

**変更2（F-3-6）: `handleSendReminders()` のメッセージ内容**

同じ2ボタン Flex + リマインドテキストに変更（Flex Carousel 廃止）。

**既存で使われなくなる内部関数：**
- `_buildSurveyFlex()` — 配信・リマインドから呼ばれなくなる
- `_buildSurveyBubble()` — 同上

> ただし `handleVote`（postback 処理）は残す。既存の postback 回答は引き続き動く設計（後方互換）。

**追加1: `handleLiffGetData(userId)`**

スケジュールと当該ユーザーの回答を JSON で返す。

```javascript
// 戻り値の型
{
  schedules: [
    { scheduleId, date, startTime, endTime, facilityName }  // 直近14日に絞る
  ],
  userAnswers: {
    'SCH_xxx': 'can',       // 行ける
    'SCH_yyy': 'undecided'  // 未定
    // 未回答スケジュールはキーなし
  }
}
```

**追加2: `handleLiffSubmit(userId, answers)`**

```javascript
// answers: { scheduleId: 'can' | 'undecided' } のオブジェクト
// 処理フロー:
//   1. userId の既存回答を全削除（clearResponsesByUserId）
//   2. answers の各エントリを upsertResponse で挿入
//      'can' → canAttend=true, 'undecided' → canAttend='undecided'
```

**追加3: `handleLiffGetAllResponses()`**

```javascript
// 戻り値の型
{
  schedules: [{ scheduleId, date, startTime, endTime, facilityName }],
  responses: {
    'SCH_xxx': {
      can: ['田中', '佐藤'],      // 行ける人の displayName リスト
      undecided: ['山田']          // 未定の人の displayName リスト
    }
  }
}
```

`members` シートの `displayName` を使う（LINE API を都度叩かない）。

---

### 3-3. `src/sheets.js`

**変更1: `upsertResponse(userId, scheduleId, canAttend)` の引数追加**

```
現在: upsertResponse(userId, scheduleId) — 常に canAttend=true を書き込む
変更後: upsertResponse(userId, scheduleId, canAttend) — 第3引数を書き込む
         canAttend のデフォルト値 = true（後方互換・handleVote は変更なし）
```

**追加1: `getResponsesByUserId(userId)`**

当該ユーザーの全回答を返す。LIFF フォームの前回答復元に使う。

```javascript
// 戻り値: [{ scheduleId, canAttend }, ...]
```

**追加2: `clearResponsesByUserId(userId)`**

当該ユーザーの全回答行を削除する。LIFF 一括送信時の「全削除→再挿入」パターンに使う。

---

### 3-4. `src/lineApi.js`

**追加: `verifyLineIdToken(idToken)`**

LINE の ID Token 検証エンドポイントを呼んで userId と displayName を返す。

- エンドポイント: `POST https://api.line.me/oauth2/v2.1/verify`
- 送信パラメータ: `id_token=xxx&client_id={LINE_CHANNEL_ID}`
- スクリプトプロパティ `LINE_CHANNEL_ID`（= LINE Developers コンソールのチャネル ID）が必要
- 戻り値: `{ userId: string, displayName: string }` or `null`（検証失敗）

---

## 4. スクリプトプロパティ（新規追加分）

| キー | 値の例 | 用途 |
|:--|:--|:--|
| `LIFF_FORM_ID` | `1234567890-AbCdEfGh` | 回答フォーム LIFF ID |
| `LIFF_RESULTS_ID` | `1234567890-IjKlMnOp` | 回答状況確認 LIFF ID |
| `LINE_CHANNEL_ID` | `1234567890` | ID Token 検証用チャネル ID |

---

## 5. responses シートのスキーマ互換性

**変更なし（列追加不要）**

| canAttend 列の値 | 意味 | 書き込む処理 |
|:--|:--|:--|
| `true`（bool） | 行ける | handleVote（既存）/ LIFF 行ける |
| `'undecided'`（文字列） | 未定 | LIFF 未定 |
| 行なし | 行けない（無回答） | — |

`handleAggregateAndNotify()` は `r.canAttend === true` でフィルタしているため、`'undecided'` は集計から除外される（後方互換 OK）。

---

## 6. 実装順序（推奨）

1. **lineApi.js** — `verifyLineIdToken` を追加（他の変更が依存するため最初）
2. **sheets.js** — `upsertResponse` 引数追加 + `getResponsesByUserId` + `clearResponsesByUserId` を追加
3. **handlers.js** — LIFF ハンドラー3関数を追加 + distributeSurvey/Reminder を2ボタン化
4. **Code.js** — `doGet` ルーター変更 + `google.script.run` 用サーバー関数追加
5. **liff.html** — LIFF 回答フォーム HTML を作成
6. **liffResults.html** — LIFF 回答状況確認 HTML を作成

---

## 7. 設計の判断根拠

### D-019 候補: `google.script.run` を採用する理由

LIFF HTML → GAS サーバー の通信方法として `fetch()` + CORS 対応ではなく `google.script.run` を採用する。

| 方法 | CORS | 認証 | コード量 |
|:--|:--|:--|:--|
| fetch() + ContentService JSON | 要 CORS ヘッダー対応（GAS は困難） | 手動でトークンを URL に渡す | 多い |
| `google.script.run` | 不要（GAS ホスト内通信） | 自動 | 少ない |

→ GAS が自分でホストした HTML から呼ぶ場合は `google.script.run` が正攻法。

### D-020 候補: 回答送信は「全削除→再挿入」パターン

LIFF フォームは全スケジュールを一括送信する。「差分更新」より「全削除→再挿入」の方が:
- ロジックが単純（各スケジュールの状態を個別比較しなくてよい）
- 「前回行けると答えたが今回は何も選ばなかった」= 行けないへの変更も自然に処理できる

### D-021 候補: `_buildSurveyFlex` / `_buildSurveyBubble` は削除せず残す

D-018（Flex Carousel 廃止）で配信・リマインドからは呼ばれなくなるが、デバッグや将来復活の可能性を考慮してコードは残す（ただし呼び出し箇所からは削除）。

---

## 8. 受け入れ条件との対応

| AC | 対応する実装箇所 |
|:--|:--|
| AC-9（フォームが開く・14日分表示） | liff.html + handleLiffGetData |
| AC-10（前回答の復元） | getResponsesByUserId → liff.html がボタン選択状態を復元 |
| AC-11（送信後に Bot メッセージなし） | handleLiffSubmit は LINE API を呼ばない |
| AC-12（全員の回答一覧） | liffResults.html + handleLiffGetAllResponses |
| AC-13（2ボタン形式配信） | handleDistributeSurvey + handleSendReminders の変更 |

---

## v1.1（2026-05-12）: 実装完了記録

**実装完了日**: 2026-05-12
**実装担当**: developer-ja（dev-orchestrator-ja 経由）

### 実装した変更サマリ

| ファイル | 変更内容 |
|:--|:--|
| `src/lineApi.js` | `verifyLineIdToken(idToken)` を追加。LINE_CHANNEL_ID プロパティを使用。|
| `src/sheets.js` | `upsertResponse` に第3引数 `canAttend`（デフォルト=true）を追加。`getResponsesByUserId` / `clearResponsesByUserId` を追加。後方互換維持。|
| `src/handlers.js` | `_buildTwoButtonFlex` 追加。`handleDistributeSurvey` / `handleSendReminders` を2ボタン化。`handleLiffGetData` / `handleLiffSubmit` / `handleLiffGetAllResponses` を追加。|
| `src/Code.js` | `doGet()` をLIFFルーターに変更（?page=form / ?page=results / その他）。`liffGetSchedulesAndResponses` / `liffSubmitResponses` / `liffGetAllResponses` を追加。|
| `src/liff.html` | 新規作成。LIFF SDK 初期化・スケジュール表示・行ける/未定ボタン・送信処理。|
| `src/liffResults.html` | 新規作成。LIFF SDK 初期化・全員の回答状況表示。|

### 後方互換の確認

- `handleVote()` は `upsertResponse(userId, scheduleId)` と第3引数なしで呼ぶ → デフォルト値 `true` が使われ動作変わらず
- `_buildSurveyFlex()` / `_buildSurveyBubble()` は残存(呼ばれないが削除しない・D-021)
- `doGet()` のデフォルト(page パラメータなし)はヘルスチェックテキストを維持
