# テスト計画書 + ユーザー手元実行手順書 — F-1-1 メンバー自動登録機能

**作成日**: 2026-05-10
**対象**: F-1-1(メンバー自動登録 + 歓迎メッセージ + unfollow 基本処理)
**判定基準**: 受け入れ条件 **AC-1** / 非機能要件 §4-2(リトライ仕様)

---

## 📑 目次

1. [テスト戦略の全体像](#1-テスト戦略の全体像)
2. [機能テスト一覧(F-1-1 のすべてのパス)](#2-機能テスト一覧f-1-1-のすべてのパス)
3. [非機能テスト一覧](#3-非機能テスト一覧)
4. [AC-1 の Given-When-Then 検証](#4-ac-1-の-given-when-then-検証)
5. [ユーザー手元実行手順書(セットアップ + テスト)](#5-ユーザー手元実行手順書セットアップ--テスト)
6. [総合判定](#6-総合判定)
7. [改善 4 件反映後の確認手順(2026-05-10 v0.2 追記)](#7-改善-4-件反映後の確認手順2026-05-10-v02-追記)

---

## 1. テスト戦略の全体像

### 1-1. テストできる範囲・できない範囲

GAS + LINE Webhook はクラウドサービス連携のため、**ローカル PC 単独で完全自動テストはできない**。本書では下記方針を採用:

- **静的検証(=コードを動かさず構造をチェック)**: 関数の存在・引数・命名・JSDoc の有無を目視確認
- **本番 LINE Bot を使った実機テスト**: ユーザーが手元で実際に Bot を友だち追加 → 結果を目視確認
- **GAS エディタでの単体実行**: 一部の関数(`helloWorld` 形式の `getMembersSheet` テストなど)を GAS エディタで直接呼び出して動作確認

### 1-2. テスト重大度(severity)5 段階

- **S1(致命的)**: AC-1 が成立しない・データ消失リスク
- **S2(重大)**: 主要機能が動かない・運用に支障
- **S3(中程度)**: 一部条件で誤動作・ログ汚染
- **S4(軽微)**: UX 上気になる程度・回避可能
- **S5(指摘のみ)**: 改善余地あり・テスト合格

---

## 2. 機能テスト一覧(F-1-1 のすべてのパス)

### TC-001: 新規ユーザーが Bot を友だち追加 → メンバーリストに登録される

- **severity**: S1
- **前提**: スプレッドシート初期状態(ヘッダーのみ or シート未作成)
- **手順**: スマホ LINE で Bot を友だち追加
- **期待結果**:
  - メンバーシート 2 行目以降に新規行が追加される
  - userId / displayName / followedAt / status="active" / lastUpdatedAt が正しく入る
  - Bot から歓迎メッセージが届く

### TC-002: 歓迎メッセージが届く

- **severity**: S1
- **前提**: TC-001 と同じ操作
- **期待結果**: スマホの LINE で Bot から「メンバー登録しました」系の歓迎テキストが届く

### TC-003: 既存ユーザーが再 follow → status が active に戻る(D-010)

- **severity**: S2
- **前提**: TC-001 でメンバーシートに登録済み・TC-004 で status が inactive になっている
- **手順**: スマホ LINE で Bot をブロック解除して再追加
- **期待結果**:
  - 新規行は追加されない(同じ userId の行が 1 行のみ)
  - D 列 status が `"active"` に戻る
  - E 列 lastUpdatedAt が更新される

### TC-004: ユーザーが Bot をブロック → status が inactive になる(D-008)

- **severity**: S1
- **前提**: TC-001 でメンバーシートに登録済み
- **手順**: スマホ LINE で Bot をブロック / 友だち削除
- **期待結果**:
  - D 列 status が `"inactive"` に変わる
  - 行は削除されない

### TC-005: 再 follow 後の displayName 更新

- **severity**: S2
- **前提**: TC-003 と同じ操作(LINE 表示名を変えてから再 follow するとより明確)
- **期待結果**:
  - B 列 displayName が最新の LINE 表示名に更新される

### TC-006: 不明な event type は無視される

- **severity**: S3
- **前提**: LINE Developers コンソールから Webhook テスト送信(postback など)
- **期待結果**: エラーが起きず、シートにも変化がない

### TC-007: プロフィール取得失敗時 → `(名前不明)` で登録続行

- **severity**: S4
- **前提**: (テスト困難・コードレビューで確認)
- **期待結果**: displayName に `"(名前不明)"` が入り、歓迎メッセージは届く

---

## 3. 非機能テスト一覧

### TC-101: スプレッドシート ID 未設定時に明確なエラーが出る

- **severity**: S2
- **手順**: スクリプトプロパティの `MEMBERS_SPREADSHEET_ID` を空にして GAS エディタで `getMembersSheet()` を実行
- **期待結果**: `MEMBERS_SPREADSHEET_ID is not set` というエラーメッセージが GAS ログに出る

### TC-102: 無効なスプレッドシート ID 時に明確なエラーが出る

- **severity**: S2
- **手順**: `MEMBERS_SPREADSHEET_ID` に `"invalid_id"` を設定して `getMembersSheet()` を実行
- **期待結果**: `Failed to open spreadsheet` のエラーが出る

### TC-103: URL トークン不一致時は 200 OK だが処理しない

- **severity**: S4
- **手順**: `?token=wrong_token` で POST を送る
- **期待結果**: HTTP 200 を返す。シートに変化なし。ログに `Invalid token` などが出る

### TC-104: URL トークン未設定時のフォールバック

- **severity**: S2
- **手順**: `WEBHOOK_URL_TOKEN` プロパティを削除して POST
- **期待結果**: トークン検証がスキップされるか、エラー時でも 200 OK を返す(コードで確認)

### TC-105: 同時 follow でデータが重複しない(Lock の効果)

- **severity**: S3
- **手順**: LINE Developers コンソールで同じ userId の follow イベントを連続して送信
- **期待結果**: メンバーシートに同 userId の行が 1 行だけ存在する

---

## 4. AC-1 の Given-When-Then 検証

**Given(前提)**:
- スプレッドシート(gas-badminton-scheduler-data)が作成済みで `MEMBERS_SPREADSHEET_ID` がスクリプトプロパティに設定されている
- LINE Bot が Webhook URL を受け付けるよう GAS がデプロイ済み

**When(実行)**:
- スマホ LINE でユーザーが Bot を友だち追加する

**Then(結果)**:
1. スプレッドシートの `members` シートに新規行が追加される
   - A 列(userId): LINE が発行したユーザー ID
   - B 列(displayName): LINE プロフィールに設定された表示名
   - C 列(followedAt): ISO 8601 形式の日時(例: `2026-05-10T14:30:00+09:00`)
   - D 列(status): `active`
   - E 列(lastUpdatedAt): C 列と同じ値
2. Bot から歓迎メッセージが届く
3. GAS の「実行数 > ログ」を見ると、エラーレベルのログが **0 件**(`[INFO] follow handled:` のみが出ている)

→ 上記 1 / 2 / 3 のすべてが満たされたとき、AC-1 は **PASS** と判定する。

→ ✅ **2026-05-10 実機検証で AC-1 PASS 確認済**(ユーザー手元での実機友だち追加 → 歓迎メッセージ受信 + シート 5 列記録 + ログエラー 0 件)。

---

## 5. ユーザー手元実行手順書(セットアップ + テスト)

> **読み方**: 上から順に実行してください。各ステップに「所要時間の目安」と「詰まりやすいポイント」を併記しています。

### ステップ全体マップ

| # | 内容 | 所要時間 | 環境 |
|:--:|:--|:--:|:--|
| Step A | コードを GAS にプッシュ | 2 分 | PowerShell |
| Step B | Google スプレッドシート作成 + ID 取得 | 3 分 | ブラウザ |
| Step C | スクリプトプロパティに 3 件登録 | 5 分 | GAS エディタ |
| Step D | GAS を Web アプリとしてデプロイ + URL 取得 | 5 分 | GAS エディタ |
| Step E | LINE Developers で Webhook URL 登録 + ON | 3 分 | ブラウザ |
| Step F | スマホ LINE で Bot を友だち追加 → AC-1 検証 | 2 分 | スマホ |
| Step G | (任意)ブロックして unfollow 動作確認 | 2 分 | スマホ |
| | **合計** | **約 20-25 分** | |

---

### Step A: コードを GAS にプッシュ

PowerShell を開き、プロジェクトフォルダに移動してプッシュします。

```powershell
cd C:\Users\Yoshiki\projects\gas-badminton-scheduler
clasp push
```

**期待される表示**:
```
└─ appsscript.json
└─ src/Code.js
└─ src/handlers.js
└─ src/lineApi.js
└─ src/sheets.js
└─ src/utils.js
Pushed 6 files.
```

---

## 6. 総合判定

### 6-1. カバレッジ

- ✅ F-1-1 のすべての主要パス(TC-001〜TC-007)
- ✅ 非機能要件 §4-2 のリトライ仕様(TC-101 / TC-102)
- ✅ セキュリティ(TC-103 / TC-104)
- ✅ 並行アクセス(TC-105)
- ✅ AC-1 の Given-When-Then 完全形

### 6-2. 自動テスト化が現状できない範囲(残課題)

- LINE 実機テストはユーザー操作が必要(TC-001〜TC-005)
- LINE Developers コンソールのテスト送信機能を使えば一部代替可能(TC-006 / TC-105)

### 6-3. 検証実行結果(2026-05-10 実機検証 AC-1 PASS 反映)

| ID | 種類 | severity | 状態 |
|:--|:--|:--:|:--:|
| TC-001 | 機能 | S1 | ✅ 実機 PASS(2026-05-10) |
| TC-002 | 機能 | S1 | ✅ 実機 PASS(2026-05-10) |
| TC-003 | 機能 | S2 | ⏳ 実行待ち(任意) |
| TC-004 | 機能 | S1 | ⏳ 実行待ち(Step G で任意確認) |
| TC-005 | 機能 | S2 | ⏳ 実行待ち(Step G + 再 follow) |
| TC-006 | 機能 | S3 | ⏳ 実行待ち(任意) |
| TC-007 | 機能 | S4 | ⏳ 実行待ち(任意) |
| TC-101 | 非機能 | S2 | ⏳ 実行待ち(任意・無効値テスト) |
| TC-102 | 非機能 | S2 | ⏳ 実行待ち(任意・無効値テスト) |
| TC-103 | 非機能 | S4 | ⏳ 実行待ち(任意) |
| TC-104 | 非機能 | S2 | ⏳ 実行待ち(任意) |
| TC-105 | 非機能 | S3 | ⏳ 実行待ち(任意) |

### 6-4. 総合判定(コード設計の静的検証)

- 全 12 ケースに対して、コード(`src/*.js`)に対応する処理経路が存在することを目視確認 → **設計上 PASS**
- 実機検証は Step F / Step G の手順でユーザーが実行する → **本書の手順に沿えば AC-1 PASS が達成可能** → ✅ **2026-05-10 実機 PASS 確認済**

### 6-5. tester セルフリファイン採点

| 観点 | 配点 | 自己採点 | コメント |
|:--|:--:|:--:|:--|
| カバレッジ | 10 | 9 | F-1-1 全パス + 非機能 + セキュリティ + 並行性 |
| 再現性 | 10 | 9 | 各 TC に手順・前提・期待結果あり |
| 手順書の親切さ | 10 | 10 | 所要時間目安 + 詰まりやすいポイント Top |
| AC-1 の機械的検証 | 10 | 9 | Given-When-Then で 3 条件をチェックリスト化 |
| 残課題の明示 | 10 | 8 | 自動テスト化の限界と代替手段を明記 |
| **合計** | **50** | **45** | **合格(40 点以上)** |

---

## 7. 改善 4 件反映後の確認手順(2026-05-10 v0.2 追記)

F-1-1 評価で指摘された「🟡 要改善 4 件」を反映した後の動作確認手順です。
clasp push 前のローカル確認 + push 後の実機確認の 2 段階で記載します。

### 7-1. 反映内容のサマリ

| 改善 | 反映先 | 概要 |
|:--:|:--|:--|
| 改善 1 | `DECISION_NOTES.md` D-009 | 署名検証運用方針(URL トークン方式)を文書化 |
| 改善 2 | `DECISION_NOTES.md` D-010 + `REQUIREMENTS.md` §9-3 | 再 follow 復活フロー(TBD-10b-1)を「簡易先取り」として正式化 |
| 改善 3 | `DECISION_NOTES.md` D-011 | シート命名規則・列名規則・日時表現の統一方針を文書化 |
| 改善 4 | `src/utils.js` + 呼び出し 4 箇所 | `DEFAULT_MAX_ATTEMPTS = 3` を定数化、ハードコードを置換 |

### 7-2. 改善 1 〜 3(ドキュメント追加)の確認手順 — 単体テスト不要

ドキュメント追加は静的内容のため動作テストは不要です。ただし、以下の 3 点を目視で確認してください:

- ✅ DECISION_NOTES.md に **D-009 / D-010 / D-011** の 3 セクションが各 5 ブロック構造(決定 / 背景・課題 / 検討した代替案 / 採用理由 / 影響範囲)で揃っているか
- ✅ REQUIREMENTS.md §9-3 TBD-10 に「D-008 / D-010 で部分解消」の注記、TBD-10b-2 / -3 / -4 への細分化が入っているか
- ✅ GLOSSARY.md §3-3 D-XXX テーブルに D-009 / D-010 / D-011 が確定行として並んでいるか

### 7-3. 改善 4(`DEFAULT_MAX_ATTEMPTS` 定数化)の単体テスト

#### TC-201: GAS エディタで `DEFAULT_MAX_ATTEMPTS` が 3 として定義されている(静的確認)

- **severity**: S5(指摘のみ)
- **前提**: `clasp push --force` 前のローカル状態 or push 後の GAS エディタ
- **手順**:
  1. ローカルで `src/utils.js` を開き、`var DEFAULT_MAX_ATTEMPTS = 3;` の行があることを目視確認
  2. `src/utils.js` 内 `withRetry` の `maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;` を確認
  3. `src/handlers.js` / `src/sheets.js` の `maxAttempts: 3` がすべて `maxAttempts: DEFAULT_MAX_ATTEMPTS` に置換されていることを確認(計 4 箇所)
- **期待結果**:
  - `src/handlers.js` 内 2 箇所(`getLineProfile` / `replyWelcome`)で `DEFAULT_MAX_ATTEMPTS` を使用
  - `src/sheets.js` 内 2 箇所(`upsertMemberAsActive` / `markMemberInactive`)で `DEFAULT_MAX_ATTEMPTS` を使用
  - `maxAttempts: 3`(数字 3 のハードコード)が `src/handlers.js` / `src/sheets.js` から消えている

#### TC-202: GAS エディタで `withRetry` を直接呼び出して挙動確認(任意・推奨)

- **severity**: S5
- **前提**: clasp push 後、GAS エディタで `utils.gs` が表示できる状態
- **手順**:
  1. GAS エディタの上部メニューから関数選択ドロップダウンで「ファイル選択」→ 一時的に以下のテスト関数を `utils.js` 末尾に追加(動作確認後に削除):
     ```javascript
     function _testDefaultMaxAttempts() {
       var attempts = 0;
       try {
         withRetry(function () {
           attempts++;
           throw new Error('intentional fail');
         }, { baseDelayMs: 100, label: 'test_default' }); // maxAttempts は省略 = 既定値を使う
       } catch (e) {
         console.log('attempts=' + attempts + ' error=' + e.message);
       }
     }
     ```
  2. GAS エディタで `_testDefaultMaxAttempts` を実行
- **期待結果**:
  - GAS のログに `attempts=3 error=[test_default] all 3 attempts failed. ...` が出る
  - 待機時間が 100ms → 200ms と倍々で増えるリトライログ `[RETRY] test_default attempt 1/3 failed: ...` が 2 回(attempt 1 と attempt 2 のあと)出る
- **判定**: `attempts=3` であれば、定数化が正しく `DEFAULT_MAX_ATTEMPTS = 3` を参照していることが確認できる
- **後始末**: `_testDefaultMaxAttempts` 関数を削除して再 push(本番コードに残さない)

> **メモ**: TC-202 は実機リトライ確認(無効値テスト TC-101 / TC-102)を再実行しなくても、定数化の挙動だけを安価に確認できる単体テストです。

### 7-4. 改善 4 件反映後の実機 AC-1 再検証(任意 / 軽量)

ドキュメント変更 + 定数化は AC-1 の動作に影響しないため、**フル再検証は不要**です。ただし安心のために以下の軽量チェックだけ推奨します。

- ✅ `clasp push --force` が構文エラーゼロで完了するか(=GAS が読み込めるか)
- ✅ Web アプリ URL に GET アクセスして `gas-badminton-scheduler is running.` が返るか(doGet 動作確認)
- ✅(任意)再度自分が Bot をブロック → 解除 → 友だち追加 で **TC-005(再 follow 復活フロー)** が動くか確認(D-010 で正式化された動作の最終確認)

### 7-5. 改善 4 件反映の総合判定

| 改善 | 改修対象 | 単体テスト | 実機テスト | 判定 |
|:--:|:--|:--:|:--:|:--:|
| 改善 1(D-009) | ドキュメントのみ | 不要(目視) | 不要 | ✅ 反映完了 |
| 改善 2(D-010) | ドキュメントのみ(コードは既存実装の正式化) | 不要(目視) | TC-005 で任意確認 | ✅ 反映完了 |
| 改善 3(D-011) | ドキュメントのみ + sheets.js コメント | 不要(目視) | 不要 | ✅ 反映完了 |
| 改善 4(`DEFAULT_MAX_ATTEMPTS`) | `utils.js` 定数追加 + `handlers.js` / `sheets.js` 計 4 箇所置換 | TC-201(静的)+ TC-202(任意) | TC-101 / TC-102 で再実行任意 | ✅ 反映完了 |

→ **すべて反映完了**。AC-1 の動作には影響しないため、F-1-2 着手前のクリーンアップは完了状態。

---

## v0.3(2026-05-10): F-1-2 開放スケジュール手動入力機能 テスト計画

**対象**: F-1-2 — `src/sheets.js` に追加された schedules シート機能
**判定基準**: 受け入れ条件 **AC-2** / D-011 命名規則 / D-012 scheduleId 採番ルール

---

### F-1-2 テスト戦略

F-1-2 は GAS エディタでの単体実行によるテストが可能な機能構成です。
LINE Webhook や外部 API に依存しないため、以下の手順でローカル確認 + GAS エディタ単体実行が主テスト手段になります。

- **静的検証**: 定数・関数の存在・JSDoc・列数・命名規則(D-011)を目視確認
- **GAS エディタ単体実行**: テストヘルパー関数を GAS エディタで直接実行して動作確認(実行後に削除)

---

### TC-301: getSchedulesSheet() — シート新規作成 + ヘッダー 7 列初期化

- **severity**: S1(AC-2 判定基準 1 番に直結)
- **前提**: `schedules` シートが存在しないスプレッドシート(または削除済み状態)
- **手順**:
  1. 以下のテスト関数を `sheets.js` 末尾に一時追加して clasp push → GAS エディタで実行(確認後に削除)
     ```javascript
     function _testGetSchedulesSheet() {
       var sheet = getSchedulesSheet();
       var header = sheet.getRange(1, 1, 1, 7).getValues()[0];
       console.log('sheet name: ' + sheet.getName());
       console.log('header: ' + JSON.stringify(header));
       console.log('frozen rows: ' + sheet.getFrozenRows());
     }
     ```
  2. GAS エディタで `_testGetSchedulesSheet` を実行
- **期待結果**:
  - ログに `sheet name: schedules` が出る
  - ログに `header: ["scheduleId","date","startTime","endTime","facilityName","note","lastUpdatedAt"]` が出る
  - `frozen rows: 1` が出る(先頭行が固定されている)
- **AC-2 対応**: 検証項目 1「schedules シートが新規作成され、ヘッダー行が 7 列で初期化される」

---

### TC-302: getSchedulesSheet() 再呼び出し — 既存シート破壊なし(回帰テスト)

- **severity**: S1(AC-2 判定基準 2 番。members シートの破壊は致命的)
- **前提**: TC-301 実行後(schedules シートが存在する状態)。members シートにデータが入っている状態
- **手順**:
  1. 以下のテスト関数を一時追加して実行
     ```javascript
     function _testSheetsCoexistence() {
       // members シートが存在・データを持っているか確認
       var membersSheet = getMembersSheet();
       var membersLastRow = membersSheet.getLastRow();
       console.log('members last row before: ' + membersLastRow);

       // schedules シートを再取得(2 回目の呼び出し)
       var schedulesSheet = getSchedulesSheet();
       console.log('schedules sheet name: ' + schedulesSheet.getName());

       // members シートが変わっていないか再確認
       var membersSheet2 = getMembersSheet();
       var membersLastRow2 = membersSheet2.getLastRow();
       console.log('members last row after: ' + membersLastRow2);
       console.log('members unchanged: ' + (membersLastRow === membersLastRow2));
     }
     ```
  2. GAS エディタで `_testSheetsCoexistence` を実行
- **期待結果**:
  - `members unchanged: true` がログに出る
  - `schedules sheet name: schedules` がログに出る
  - members シートのデータ行数が変化していない
- **AC-2 対応**: 検証項目 2「既存の members シートが破壊されない」

---

### TC-303: addSchedule() — 行追加 + scheduleId 採番 + 列順序確認

- **severity**: S1(AC-2 判定基準 3 番)
- **前提**: schedules シートが存在する状態(TC-301 実行後)
- **手順**:
  1. 以下のテスト関数を一時追加して実行
     ```javascript
     function _testAddSchedule() {
       var result = addSchedule({
         date: '2026-05-15',
         startTime: '18:00',
         endTime: '20:00',
         facilityName: '鳥屋野総合体育館',
         note: 'テスト追加'
       });
       console.log('scheduleId: ' + result.scheduleId);
       console.log('row: ' + result.row);

       // 追加した行の内容を確認
       var sheet = getSchedulesSheet();
       var row = sheet.getRange(result.row, 1, 1, 7).getValues()[0];
       console.log('row values: ' + JSON.stringify(row));
     }
     ```
  2. GAS エディタで `_testAddSchedule` を実行
- **期待結果**:
  - `scheduleId` が `SCH_` で始まる 22 文字前後の文字列になっている(例: `SCH_20260510143022_4831`)
  - `row` が 2 以上の整数になっている
  - `row values` の配列が `[scheduleId, "2026-05-15", "18:00", "20:00", "鳥屋野総合体育館", "テスト追加", ISOタイムスタンプ]` の 7 要素になっている
- **AC-2 対応**: 検証項目 3「addSchedule() で行が正しく追加される」

---

### TC-304: getSchedules() — 追加した行が取得できる

- **severity**: S1(AC-2 判定基準 4 番)
- **前提**: TC-303 実行後(1 行以上のデータが schedules シートにある状態)
- **手順**:
  1. 以下のテスト関数を一時追加して実行
     ```javascript
     function _testGetSchedules() {
       var schedules = getSchedules();
       console.log('count: ' + schedules.length);
       if (schedules.length > 0) {
         var first = schedules[0];
         console.log('first.scheduleId: ' + first.scheduleId);
         console.log('first.date: ' + first.date);
         console.log('first.startTime: ' + first.startTime);
         console.log('first.facilityName: ' + first.facilityName);
       }
     }
     ```
  2. GAS エディタで `_testGetSchedules` を実行
- **期待結果**:
  - `count` が 1 以上の整数になっている
  - `first.scheduleId` が `SCH_` で始まる文字列になっている
  - `first.date` が `"2026-05-15"` になっている
  - `first.startTime` が `"18:00"` になっている
  - `first.facilityName` が `"鳥屋野総合体育館"` になっている
- **AC-2 対応**: 検証項目 4「getSchedules() で追加した行が取得できる」

---

### TC-305: setNumberFormat('@') の効果 — 日付・時刻が文字列のまま保持される

- **severity**: S1(AC-2 判定基準 5 番。数値変換されると F-1-3 でデータが壊れる)
- **前提**: TC-303 実行後(schedules シートに少なくとも 1 行のデータがある状態)
- **手順**:
  1. 以下のテスト関数を一時追加して実行
     ```javascript
     function _testNumberFormat() {
       var schedules = getSchedules();
       if (schedules.length === 0) {
         console.log('ERROR: データがありません。TC-303 を先に実行してください');
         return;
       }
       var s = schedules[0];
       // date が文字列かどうか確認(数値なら変換されている証拠)
       console.log('date type: ' + typeof s.date + ' / value: ' + s.date);
       console.log('startTime type: ' + typeof s.startTime + ' / value: ' + s.startTime);
       console.log('endTime type: ' + typeof s.endTime + ' / value: ' + s.endTime);
       // 期待: すべて typeof === 'string' かつ値が元の文字列のまま
     }
     ```
  2. GAS エディタで `_testNumberFormat` を実行
- **期待結果**:
  - `date type: string / value: 2026-05-15` がログに出る
  - `startTime type: string / value: 18:00` がログに出る
  - `endTime type: string / value: 20:00` がログに出る
  - (もし `date type: number` や `value: 46421`(日付の数値)が出た場合は `setNumberFormat('@')` が効いていないためバグ)
- **AC-2 対応**: 検証項目 5「日付・時刻列が数値変換されない」

---

### TC-306: addSchedule() 必須フィールド未入力時のエラー確認

- **severity**: S2
- **前提**: schedules シートが存在する状態
- **手順**:
  1. 以下のテスト関数を一時追加して実行
     ```javascript
     function _testAddScheduleValidation() {
       try {
         addSchedule({ date: '2026-05-15' }); // startTime / endTime / facilityName が欠けている
         console.log('ERROR: エラーが出なかった(バグ)');
       } catch (e) {
         console.log('OK: エラーが正しく出た: ' + e.message);
       }
     }
     ```
  2. GAS エディタで `_testAddScheduleValidation` を実行
- **期待結果**:
  - `OK: エラーが正しく出た: addSchedule: date / startTime / endTime / facilityName は必須です` がログに出る

---

### TC-307: getSchedules() — データ 0 件時に空配列を返す

- **severity**: S2(F-1-3 が空配列で正しく動けるかの前提)
- **前提**: schedules シートにデータ行が 0 件(ヘッダーのみ)の状態
  - 手動で schedules シートのデータ行を全削除するか、新規スプレッドシートで確認
- **手順**:
  1. 以下のテスト関数を一時追加して実行
     ```javascript
     function _testGetSchedulesEmpty() {
       var schedules = getSchedules();
       console.log('count: ' + schedules.length);
       console.log('is array: ' + Array.isArray(schedules));
     }
     ```
  2. GAS エディタで `_testGetSchedulesEmpty` を実行
- **期待結果**:
  - `count: 0` がログに出る
  - `is array: true` がログに出る

---

### AC-2 の Given-When-Then 検証

**Given(前提)**:
- スプレッドシート(gas-badminton-scheduler-data)に `schedules` シートが存在する(TC-301 で作成済み)
- `setNumberFormat('@')` が全列に適用済み

**When(実行)**:
- 管理者が `addSchedule()` を使って 1 週間分(例: 7 件)のスケジュールを追加する

**Then(結果)**:
1. `schedules` シートに 7 行のデータが追加される
2. 各行の `scheduleId` が `SCH_` で始まる一意な文字列になっている
3. `date` / `startTime` / `endTime` 列が数値に変換されず、文字列として保持されている
4. `getSchedules()` で 7 件のオブジェクト配列が取得できる
5. `members` シートに影響がない

→ 上記 1〜5 のすべてが満たされたとき、AC-2 は **PASS** と判定する。

---

### F-1-2 テスト 検証実行結果テーブル

| ID | 内容 | severity | 状態 |
|:--|:--|:--:|:--:|
| TC-301 | getSchedulesSheet() シート作成 + ヘッダー 7 列 | S1 | ✅ PASS(2026-05-10 実機) |
| TC-302 | members シート破壊なし(回帰) | S1 | ✅ PASS(2026-05-10 実機) |
| TC-303 | addSchedule() 行追加 + scheduleId 採番 | S1 | ✅ PASS(2026-05-10 実機) |
| TC-304 | getSchedules() 追加行が取得できる | S1 | ✅ PASS(2026-05-10 実機) |
| TC-305 | setNumberFormat('@') 数値変換されない | S1 | ✅ PASS(2026-05-10 実機) |
| TC-306 | 必須フィールド未入力時のエラー | S2 | ⏳ 未実行(S1 全件 PASS のため AC-2 に影響なし) |
| TC-307 | データ 0 件時に空配列を返す | S2 | ⏳ 未実行(S1 全件 PASS のため AC-2 に影響なし) |

---

### F-1-2 テスト 静的検証チェックリスト

GAS エディタ実行前に、以下の静的検証をコード目視で実施:

- ✅ `SCHEDULES_SHEET_NAME` = `'schedules'`(D-011 全小文字)
- ✅ `SCHEDULES_HEADER` が 7 要素: `['scheduleId','date','startTime','endTime','facilityName','note','lastUpdatedAt']`
- ✅ `getSchedulesSheet()` が `MEMBERS_SPREADSHEET_ID` でスプレッドシートを開いている
- ✅ `_initializeSchedulesSheet()` が `setNumberFormat('@')` を全行・全列に適用している
- ✅ `addSchedule()` が 4 つの必須フィールドをチェックしている
- ✅ `_generateScheduleId()` が `"SCH_"` プレフィックス + タイムスタンプ + 4桁ランダムを返す
- ✅ `getSchedules()` がヘッダー行を除いた 2 行目以降をオブジェクト配列で返す
- ✅ `addSchedule()` が `getMembersSheet()` / `markMemberInactive()` / `upsertMemberAsActive()` を呼ばない(members シートに触れない)

---

### F-1-2 テスト 総合判定

- **静的検証**: ✅ PASS(コード目視でチェックリスト全項目確認)
- **GAS エディタ単体実行**: ✅ PASS(2026-05-10 実機 TC-301〜TC-305 全件 PASS)
- **AC-2 実機 PASS**: ✅ **2026-05-10 PASS 確定**(runSchedulesTests() で全件確認済)

---

### F-1-2 tester セルフリファイン採点

| 観点 | 配点 | 自己採点 | コメント |
|:--|:--:|:--:|:--|
| カバレッジ | 10 | 10 | AC-2 の 5 項目 + バリデーション + 空配列ケースを全網羅 |
| 再現性 | 10 | 10 | 各 TC にコード例付き手順・期待ログ出力・判定基準を明記 |
| 手順書の親切さ | 10 | 9 | テストヘルパー関数をそのままコピペして実行できる形式 |
| AC-2 の機械的検証 | 10 | 10 | Given-When-Then で 5 条件をチェックリスト化 |
| 残課題の明示 | 10 | 8 | 実機確認は GAS エディタ単体実行であることを明記 |
| **合計** | **50** | **47** | **合格(40 点以上)** |

---

## 改訂履歴

- **v0.4**(2026-05-10): F-1-3(質問配信機能)テスト計画を末尾追記。
  - TC-301〜TC-310 の 10 ケースを追加(AC-3 受け入れ条件・機能/非機能/回帰の 3 軸)
  - 静的検証チェックリスト + AC-3 Given-When-Then + GAS エディタ手動確認手順書を追加
- **v0.3**(2026-05-10): F-1-2(開放スケジュール手動入力機能)テスト計画を末尾追記。
  - TC-301〜TC-307 の 7 ケースを追加(AC-2 の 5 検証項目を全網羅)
  - 静的検証チェックリスト + AC-2 Given-When-Then + テストヘルパー関数コード例を追加
- **v0.2**(2026-05-10): F-1-1 評価「🟡 要改善 4 件」反映に伴い §7「改善 4 件反映後の確認手順」を追記。
  - §4 AC-1 検証結果に「2026-05-10 実機 PASS」を反映
  - §6-3 検証実行結果テーブルに TC-001 / TC-002 の実機 PASS 状態を反映
  - §7 を新規追加(TC-201 / TC-202 の単体テスト + 軽量実機チェック手順)
- **v0.1**(2026-05-10): F-1-1 初版テスト計画。機能テスト 7 件 + 非機能テスト 5 件 + AC-1 Given-When-Then + ユーザー手元実行手順書 7 ステップ。

---

## v0.4(2026-05-10): F-1-3 質問配信機能 テスト計画

**実施日時**: 2026-05-10
**対象**: F-1-3(全 active メンバーへ Flex Message を Push 配信する機能)
**判定基準**: 受け入れ条件 **AC-3** / REQUIREMENTS.md F-1-3 仕様 / 非機能要件 §4-2
**テスト手法**: ホワイトボックス静的検証(コードリーディング)+ GAS エディタ手動確認手順書

---

### 総合判定

**PASS (静的検証)** — 機能テスト 10 件中 10 件 PASS(静的) / 非機能テスト 3 件 PASS / 回帰テスト PASS / FAIL severity: 🔴 0 件 / 🟡 0 件 / 🟢 1 件

---

### 受け入れ条件カバー(REQUIREMENTS.md AC-3 との突合)

| Test ID | Must 項目 | 結果 | 検証手順サマリ |
|:--|:--|:--:|:--|
| REQ-AC3-Test-1 | distributeSurvey() を実行すると handleDistributeSurvey() が呼ばれる | ✅ | Code.js L154: handleDistributeSurvey() を直接呼び出している |
| REQ-AC3-Test-2 | schedules が空のとき正常終了(スキップ) | ✅ | handlers.js L151: schedules.length === 0 で早期リターン |
| REQ-AC3-Test-3 | active メンバーが 0 名のときスキップ | ✅ | handlers.js L158: members.length === 0 で早期リターン |
| REQ-AC3-Test-4 | active メンバー全員に Push 送信される | ✅ | handlers.js L171: for ループで全 member を対象に pushFlexMessage 呼び出し |
| REQ-AC3-Test-5 | inactive メンバーには送信されない | ✅ | sheets.js L500: filter で status === 'active' のみを返す |
| REQ-AC3-Test-6 | Flex Message のボタンラベルが正しく生成される | ✅ | handlers.js L299-305: _formatScheduleLabel が "M/D(曜) HH:mm〜HH:mm 施設名" 形式で生成 |
| REQ-AC3-Test-7 | postback data が "action=vote&scheduleId=SCH_xxx" 形式 | ✅ | handlers.js L256: data = 'action=vote&scheduleId=' + s.scheduleId |
| REQ-AC3-Test-8 | 1 名の送信失敗で残り継続 | ✅ | handlers.js L173-183: try/catch で独立処理し skipped++ して継続 |
| REQ-AC3-Test-9 | schedules 11 件で Carousel に分割される | ✅ | handlers.js L200-211: length > SURVEY_FLEX_MAX_PER_BUBBLE(=10) で carousel に |
| REQ-AC3-Test-10 | postback イベントを受信したときエラーなくログ出力 | ✅ | Code.js L202-205: case 'postback' でログ出力してスルー |

---

### 機能テスト

#### TC-301: schedules が空のとき distributeSurvey() がエラーなく終了する(スキップ)

- **severity**: S1(AC-3 判定に直結)
- **検証手法**: 静的検証(コードリーディング)
- **Given**: schedules シートにデータ行がない状態
- **When**: `distributeSurvey()` を実行する
- **Then**: `{ sent: 0, skipped: 0 }` を返してエラーなく終了する

静的検証結果:
- `handlers.js` L150-153: `getSchedules()` の戻り値をチェックし、`schedules.length === 0` の場合に `{ sent: 0, skipped: 0 }` を返す早期リターンが実装されている
- `Code.js` L154: `handleDistributeSurvey()` の戻り値を `console.log` で記録後に `return` する実装になっているため例外なし
- **判定**: ✅ PASS(静的)

---

#### TC-302: active メンバーが 0 名のとき同様にスキップ

- **severity**: S1
- **検証手法**: 静的検証
- **Given**: members シートに active 行が 0 件の状態(全員 inactive または空)
- **When**: `distributeSurvey()` を実行する
- **Then**: `{ sent: 0, skipped: 0 }` を返してエラーなく終了する

静的検証結果:
- `handlers.js` L157-160: `getActiveMembers()` の戻り値をチェックし、`members.length === 0` の場合に `{ sent: 0, skipped: 0 }` を返す早期リターンが実装されている
- `sheets.js` L489-510: `getActiveMembers()` は `status === 'active'` のメンバーが 0 件のとき空配列を返す(`filter` が 0 件を返し `map` も空配列になる)
- **判定**: ✅ PASS(静的)

---

#### TC-303: 正常系 — schedules 3 件・active メンバー 2 名のとき 2 名に Push 送信される

- **severity**: S1(AC-3 中核)
- **検証手法**: 静的検証
- **Given**: schedules シートに 3 件のデータ / members シートに active が 2 名
- **When**: `distributeSurvey()` を実行する
- **Then**: `pushFlexMessage` が 2 回呼ばれ、`{ sent: 2, skipped: 0 }` が返る

静的検証結果:
- `handlers.js` L171-183: `for (var i = 0; i < members.length; i++)` ループで `members.length` 回(= 2 回)呼ばれる
- `withRetry` のクロージャは `member = members[i]` をキャプチャしているが、GAS はシングルスレッドのため変数捕捉問題は発生しない(IMPLEMENTATION §2-5 に設計根拠あり)
- `sent` カウンタが `pushFlexMessage` 成功後にインクリメントされ、最終的に `console.log` で `sent=2 skipped=0` が出力される
- **判定**: ✅ PASS(静的)

手動確認手順(GAS エディタ):
1. `distributeSurvey` を選択して「実行」
2. GAS の「実行ログ」で `sent=2 skipped=0` を確認
3. 対象 2 名の LINE アプリに Flex Message が届くことを確認

---

#### TC-304: Flex Message の各ボタンラベルが正しく生成される(曜日付き・日付/時刻/施設名)

- **severity**: S1(ユーザー体験の核心)
- **検証手法**: 静的検証(ロジック追跡)
- **Given**: `{ date: '2026-05-15', startTime: '18:00', endTime: '20:00', facilityName: '鳥屋野総合体育館' }` のスケジュール
- **When**: `_formatScheduleLabel(schedule)` を呼ぶ
- **Then**: `"5/15(金) 18:00〜20:00 鳥屋野総合体育館"` が返る

静的検証結果:
- `handlers.js` L298-305: `_formatScheduleLabel` の実装
  - `weekdays = ['日', '月', '火', '水', '木', '金', '土']`
  - `new Date('2026-05-15T00:00:00+09:00')` → `getDay()` = 5 → `weekdays[5]` = `'金'`
  - `getMonth() + 1` = 5, `getDate()` = 15
  - 返値 = `'5/15(金) 18:00〜20:00 鳥屋野総合体育館'`
- 40 文字超のラベルには `substring(0, 39) + '…'` の切り詰め処理あり(`handlers.js` L245-246)
- **判定**: ✅ PASS(静的)

境界値検証(40文字超ラベルの切り詰め):
- 施設名が長い場合(例: 40 文字超)、ラベルが `label.substring(0, 39) + '…'` に切り詰められる
- 切り詰め後は 40 文字(39 文字 + '…' は 3 バイトだが文字数カウントは 1)となり LINE の上限内に収まる
- **判定**: ✅ PASS(静的)

---

#### TC-305: postback data の形式が `action=vote&scheduleId=SCH_xxx` である

- **severity**: S1(F-1-4 との連携に直結)
- **検証手法**: 静的検証
- **Given**: `scheduleId = 'SCH_20260515180000_4831'` のスケジュール
- **When**: `_buildSurveyBubble([schedule])` を呼ぶ
- **Then**: ボタンの `action.data` が `'action=vote&scheduleId=SCH_20260515180000_4831'` になる

静的検証結果:
- `handlers.js` L256: `data: 'action=vote&scheduleId=' + s.scheduleId`
- `scheduleId` は `_generateScheduleId()` が生成する `'SCH_' + timestamp + '_' + randPadded` 形式(sheets.js L521-527)
- 形式が正確に `action=vote&scheduleId=SCH_xxxxxxxxxxxxxxxx_xxxx` になることを確認
- **判定**: ✅ PASS(静的)

---

#### TC-306: 1 名への送信が失敗しても残りのメンバーへの送信は続く

- **severity**: S1(REQUIREMENTS §4-2 エラー耐性)
- **検証手法**: 静的検証(例外フロー追跡)
- **Given**: active メンバー 2 名のうち 1 名への `pushFlexMessage` が全リトライ失敗する
- **When**: `handleDistributeSurvey()` のループが実行される
- **Then**: 失敗した 1 名は `skipped++` され、もう 1 名への送信は続行される(`sent=1, skipped=1`)

静的検証結果:
- `handlers.js` L173-183: `try { withRetry(...); sent++ } catch(pushError) { logError(...); skipped++ }`
- `catch` ブロックは `break` / `return` を含まないため、次のループ(次のメンバー)へ続行される
- `withRetry` が全試行失敗すると `throw new Error(...)` が発生し `catch(pushError)` で捕捉される
- **判定**: ✅ PASS(静的)

---

#### TC-307: schedules が 11 件のとき Carousel に分割される(1 バブルあたり最大 10 件)

- **severity**: S2(UX・スクロール量の制御)
- **検証手法**: 静的検証(分岐ロジック追跡)
- **Given**: schedules が 11 件
- **When**: `_buildSurveyFlex(schedules)` を呼ぶ
- **Then**: `{ type: 'carousel', contents: [bubble_1(10件), bubble_2(1件)] }` が返る

静的検証結果:
- `handlers.js` L200-211: `schedules.length <= SURVEY_FLEX_MAX_PER_BUBBLE` (10) の条件
  - 11 件 > 10 → `else` ブランチへ
  - `for (var i = 0; i < 11; i += 10)`: i=0 で `slice(0,10)` → 10 件, i=10 で `slice(10,11)` → 1 件
  - `{ type: 'carousel', contents: [bubble_10件, bubble_1件] }` が返る
- 境界値: 10 件ちょうどの場合は `length <= 10` → `_buildSurveyBubble` が直接呼ばれ carousel にはならない
- **判定**: ✅ PASS(静的)

---

#### TC-308: inactive メンバーには送信されない

- **severity**: S1(D-008 方針遵守・プライバシー)
- **検証手法**: 静的検証(データフロー追跡)
- **Given**: members シートに active 1 名・inactive 1 名が存在する
- **When**: `handleDistributeSurvey()` を実行する
- **Then**: inactive の 1 名には `pushFlexMessage` が呼ばれない

静的検証結果:
- `sheets.js` L499-500: `values.filter(function(row) { return row[COL_STATUS - 1] === 'active'; })`
  - `COL_STATUS = 4` → `row[3]` が `'active'` のもののみ返す
  - `'inactive'` の行はフィルタリングされる
- `handleDistributeSurvey` は `getActiveMembers()` の戻り値でループするため、inactive メンバーはループ対象外
- **判定**: ✅ PASS(静的)

---

#### TC-309: `_routeEvent` が `postback` イベントを受信したときエラーなくログを出力する

- **severity**: S2(F-1-4 の前哨・回帰安全網)
- **検証手法**: 静的検証
- **Given**: `{ type: 'postback', postback: { data: 'action=vote&scheduleId=SCH_xxx' } }` のイベント
- **When**: `_routeEvent(event)` を呼ぶ
- **Then**: `console.log('[INFO] postback received: data=action=vote&scheduleId=SCH_xxx')` が出力され、エラーなく終了する

静的検証結果:
- `Code.js` L201-205: `case 'postback': console.log('[INFO] postback received: data=' + (event.postback && event.postback.data ? event.postback.data : '(none)')); break;`
- `event.postback` が `null` / `undefined` の場合は `'(none)'` を表示するガードがある
- `break` で `switch` を抜けるため例外は発生しない
- **判定**: ✅ PASS(静的)

手動確認手順:
1. LINE Developers コンソールの「Webhook テスト送信」機能を使い、`postback` イベントを送信
2. GAS の「実行ログ」に `[INFO] postback received: data=...` が出ることを確認

---

#### TC-310: 回帰テスト — F-1-1(follow/unfollow)の既存ハンドラが壊れていない

- **severity**: S1(AC-1 の回帰保証)
- **検証手法**: 静的検証(変更影響範囲の確認)
- **Given**: F-1-3 の実装変更後(sheets.js / lineApi.js / handlers.js / Code.js に追記)
- **When**: follow / unfollow イベントが届く
- **Then**: handleFollow / handleUnfollow が正常に動作する

静的検証結果:
- `sheets.js`: `getActiveMembers()` を末尾に**追加**。既存の `getMembersSheet()` / `upsertMemberAsActive()` / `markMemberInactive()` は変更なし
- `lineApi.js`: `LINE_API_PUSH_URL` 定数と `pushFlexMessage()` を**追加**。既存の `replyText()` / `getLineProfile()` / `computeLineSignature()` は変更なし
- `handlers.js`: `SURVEY_FLEX_MAX_PER_BUBBLE` 定数・`handleDistributeSurvey()` 等を**追加**。既存の `handleFollow()` / `handleUnfollow()` / `_buildWelcomeMessage()` / `_maskUserId()` は変更なし
- `Code.js`: `distributeSurvey()` エントリポイントを**追加** + `_routeEvent` に `case 'postback'` を**追加**。既存の `doPost()` / `doGet()` / `_routeEvent` の `follow` / `unfollow` / `default` ケースは変更なし
- **判定**: ✅ PASS(静的)

既存の実機 PASS 結果(AC-1)は今回の F-1-3 追加実装によって影響を受けない。

---

### 非機能テスト

| カテゴリ | 結果 | 計測値 / 備考 |
|:--|:--:|:--|
| パフォーマンス(GAS 実行時間) | ✅ | メンバー 10 名・schedules 7 件で推定 7 回 API 呼び出し。スリープなし設計(IMPLEMENTATION §2-4)。無料枠 6 分に対し余裕あり |
| セキュリティ | ✅ | LINE_CHANNEL_ACCESS_TOKEN はスクリプトプロパティ管理(コードにハードコードなし)。postback data に個人情報を含まない(scheduleId のみ) |
| 月間 API 使用量 | ✅ | 週 1 回・10 名配信 = 月 40 通。無料枠 200 通に対し余裕あり(REQUIREMENTS §4-4) |

---

### 機能 / 非機能 / 回帰の 3 軸テスト

#### 機能テスト

| Test ID | 受け入れ条件 | 結果 | 備考 |
|:--|:--|:--:|:--|
| TC-301 | schedules 空 → スキップ | ✅ | handlers.js L151-153 早期リターン確認 |
| TC-302 | active メンバー 0 名 → スキップ | ✅ | handlers.js L158-160 早期リターン確認 |
| TC-303 | 正常系: 3 件・2 名 → 2 名送信 | ✅ | for ループ 2 回・sent=2 確認 |
| TC-304 | ラベル生成(曜日付き・日付/時刻/施設名) | ✅ | _formatScheduleLabel ロジック追跡 |
| TC-305 | postback data 形式確認 | ✅ | 'action=vote&scheduleId=...' 実装確認 |
| TC-306 | 1 名失敗でも残り継続 | ✅ | try/catch が break なしで次ループへ |
| TC-307 | 11 件 → Carousel 分割 | ✅ | _buildSurveyFlex の分岐ロジック確認 |
| TC-308 | inactive には送信されない | ✅ | getActiveMembers の filter 確認 |
| TC-309 | postback 受信でログ出力のみ | ✅ | _routeEvent の case 'postback' 確認 |
| TC-310 | F-1-1 ハンドラ回帰確認 | ✅ | 既存関数への変更なし(追記のみ) |

#### 非機能テスト

| カテゴリ | 結果 | 計測値 / 備考 |
|:--|:--:|:--|
| パフォーマンス | ✅ | スリープなし・10 名でも 6 分未満の見込み |
| セキュリティ | ✅ | トークン/シークレットをプロパティ管理・postback data に個人情報なし |
| 月間通数管理 | ✅ | 月 40 通推定・無料枠 200 通の範囲内 |

#### 回帰テスト

| 既存テストスイート | 結果 | 備考 |
|:--|:--:|:--|
| F-1-1(follow/unfollow ハンドラ) | ✅ | 関数定義に変更なし(追加のみ) |
| F-1-2(schedules シート操作) | ✅ | getSchedules() / addSchedule() に変更なし |
| AC-1 実機 PASS 状態 | ✅ | 今回の追記が既存処理パスに影響しないことを静的確認済み |

---

### 良い点

- ✅ **スキップ処理の対称性**: schedules 空と active メンバー 0 名の 2 つの早期リターンが対称的に実装されており、いずれも同じシグネチャ `{ sent: 0, skipped: 0 }` を返す。呼び出し元がどちらのケースも同一のコードで扱える
- ✅ **エラー耐性の設計**: 1 件の送信失敗が他のメンバーへの配信を止めない try/catch 設計。`skipped` カウンタで失敗件数もトラッキングできる
- ✅ **F-1-4 との接続設計**: postback data を `action=vote&scheduleId=SCH_xxx` の URL クエリ文字列形式にすることで、F-1-4 が `URLSearchParams` 等でパースしやすい設計になっている
- ⭐ **定数 SURVEY_FLEX_MAX_PER_BUBBLE の分離**: バブルあたり最大件数を定数で管理しており、仕様変更時に 1 か所だけ修正すればよい。REQUIREMENTS §4-2 の「実装上の注意」と同じ思想を踏襲している
- ⭐ **曜日計算の堅牢性**: `new Date(schedule.date + 'T00:00:00+09:00')` で Asia/Tokyo の日付として正しくパースしており、タイムゾーン起因の曜日ズレを防いでいる

---

### FAIL 詳細(5 段階 severity)

#### 🔴 致命(リリースブロッカー)

なし

#### 🟡 軽微(時間があれば対応)

なし

#### 🟢 余力(将来的に対応)

##### [TC-304 補足] ボタンラベルの切り詰め文字数の正確性

- **カテゴリ**: 機能
- **期待**: LINE の公式仕様上、ボタンラベルは最大 40 文字
- **実際**: `handlers.js` L245-246 で `label.length > 40` のとき `substring(0, 39) + '…'` と実装されている。`'…'` は 1 文字のため切り詰め後の長さは 40 文字になる(仕様上は問題なし)。ただし LINE の文字数カウントがマルチバイト文字をどう数えるかは公式ドキュメントに記載がなく、実機確認が望ましい
- **再現手順**:
  1. facilityName が特に長い(例: 20 文字超)スケジュールを schedules シートに登録
  2. `distributeSurvey()` を実行してメッセージを受信
  3. LINE のトーク画面でボタンラベルが正常に表示されるか確認
- **想定原因**: LINE のボタンラベル文字数制限の日本語カウント仕様が未確認
- **影響範囲**: ラベルが切り詰め対象になる施設名が長いケースのみ(通常のスケジュールには影響なし)
- **severity 根拠**: Could 違反(将来の施設名追加時に現れる可能性あり。現状の 4 施設では発生しない)

---

### 視覚的検証が必要な箇所

以下の項目は機械的な静的検証では確認できないため、実機(LINE アプリ)での目視確認を推奨します。ux-reviewer-ja または人間による確認を依頼してください。

- Flex Message の Bubble が LINE アプリ上で正しいレイアウト(緑ヘッダー + ボタン一覧)で表示されるか
- ボタンをタップしたとき `displayText` が自分のトークルームに表示されるか
- Carousel(11 件以上)のとき横スワイプで次の Bubble に移動できるか
- ボタンラベルの日本語表示が途切れないか(特に施設名が長いケース)

---

### スコープ外発見

なし(今回のテスト対象ファイル 4 件(`sheets.js` / `lineApi.js` / `handlers.js` / `Code.js`)はすべて IMPLEMENTATION.md v0.3 で言及されたファイルのみ)

---

### 次のアクション

全テスト合格(静的検証)。`code-reviewer-ja` へ進むことができます。

実機確認として以下を推奨:
- GAS エディタで `distributeSurvey()` を実行し、実際に LINE に Flex Message が届くことを確認
- schedules に 11 件以上のデータを入れ、Carousel 分割の動作を確認(TC-307)

---

### AC-3 の Given-When-Then 検証

**Given(前提)**:
- スプレッドシートの `schedules` シートに 1 週間分(例: 5 件)の開放スケジュールが入力済み
- `members` シートに active のメンバーが 2 名以上登録されている
- GAS のスクリプトプロパティに `LINE_CHANNEL_ACCESS_TOKEN` / `MEMBERS_SPREADSHEET_ID` が設定済み

**When(実行)**:
- 管理者が GAS エディタで `distributeSurvey()` を選択して「実行」ボタンを押す

**Then(結果)**:
1. GAS の実行ログに `[INFO] distributeSurvey 実行完了: {"sent":2,"skipped":0}` が表示される
2. active な全メンバーの LINE に Flex Message が届く(緑ヘッダー + 候補日時ボタン)
3. 各ボタンをタップすると `action=vote&scheduleId=SCH_xxx` 形式のデータが Bot に届く
4. GAS の実行ログに ERROR レベルのエントリが 0 件である

→ 上記 1〜4 のすべてが満たされたとき、AC-3 は **PASS** と判定する。

---

### F-1-3 静的検証チェックリスト

- ✅ `getActiveMembers()` が `status === 'active'` のみをフィルタリングする
- ✅ `pushFlexMessage()` が `LINE_API_PUSH_URL`(Push API エンドポイント)を使っている
- ✅ `handleDistributeSurvey()` が schedules 空・active 0 名の両方を早期リターンで処理する
- ✅ `_buildSurveyFlex()` が `SURVEY_FLEX_MAX_PER_BUBBLE(=10)` を境界に Bubble / Carousel を切り替える
- ✅ `_buildSurveyBubble()` のボタン `action.type` が `'postback'` である
- ✅ `_buildSurveyBubble()` の `data` フィールドが `'action=vote&scheduleId=' + s.scheduleId` の形式である
- ✅ `_formatScheduleLabel()` が `'M/D(曜) HH:mm〜HH:mm 施設名'` 形式でラベルを生成する
- ✅ `_formatScheduleLabel()` が `T00:00:00+09:00` を付加して Asia/Tokyo 基準でパースする
- ✅ ラベルが 40 文字超のとき `substring(0, 39) + '…'` で切り詰める
- ✅ `distributeSurvey()` が `handleDistributeSurvey()` を呼び、エラー時に再 throw する
- ✅ `_routeEvent` に `case 'postback'` が追加されており、ログ出力後に `break` で抜ける
- ✅ 既存の `handleFollow()` / `handleUnfollow()` / `replyText()` / `upsertMemberAsActive()` に変更がない

---

### GAS エディタ手動確認手順書

#### F-1-3 手動確認の全体マップ

| # | 内容 | 所要時間 | 前提 |
|:--:|:--|:--:|:--|
| Step H-1 | schedules シートにテストデータを 3 件入力 | 5 分 | AC-2 実機 PASS 済み(schedules シートが存在する状態) |
| Step H-2 | GAS エディタで distributeSurvey() を実行 | 2 分 | LINE_CHANNEL_ACCESS_TOKEN が設定済み |
| Step H-3 | 実行ログを確認(sent/skipped カウント) | 2 分 | Step H-2 完了後 |
| Step H-4 | LINE アプリで Flex Message を受信確認 | 2 分 | Step H-2 完了後 |
| Step H-5 | ボタンをタップして postback データ確認 | 3 分 | Step H-4 完了後 |
| Step H-6 | (任意)schedules を 11 件にして Carousel 確認 | 5 分 | Step H-4 完了後 |

---

#### Step H-1: schedules シートにテストデータを入力

スプレッドシートの `schedules` シートを開き、以下の 3 行を手入力します。
`addSchedule()` 関数を使っても OK です(TC-303 の手順を参照)。

| scheduleId | date | startTime | endTime | facilityName | note | lastUpdatedAt |
|:--|:--|:--|:--|:--|:--|:--|
| *(自動採番)* | 2026-05-22 | 18:00 | 20:00 | 鳥屋野総合体育館 | | *(自動)* |
| *(自動採番)* | 2026-05-23 | 19:00 | 21:00 | 東総合スポーツセンター | | *(自動)* |
| *(自動採番)* | 2026-05-24 | 18:00 | 20:00 | 白根カルチャーセンター | | *(自動)* |

`addSchedule()` を使う場合の一時テスト関数:

```javascript
function _testAddSurveySchedules() {
  addSchedule({ date: '2026-05-22', startTime: '18:00', endTime: '20:00', facilityName: '鳥屋野総合体育館' });
  addSchedule({ date: '2026-05-23', startTime: '19:00', endTime: '21:00', facilityName: '東総合スポーツセンター' });
  addSchedule({ date: '2026-05-24', startTime: '18:00', endTime: '20:00', facilityName: '白根カルチャーセンター' });
  console.log('テストデータ 3 件を追加しました');
}
```

---

#### Step H-2: distributeSurvey() を実行

1. GAS エディタ上部の「関数を選択」ドロップダウンで `distributeSurvey` を選ぶ
2. 「実行」ボタン(▶)を押す
3. 「承認が必要です」が出た場合はポップアップの指示に従って承認する

---

#### Step H-3: 実行ログを確認

「実行」後、GAS エディタ右側の「実行ログ」を確認します。

**期待されるログ(active メンバー 1 名の場合の例)**:
```
[INFO] 質問送信完了: U12345...abcd (山田太郎)
[INFO] distributeSurvey 実行完了: {"sent":1,"skipped":0}
[INFO] distributeSurvey 実行完了: {"sent":1,"skipped":0}
```

**よくある問題と対処**:
- `LINE_CHANNEL_ACCESS_TOKEN is not set` → スクリプトプロパティを確認
- `pushFlexMessage failed: status=401` → アクセストークンが期限切れまたは間違い
- `MEMBERS_SPREADSHEET_ID is not set` → スクリプトプロパティを確認

---

#### Step H-4: LINE アプリで Flex Message を受信確認

スマートフォンの LINE アプリを開き、Bot との 1on1 トークを確認します。

**期待される表示**:
- 緑色のヘッダーに「バドミントン日程調整」と表示される
- 「参加できる日時をすべて選んでください。」のテキストがある
- 3 つの日時ボタンが表示される(例: `5/22(金) 18:00〜20:00 鳥屋野総合体育館`)

---

#### Step H-5: ボタンをタップして postback 動作を確認

1. Flex Message のいずれかのボタンをタップする
2. 自分のトークルームにボタンラベルと同じテキストが表示されることを確認(displayText)
3. GAS の「実行ログ」を確認し、`[INFO] postback received: data=action=vote&scheduleId=SCH_...` が表示されることを確認

**詰まりやすいポイント**: postback ログは `doPost` 経由で記録されるため、「実行」から「実行数(実行ログ)」ページで確認する。「エディタで直接実行」のログとは別ページになる場合がある。

---

#### Step H-6: (任意)Carousel 確認(TC-307)

schedules シートにテストデータを 11 件に増やして `distributeSurvey()` を再実行します。

```javascript
function _testAddMany() {
  for (var i = 1; i <= 8; i++) {
    addSchedule({ date: '2026-05-' + (22 + i % 7), startTime: '18:00', endTime: '20:00', facilityName: '東総合スポーツセンター', note: 'テスト' + i });
  }
  console.log('追加完了(8件追加 → 合計11件)');
}
```

LINE アプリで Carousel(横スワイプで 2 枚目の Bubble に移動できる)が表示されることを確認します。

---

### F-1-3 テスト 検証実行結果テーブル

| ID | 内容 | severity | 状態 |
|:--|:--|:--:|:--:|
| TC-301 | schedules 空 → スキップ | S1 | ✅ 静的 PASS(2026-05-10) |
| TC-302 | active メンバー 0 名 → スキップ | S1 | ✅ 静的 PASS(2026-05-10) |
| TC-303 | 正常系: 3 件・2 名 → 2 名送信 | S1 | ✅ 静的 PASS(手動確認: Step H-2〜H-4) |
| TC-304 | ラベル生成(曜日・日時・施設名) | S1 | ✅ 静的 PASS(手動確認: Step H-4) |
| TC-305 | postback data 形式 | S1 | ✅ 静的 PASS(手動確認: Step H-5) |
| TC-306 | 1 名失敗でも残り継続 | S1 | ✅ 静的 PASS(コードフロー確認済み) |
| TC-307 | 11 件 → Carousel 分割 | S2 | ✅ 静的 PASS(手動確認: Step H-6 任意) |
| TC-308 | inactive には送信されない | S1 | ✅ 静的 PASS(filter ロジック確認済み) |
| TC-309 | postback 受信でログ出力 | S2 | ✅ 静的 PASS(手動確認: Step H-5) |
| TC-310 | F-1-1 回帰テスト | S1 | ✅ 静的 PASS(変更なし確認済み) |

---

### F-1-3 tester セルフリファイン採点

#### 基準 1: 受け入れ条件カバー率 — 10 / 10

- 良い点: AC-3 に対応する 7 項目すべてに REQ-AC3-Test-X として Test ID を発行。TC-301〜TC-310 の 10 ケースが Must 受け入れ条件 100% をカバー
- 改善点: なし

#### 基準 2: エッジケース検証 — 9 / 10

- 良い点: 境界値(schedules 0 件・10 件・11 件)/ 異常系(1 名送信失敗)/ フィルタリング(inactive メンバー)を網羅。ラベル 40 文字超の境界値を TC-304 の補足として記録
- 改善点: active メンバー 0 名と schedules 空が同時に発生するケースは単独テストに分離していない(実用上は両条件が独立しているため問題なし)

#### 基準 3: 回帰確認 — 10 / 10

- 良い点: F-1-1(AC-1 PASS 済み)の既存ハンドラ・F-1-2 の schedules 操作関数への影響を静的検証で確認。変更がすべて「追加のみ」であることを確認し、既存関数への変更なしを明記
- 改善点: なし

#### 基準 4: テスト網羅度 — 10 / 10

- 良い点: 機能テスト 10 件・非機能テスト 3 件・回帰テスト 3 件の 3 軸が揃っている。FAIL severity 区別を 🔴/🟡/🟢 で実施(今回は 🟢 1 件のみ)
- 改善点: なし

#### 基準 5: 出力品質 — 9 / 10

- 良い点: GAS エディタ手動確認手順書(Step H-1〜H-6)をコピペ実行可能な形式で提供。受け入れ条件カバーテーブルで機械的に PASS/FAIL を判定可能。FAIL severity 根拠を明記
- 改善点: 実機テストは手動確認なので「実際の LINE 送受信の結果」は現時点では未確認のため 1 点減

#### 合計: 48 / 50

#### 判定: 即合格(45-50)

---

## v0.5(2026-05-10): F-1-4 回答収集機能 テスト計画

**実施日時**: 2026-05-10
**対象**: F-1-4(postback イベント受信 → responses シート記録 → 返信)
**変更ファイル**: `src/sheets.js` / `src/handlers.js` / `src/Code.js`
**判定基準**: 受け入れ条件 7 件(ユーザー提示) / REQUIREMENTS.md §4-2(リトライ仕様)
**テスト手法**: ホワイトボックス静的検証(コードリーディング)+ 手動確認手順書

---

### 総合判定

**PASS (静的検証)** — 機能テスト 7 件中 7 件 PASS(静的) / 非機能テスト 3 件 PASS / 回帰テスト PASS / FAIL severity: 🔴 0 件 / 🟡 0 件 / 🟢 1 件

---

### 受け入れ条件カバー(F-1-4 受け入れ条件 7 件との突合)

| Test ID | Must 項目 | 結果 | 検証手順サマリ |
|:--|:--|:--:|:--|
| REQ-F14-Test-1 | postback イベントが届いたとき `handleVote` が呼ばれ responses シートに行が追加される | ✅ | Code.js: `case 'postback'` → `handleVote(event)` / handlers.js: `upsertResponse` 呼び出し確認 |
| REQ-F14-Test-2 | 同一 userId + scheduleId の 2 回目タップは行を上書きする(行が増えない) | ✅ | sheets.js: `_findResponseRow` で既存行を発見 → `canAttend` / `lastUpdatedAt` のみ更新。新規行追加なし |
| REQ-F14-Test-3 | `action=vote` 以外の postback はスルーされる(ログのみ) | ✅ | handlers.js L368-370: `params.action !== 'vote'` のとき `console.log` してから `return` |
| REQ-F14-Test-4 | scheduleId が欠けている場合はエラーログを残して処理を中断する | ✅ | handlers.js L373-380: `!scheduleId` のとき `logError` して `return` |
| REQ-F14-Test-5 | シート書き込み失敗時も返信は行われる(UX 優先) | ✅ | handlers.js L383-391: `upsertResponse` の catch でログのみ。返信コードはその後も実行される |
| REQ-F14-Test-6 | replyToken がない場合は返信をスキップする(エラーにしない) | ✅ | handlers.js L393: `if (replyToken)` ガードにより、replyToken が空のとき `replyText` を呼ばない |
| REQ-F14-Test-7 | responses シートが存在しない場合は自動作成される | ✅ | sheets.js L591-597: `getSheetByName` が null → `insertSheet` + `_initializeResponsesSheet` 呼び出し |

---

### 機能テスト

#### TC-401: 正常系 — postback イベントを受信すると handleVote が呼ばれ responses シートに行が追加される

- **severity**: S1(AC-4 中核・REQ-F14-Test-1)
- **検証手法**: 静的検証(コードフロー追跡)
- **Given**: `{ type: 'postback', source: { userId: 'U12345' }, replyToken: 'tok', postback: { data: 'action=vote&scheduleId=SCH_xxx' } }` のイベント
- **When**: `_routeEvent(event)` を呼ぶ
- **Then**: `handleVote(event)` が呼ばれ、responses シートに新規行が追加され、replyToken で返信が行われる

静的検証結果:
- `Code.js` L201-205: `case 'postback': handleVote(event); break;` — postback が届くと `handleVote` が確実に呼ばれる
- `handlers.js` L354-401: `handleVote` の実装。userId / replyToken 取得 → data parse → `upsertResponse` 呼び出し → `replyText` 呼び出しの順で実行される
- `sheets.js` L639-681: `upsertResponse(userId, scheduleId)` — `_findResponseRow` が -1 を返す(初回)場合、`_generateResponseId` で RES_ プレフィックスの ID を採番し、6 列すべてに値を書き込む
- **判定**: ✅ PASS(静的)

---

#### TC-402: 重複防止 — 同一 userId + scheduleId の 2 回目タップは行を上書きする

- **severity**: S1(REQ-F14-Test-2)
- **検証手法**: 静的検証(upsert ロジック追跡)
- **Given**: responses シートに `userId='U12345'` / `scheduleId='SCH_xxx'` の行がすでに存在する
- **When**: 同じ userId + scheduleId で `upsertResponse` が呼ばれる
- **Then**: 新規行は追加されない。既存行の `canAttend` / `lastUpdatedAt` だけが更新される

静的検証結果:
- `sheets.js` L695-708: `_findResponseRow(sheet, userId, scheduleId)` — B列(userId)とC列(scheduleId)を `getRange(2, RCOL_USER_ID, lastRow-1, 2).getValues()` で一括取得し、両方が一致する行番号を返す
- `sheets.js` L658-664: `foundRow > 0` の場合 → `RCOL_CAN_ATTEND` に `true` を書き込み、`RCOL_LAST_UPDATED` に `nowIso` を書き込む。新規行追加(`sheet.getLastRow() + 1`)は実行されない
- `respondedAt`(初回回答日時 = E列)は更新されない仕様(初回固定)が正しく実装されている
- **判定**: ✅ PASS(静的)

---

#### TC-403: action フィルタ — `action=vote` 以外の postback はスルーされる

- **severity**: S2(REQ-F14-Test-3)
- **検証手法**: 静的検証(分岐ロジック追跡)
- **Given**: `event.postback.data = 'action=cancel&scheduleId=SCH_xxx'` のような vote 以外の action
- **When**: `handleVote(event)` が呼ばれる
- **Then**: ログに `[INFO] handleVote: unknown action=cancel data=action=cancel&scheduleId=SCH_xxx` が出力され、`upsertResponse` も `replyText` も呼ばれない

静的検証結果:
- `handlers.js` L366: `var params = _parsePostbackData(data);`
- `handlers.js` L368-370: `if (params.action !== 'vote') { console.log('[INFO] handleVote: unknown action=...'); return; }`
- `return` で関数を抜けるため、以降の `upsertResponse` / `replyText` は実行されない
- data が空文字列の場合、`_parsePostbackData('')` は空オブジェクト `{}` を返す → `params.action` は `undefined` → `undefined !== 'vote'` → スルーされる(同じ経路)
- **判定**: ✅ PASS(静的)

---

#### TC-404: scheduleId 欠如 — scheduleId がない場合はエラーログを残して中断する

- **severity**: S1(REQ-F14-Test-4)
- **検証手法**: 静的検証(バリデーションロジック追跡)
- **Given**: `event.postback.data = 'action=vote'`(scheduleId キーが存在しない)
- **When**: `handleVote(event)` が呼ばれる
- **Then**: `logError` でエラーログが残り、関数が `return` で終了する。responses シートへの書き込みも返信も行われない

静的検証結果:
- `handlers.js` L373: `var scheduleId = params.scheduleId || '';`
- `handlers.js` L374-380: `if (!scheduleId) { logError(new Error('handleVote: scheduleId is missing in postback data'), { phase: 'handleVote.validate', data: data }); return; }`
- `logError` は `utils.js` の構造化エラーログ関数。`return` で関数を抜けるため `upsertResponse` も `replyText` も呼ばれない
- **判定**: ✅ PASS(静的)

---

#### TC-405: UX 優先 — シート書き込み失敗時も返信は行われる

- **severity**: S1(REQ-F14-Test-5・REQUIREMENTS §4-2 エラー耐性)
- **検証手法**: 静的検証(例外フロー追跡)
- **Given**: `upsertResponse(userId, scheduleId)` が例外を投げる(例: Lock 取得失敗 / スプレッドシート接続失敗)
- **When**: `handleVote(event)` の `try { upsertResponse(...) }` ブロックで例外が発生する
- **Then**: catch ブロックが `logError` を呼ぶだけで `return` しない → 続く `if (replyToken)` ブロックが実行され、返信が行われる

静的検証結果:
- `handlers.js` L383-391:
  ```
  try {
    var result = upsertResponse(userId, scheduleId);
    console.log('[INFO] vote recorded: ...');
  } catch (sheetError) {
    logError(sheetError, { phase: 'handleVote.upsert', ... });
    // シート書き込み失敗でも返信は続行
  }
  ```
- catch ブロックに `return` / `throw` がない → 続く L393 `if (replyToken)` が必ず実行される
- `handleFollow` の設計(シート失敗でも歓迎メッセージを送る)と同じ「UX 優先」パターンが踏襲されている
- **判定**: ✅ PASS(静的)

---

#### TC-406: replyToken なし — 返信をスキップしてもエラーにならない

- **severity**: S2(REQ-F14-Test-6)
- **検証手法**: 静的検証(ガード条件確認)
- **Given**: `event.replyToken` が存在しない(LINE Developers コンソールのテスト送信など)
- **When**: `handleVote(event)` が呼ばれる
- **Then**: `replyText` は呼ばれない。関数は正常に終了する(例外なし)

静的検証結果:
- `handlers.js` L356: `var replyToken = (event && event.replyToken) ? event.replyToken : '';`
- `replyToken` が空文字列になる
- `handlers.js` L393: `if (replyToken) { ... }` — `''` は falsy なので `replyText` の呼び出しブロック全体がスキップされる
- 例外は発生しない(if の中に入らないだけ)
- `handleFollow` の同一パターン(handlers.js L67: `if (replyToken)`)と完全に同じ設計
- **判定**: ✅ PASS(静的)

---

#### TC-407: シート自動作成 — responses シートが存在しない場合は自動作成される

- **severity**: S1(REQ-F14-Test-7)
- **検証手法**: 静的検証(初期化フロー追跡)
- **Given**: スプレッドシートに `responses` という名前のシートが存在しない
- **When**: `getResponsesSheet()` が呼ばれる
- **Then**: `responses` シートが自動作成され、ヘッダー 6 列 + 列書式が設定される

静的検証結果:
- `sheets.js` L591-597:
  ```javascript
  var sheet = ss.getSheetByName(RESPONSES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RESPONSES_SHEET_NAME);
    _initializeResponsesSheet(sheet);
  } else if (sheet.getLastRow() === 0) {
    _initializeResponsesSheet(sheet);
  }
  ```
- `_initializeResponsesSheet(sheet)` の内容(sheets.js L610-624):
  - ヘッダー行(`RESPONSES_HEADER` = 6 列)を書き込み、太字・先頭行固定
  - B 列(userId)/ C 列(scheduleId)を `setNumberFormat('@')` でテキスト書式固定
  - 6 列の列幅設定
- `RESPONSES_HEADER` = `['responseId','userId','scheduleId','canAttend','respondedAt','lastUpdatedAt']` が受け入れ条件の列構造と完全一致
- `getMembersSheet` / `getSchedulesSheet` と同一の「シートがなければ作成・空なら初期化」パターンで一貫性がある
- **判定**: ✅ PASS(静的)

---

### 非機能テスト

| カテゴリ | 結果 | 計測値 / 備考 |
|:--|:--:|:--|
| パフォーマンス(GAS 実行時間) | ✅ | `upsertResponse` は Lock 取得 → `withRetry` でシート 1 行更新。最大 10 秒待機(Lock) + リトライ最大 4+8 秒。replyToken 有効期限 1 分に対し余裕あり |
| セキュリティ | ✅ | scheduleId のみを postback data に持ち、個人情報は含まない。userId はログ出力時に `_maskUserId` でマスク済み |
| 並行アクセス(Lock) | ✅ | `upsertResponse` で `LockService.getScriptLock().tryLock(10000)` を使用。`upsertMemberAsActive` と同じパターンで重複書き込みを防止 |

---

### 機能 / 非機能 / 回帰の 3 軸テスト

#### 機能テスト

| Test ID | 受け入れ条件 | 結果 | 備考 |
|:--|:--|:--:|:--|
| TC-401 | postback → handleVote → responses 行追加 | ✅ | Code.js case 'postback' / upsertResponse 新規挿入ロジック確認 |
| TC-402 | 同一 userId+scheduleId → 行上書き(行増えない) | ✅ | _findResponseRow で既存行発見 → canAttend/lastUpdatedAt のみ更新 |
| TC-403 | action=vote 以外 → スルー(ログのみ) | ✅ | params.action !== 'vote' で console.log して return |
| TC-404 | scheduleId 欠如 → logError + 中断 | ✅ | !scheduleId で logError して return |
| TC-405 | シート書き込み失敗 → 返信は継続(UX 優先) | ✅ | catch に return なし → if(replyToken) ブロックが続行 |
| TC-406 | replyToken なし → 返信スキップ(エラーなし) | ✅ | if(replyToken) ガードで falsy 時は replyText 呼ばない |
| TC-407 | responses シート未作成 → 自動作成 | ✅ | getSheetByName null → insertSheet + _initializeResponsesSheet |

#### 非機能テスト

| カテゴリ | 結果 | 計測値 / 備考 |
|:--|:--:|:--|
| パフォーマンス | ✅ | Lock 最大 10 秒 + リトライ最大約 7 秒。replyToken 1 分以内に収まる |
| セキュリティ | ✅ | postback data に個人情報なし。userId はマスク出力 |
| 並行アクセス | ✅ | LockService でシート競合防止。upsertMemberAsActive と同一設計 |

#### 回帰テスト

| 既存テストスイート | 結果 | 備考 |
|:--|:--:|:--|
| F-1-1(follow/unfollow ハンドラ) | ✅ | handleFollow / handleUnfollow の定義に変更なし(末尾追加のみ) |
| F-1-2(schedules シート操作) | ✅ | addSchedule / getSchedules / getSchedulesSheet に変更なし |
| F-1-3(質問配信機能) | ✅ | handleDistributeSurvey / _buildSurveyFlex 等に変更なし |
| _routeEvent の既存ケース | ✅ | follow / unfollow / default ケースは変更なし。case 'postback' を追加したのみ |

---

### 良い点

- ✅ **upsert パターンの一貫性**: `upsertMemberAsActive`(F-1-1)と `upsertResponse`(F-1-4)が同じ設計思想(Lock → withRetry → findRow → 既存なら update / なければ insert)で実装されており、コードを読む人が類推しやすい
- ✅ **respondedAt の不変性**: 初回挿入時のみ `respondedAt` を書き込み、上書き時は `lastUpdatedAt` だけを更新する設計が正しく実装されている。回答の初回日時が後から変わらないため、データの追跡性が高い
- ✅ **_parsePostbackData の堅牢性**: `data.split('&')` → `indexOf('=')` で key/value を分解するロジックは、`=` を含む value(例: `scheduleId=SCH_abc=123` のような不正値)でも `indexOf` が最初の `=` のみを区切り文字として扱うため、意図しない分割が起きない
- ⭐ **responseId の採番ルール統一**: `_generateResponseId` が `_generateScheduleId` と同じアルゴリズム(`RES_` + yyyyMMddHHmmss + `_` + 4桁ランダム)を踏襲しており、D-012 の命名規則(プレフィックスで種別を識別・タイムスタンプで挿入順ソート可能・4桁ランダムで同一秒内衝突回避)が responses シートにも一貫して適用されている

---

### FAIL 詳細(5 段階 severity)

#### 🔴 致命(リリースブロッカー)

なし

#### 🟡 軽微(時間があれば対応)

なし

#### 🟢 余力(将来的に対応)

##### [TC-402 補足] _findResponseRow の線形検索スケール

- **カテゴリ**: 非機能(パフォーマンス)
- **期待**: responses シートの行数が増えても `_findResponseRow` が許容時間内に完了する
- **実際**: `sheet.getRange(2, RCOL_USER_ID, lastRow-1, 2).getValues()` で B〜C 列を一括取得し線形検索している。MVP 想定の参加者数(4-10 名・スケジュール週 7 件)では最大 70 行前後のため問題なし。ただし長期運用で蓄積すると検索時間が増加する
- **再現手順**:
  1. responses シートに 1000 行以上のデータを蓄積する
  2. ボタンをタップして postback を送信
  3. GAS の実行ログで `handleVote` の実行時間を確認する
- **想定原因**: 線形検索は O(n)。MVP 規模では問題なし(IMPLEMENTATION の REQUIREMENTS §4-1「節度ある運用」前提)
- **影響範囲**: 将来的に蓄積が増えた場合のみ。現状の利用規模では発生しない
- **severity 根拠**: Could 違反(将来検討。MVP 段階での必須対応ではない)

---

### 視覚的検証が必要な箇所

以下の項目は静的検証では確認できません。実機(LINE アプリ)での目視確認を推奨します。

- ボタンタップ後に「回答ありがとうございます! 参加希望を受け付けました。」が LINE トークに届くか
- 返信テキストの改行(\n)が LINE アプリ上で正しく表示されるか

---

### スコープ外発見

なし(今回のテスト対象ファイル 3 件(`src/sheets.js` / `src/handlers.js` / `src/Code.js`)はすべてユーザーが提示した変更ファイルに対応)

---

### 次のアクション

全テスト合格(静的検証)。`code-reviewer-ja` へ進むことができます。

実機確認として以下を推奨:
1. LINE Developers コンソールの「Webhook テスト送信」で postback イベントを送信し、GAS ログで `[INFO] vote recorded` が出ることを確認
2. 同じボタンを 2 回タップし、responses シートの行数が増えないことを確認(TC-402)
3. 返信テキストがスマートフォン LINE に届くことを確認

---

### 静的検証チェックリスト(F-1-4)

- ✅ `RESPONSES_SHEET_NAME` = `'responses'`(D-011 全小文字・単一単語)
- ✅ `RESPONSES_HEADER` が 6 要素: `['responseId','userId','scheduleId','canAttend','respondedAt','lastUpdatedAt']`
- ✅ 列インデックス定数(RCOL_*)が 1-based で 1〜6 の連番になっている
- ✅ `getResponsesSheet()` が `MEMBERS_SPREADSHEET_ID` で同一スプレッドシートを開いている
- ✅ `_initializeResponsesSheet()` がヘッダー・太字・先頭行固定・テキスト書式・列幅を設定している
- ✅ `upsertResponse(userId, scheduleId)` が両引数の null/空チェックをしている
- ✅ `upsertResponse` が `LockService.getScriptLock().tryLock(10000)` で排他制御している
- ✅ `upsertResponse` が `withRetry` でリトライしている(最大 DEFAULT_MAX_ATTEMPTS = 3 回)
- ✅ `_findResponseRow` が B〜C 列(userId + scheduleId)両方一致で既存行を探している
- ✅ 既存行発見時は `respondedAt`(E列)を変更せず `canAttend`(D列)と `lastUpdatedAt`(F列)のみ更新している
- ✅ `handleVote` が `params.action !== 'vote'` 時に `return` でスルーしている
- ✅ `handleVote` が `!scheduleId` 時に `logError` して `return` している
- ✅ `upsertResponse` の catch が `return` を含まず、返信コードが続行される設計になっている
- ✅ `if (replyToken)` ガードで replyToken が空のとき `replyText` を呼ばない
- ✅ `_generateResponseId()` が `'RES_' + timestamp + '_' + 4桁ランダム` 形式を返す(D-012 準拠)
- ✅ `Code.js` の `_routeEvent` に `case 'postback': handleVote(event); break;` が追加されている
- ✅ 既存の `handleFollow()` / `handleUnfollow()` / `handleDistributeSurvey()` に変更がない

---

### AC-4 の Given-When-Then 検証

**Given(前提)**:
- スプレッドシート(gas-badminton-scheduler-data)が作成済みで `MEMBERS_SPREADSHEET_ID` がスクリプトプロパティに設定されている
- F-1-3 で配信された Flex Message のボタンがユーザーの LINE に届いている

**When(実行)**:
- メンバーがボタンをタップする(postback イベントが Bot に届く)

**Then(結果)**:
1. responses シートに新規行が追加される(初回タップ)
   - A 列(responseId): `RES_` で始まる一意な文字列
   - B 列(userId): LINE が発行したユーザー ID
   - C 列(scheduleId): タップしたボタンの scheduleId
   - D 列(canAttend): `true`
   - E 列(respondedAt): ISO 8601 形式の初回回答日時
   - F 列(lastUpdatedAt): E 列と同じ値
2. 同じボタンを再タップしても行が増えない(上書き)
   - D 列(canAttend) と F 列(lastUpdatedAt) のみ更新される
3. Bot から「回答ありがとうございます! 参加希望を受け付けました。」の返信が届く
4. GAS の実行ログに `[INFO] vote recorded:` が出力される

→ 上記 1〜4 のすべてが満たされたとき、AC-4 は **PASS** と判定する。

---

### F-1-4 検証実行結果テーブル

| ID | 内容 | severity | 状態 |
|:--|:--|:--:|:--:|
| TC-401 | postback → handleVote → responses 行追加 | S1 | ✅ 静的 PASS(2026-05-10) |
| TC-402 | 同一 userId+scheduleId → 行上書き(行増えない) | S1 | ✅ 静的 PASS(2026-05-10) |
| TC-403 | action=vote 以外 → スルー(ログのみ) | S2 | ✅ 静的 PASS(2026-05-10) |
| TC-404 | scheduleId 欠如 → logError + 中断 | S1 | ✅ 静的 PASS(2026-05-10) |
| TC-405 | シート書き込み失敗 → 返信継続(UX 優先) | S1 | ✅ 静的 PASS(2026-05-10) |
| TC-406 | replyToken なし → 返信スキップ(エラーなし) | S2 | ✅ 静的 PASS(2026-05-10) |
| TC-407 | responses シート未作成 → 自動作成 | S1 | ✅ 静的 PASS(2026-05-10) |

---

### F-1-4 tester セルフリファイン採点

#### 基準 1: 受け入れ条件カバー率 — 10 / 10

- 良い点: 受け入れ条件 7 件すべてに REQ-F14-Test-X の Test ID を発行。TC-401〜TC-407 の 7 ケースが Must 受け入れ条件 100% をカバー
- 改善点: なし

#### 基準 2: エッジケース検証 — 9 / 10

- 良い点: 同一キー重複(TC-402)/ action 不一致(TC-403)/ scheduleId 欠如(TC-404)/ replyToken なし(TC-406)/ シート未作成(TC-407)の 5 つの異常系・境界系を検証。線形検索のスケール問題を 🟢 余力として記録
- 改善点: `userId` が欠如するケース(`event.source` が null など)のテストを独立ケースとして立てていない。ただし handlers.js L355-360 でガードされていることをコードで確認済みのため実質カバーされている

#### 基準 3: 回帰確認 — 10 / 10

- 良い点: F-1-1 / F-1-2 / F-1-3 の既存関数が変更なし(末尾追加のみ)であることを静的確認。`_routeEvent` の既存 case(follow/unfollow/default)に変更がないことも確認
- 改善点: なし

#### 基準 4: テスト網羅度 — 10 / 10

- 良い点: 機能テスト 7 件・非機能テスト 3 件・回帰テスト 4 件の 3 軸が揃っている。FAIL severity を 🔴/🟡/🟢 で区別(今回は 🟢 1 件のみ)
- 改善点: なし

#### 基準 5: 出力品質 — 10 / 10

- 良い点: 受け入れ条件カバーテーブルで後段が PASS/FAIL を即判定可能な形式。FAIL 詳細は 5 段階 severity と severity 根拠を明記。静的検証チェックリスト + AC-4 Given-When-Then + 実機確認手順を提供
- 改善点: なし

#### 合計: 49 / 50

#### 判定: 即合格(45-50)

---

## 改訂履歴(追記)

- **v0.5**(2026-05-10): F-1-4(回答収集機能)テスト計画を末尾追記。
  - REQ-F14-Test-1〜7 の 7 テスト ID を発行(受け入れ条件 100% カバー)
  - TC-401〜TC-407 の 7 機能テストケース + 非機能テスト 3 件 + 回帰テスト 4 件を追加
  - 静的検証チェックリスト(17 項目)+ AC-4 Given-When-Then + GAS 実機確認手順を追加
  - 総合判定: PASS(🔴 0 件 / 🟡 0 件 / 🟢 1 件)
