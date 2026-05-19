# IMPLEMENTATION_F4.md — F-4 LIFF グリッドフォームリニューアル

**作成日**: 2026-05-14
**対応フィーチャー**: F-4(LIFF フォームのグリッド形式 UI + 2時間スロット単位データモデル)

---

## 1. 変更ファイル一覧

| ファイル | 変更種別 | 概要 |
|:--|:--|:--|
| `src/sheets.js` | 全体書き直し | F-4 新データモデル関数追加・旧関数後方互換維持 |
| `src/handlers.js` | 全体書き直し | `handleVote` no-op 化・`handleLiffGetData` / `handleLiffSubmitFast` / `handleLiffGetAllResponses` F-4 対応版に書き直し |
| `src/Code.js` | 追記 | `resetResponsesSheetForF4()` 追加 |
| `docs/liff.html` | 完全書き直し | F-4 グリッドフォーム UI |
| `docs/liffResults.html` | 完全書き直し | F-4 スロット単位の回答状況表示 |

---

## 2. sheets.js の変更内容

### F-4 新ヘッダー(`SLOT_RESPONSES_HEADER`)

```
A: responseId  — 主キー
B: userId      — LINE ユーザー ID
C: date        — YYYY-MM-DD
D: slotStart   — HH:mm (09:00 / 11:00 / 13:00 / 15:00 / 17:00 / 19:00 の6種固定)
E: answer      — 'can' / 'undecided'
F: createdAt   — ISO 8601 + Asia/Tokyo
G: updatedAt   — ISO 8601 + Asia/Tokyo
```

### 追加した F-4 新関数

- `getResponsesSheet()` — F-4 新ヘッダーで初期化するよう変更
- `_initializeSlotResponsesSheet(sheet)` — F-4 ヘッダー・列書式の初期化
- `resetResponsesSheet()` — シートを完全削除→再作成(F-4 移行用)
- `upsertSlotResponse(userId, date, slotStart, answer)` — 1スロット upsert(ロック付き)
- `_findSlotResponseRow(sheet, userId, date, slotStart)` — 内部検索
- `clearSlotResponsesByUserId(userId)` — ユーザーの全スロット回答を一括削除
- `getAllSlotResponses()` — 全レコードをオブジェクト配列で返す
- `getSlotResponsesByUserId(userId)` — `{ 'YYYY-MM-DD|HH:mm': 'can'|'undecided' }` 形式で返す

### 後方互換として残した旧関数

- `upsertResponse(userId, scheduleId, canAttend)` — F-1-4 互換
- `getResponsesByUserId(userId)` — F-3-4 互換(旧形式)
- `clearResponsesByUserId(userId)` — `clearSlotResponsesByUserId` に委譲
- `getAllResponses()` — `getAllSlotResponses()` をラップして旧形式で返す
- `getRespondedUserIds()` — `getAllSlotResponses()` ベースに変更

---

## 3. handlers.js の変更内容

### handleVote — no-op 化(D-018)

```javascript
function handleVote(event) {
  // D-018 でカルーセル廃止済み。postback は受け付けるが何もしない。
  console.log('[INFO] handleVote: deprecated since D-018, ignoring.');
}
```

### handleLiffGetData(userId) — F-4 グリッド形式に書き直し

返却形式:
```json
{
  "dates": [
    {
      "date": "2026-05-14",
      "dateLabel": "5/14(木)",
      "facilityInfo": "📍東総合 13〜21 / 鳥屋野 終日",
      "slots": [
        { "slotStart": "09:00", "available": false },
        { "slotStart": "13:00", "available": true }
      ]
    }
  ],
  "userAnswers": { "2026-05-14|13:00": "can" }
}
```

グレーアウト判定: `_isSlotAvailable(slotStart, daySchedules)` が担当。
- スロット終端(slotStart + 2h)が施設開放時間内に完全包含される場合 true
- note/startTime/endTime に「終日」が含まれる場合は全スロット true

施設情報1行: `_buildFacilityInfo(daySchedules)` が担当。
- `📍{名前} {時}〜{時} / ...` 形式

### handleLiffSubmitFast(userId, answers) — F-4 形式に書き直し

- answers キー: `'YYYY-MM-DD|HH:mm'` 形式
- `|` で分割して `date` と `slotStart` を取り出す
- `clearSlotResponsesByUserId` → `setValues` 一括挿入(高速化パターン踏襲)

### handleLiffGetAllResponses() — F-4 形式に書き直し

返却形式:
```json
{
  "dates": [ ... ],  // handleLiffGetData と同じ構造
  "responses": {
    "2026-05-14|13:00": { "can": ["田中", "佐藤"], "undecided": ["山田"] }
  }
}
```

### handleAggregateAndNotify() — F-4 スロット単位集計に対応

- `getAllSlotResponses()` で全回答取得
- `(date, slotStart)` キーごとに `answer === 'can'` の票数を集計
- 4人以上のスロットをアナウンス

---

## 4. Code.js の変更内容

追加した手動実行関数:
```javascript
function resetResponsesSheetForF4() {
  resetResponsesSheet();
  console.log('[INFO] responses シートをリセットしました（F-4 移行）');
}
```

---

## 5. docs/liff.html の変更内容(F-4 グリッドフォーム)

### UI 仕様実装済み

- ヘッダー: 緑(#06C755)「バドミントン 日程回答」
- 日付ブロック: 日付ラベル + 施設情報行 + 6スロットボタン横並び
- グレーアウト: `background:#e0e0e0; color:#aaa; pointer-events:none`
- 未選択: 白背景・グレー枠
- ○ 選択済み: 緑(#06C755)・白文字・「○ 9時」テキスト
- △ 選択済み: グレー(#757575)・白文字・「△ 9時」テキスト
- タップサイクル: 空欄 → ○ → △ → 空欄(AC-16)
- 送信ボタン: fixed 固定(画面下部)
- 前回答復元: `userAnswers` を `answers` オブジェクトに読み込み(AC-18)

### API 呼び出し

```javascript
fetch(GAS_API_URL + '?liff=getSchedules&idToken=...')
fetch(GAS_API_URL + '?liff=submit&idToken=...&answers=...')
```

### 設定値

```javascript
var LIFF_ID     = '2010067159-goZKGxNN';
var GAS_API_URL = 'https://script.google.com/macros/s/AKfycbz0gRzFCoweztAOeYg5u5Y7TNOfFGhBXApUV59neZgtiVF_UZxUO7uC1BWdy3rUGrMjSw/exec';
```

---

## 6. docs/liffResults.html の変更内容(F-4 スロット単位表示)

### UI 仕様実装済み

- 日付ブロックごとに6スロット分を縦一覧表示
- 各スロット行: 時間ラベル + ○行(can 一覧) + △行(undecided 一覧)
- グレーアウトスロット(available:false): 「施設利用不可」と表示
- バッジ: ○=緑(#06C755)、△=グレー(#757575)

### 設定値

```javascript
var LIFF_ID     = '2010067159-k09pLDMl';
var GAS_API_URL = 'https://script.google.com/macros/s/AKfycbz0gRzFCoweztAOeYg5u5Y7TNOfFGhBXApUV59neZgtiVF_UZxUO7uC1BWdy3rUGrMjSw/exec';
```

---

## 7. セルフリファイン評価

- **整合性チェック**:
  - `handleVote` no-op 化 → `_routeEvent` の `case 'postback'` から呼ばれるが no-op なので問題なし
  - `getSchedules()` / `handleDistributeSurvey()` / メンバー管理 → responses シートを触らないので影響なし
  - `clearResponsesByUserId` は `clearSlotResponsesByUserId` に委譲しており後方互換を維持
  - `getAllResponses()` は旧フォーマット互換マッピングを提供
- **F-4-5 不変制約対応**:
  - スロット6種固定: `SLOT_STARTS = ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00']`
  - グレーアウト判定はスロット全体の完全包含で判断
- **セルフリファイン点数**: 44 / 50

---

## 8. 引き継ぎ情報(テスト・レビュー向け)

### 手動実行が必要な作業

1. GAS エディタで `resetResponsesSheetForF4()` を実行 → responses シートを F-4 形式にリセット
2. clasp push で GAS にデプロイ
3. GitHub Pages の `docs/liff.html` と `docs/liffResults.html` を git push

### テスト時の注意

- schedules シートに `startTime` / `endTime` が `HH:mm` 形式で入っていること
- 「終日」は `note` 列 または `startTime` / `endTime` に「終日」文字列が含まれていること
- responses シートが新ヘッダー(7列)になっていることを確認してからテスト
