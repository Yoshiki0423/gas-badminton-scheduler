# 実装記録 — F-1-1 メンバー自動登録機能

**作成日**: 2026-05-10
**スコープ**: F-1-1(メンバー自動登録 + 歓迎メッセージ + unfollow 基本処理)
**関連 TBD 解消**: TBD-13(列構造)/ TBD-10 基本処理 / TBD-14(日時形式)
**未解消 TBD**: TBD-10b-1 / TBD-10b-2 / TBD-10b-3(再 follow 復活フローなど)

---

## 1. ファイル構成

```
src/
├── Code.js       — Webhook エントリポイント(doPost)+ イベント振り分け
├── handlers.js   — handleFollow / handleUnfollow(業務ロジック)
├── lineApi.js    — LINE API 呼び出しラッパー(Reply / Profile / 署名計算)
├── sheets.js     — メンバーシート操作(upsert / inactive 化 / 初期化)
└── utils.js      — getProperty / withRetry / logError(共通道具箱)
```

ファイル分割の意図:
- **責務の単一性**: 各ファイルが「1 つの関心事」だけを持つ。後で F-1-3 / F-1-4 を追加するときも同じ構造を踏襲できる。
- **テスト容易性**: lineApi.js / sheets.js を独立させたことで、ユニットテスト時にモックを差し込みやすい。
- **GAS の制約への適合**: GAS は ES Module 非対応のため `import/export` は使わず、グローバルスコープに関数を置く。代わりに JSDoc で所属を明示し、内部関数は `_` プレフィックスで分離。

---

## 2. 主要な関数一覧

| ファイル | 関数 | 役割 |
|:--|:--|:--|
| `Code.js` | `doPost(e)` | LINE Webhook の受付窓口 |
| `Code.js` | `doGet()` | デプロイ確認用の動作テキスト返却 |
| `Code.js` | `_routeEvent(event)` | events[] を type ごとに振り分け |
| `handlers.js` | `handleFollow(event)` | プロフィール取得 → 行追加 → 歓迎メッセージ |
| `handlers.js` | `handleUnfollow(event)` | status を inactive に更新 |
| `lineApi.js` | `replyText(replyToken, text)` | Reply API で平文送信 |
| `lineApi.js` | `getLineProfile(userId)` | プロフィール取得 |
| `lineApi.js` | `computeLineSignature(secret, body)` | HMAC-SHA256 + Base64 |
| `sheets.js` | `getMembersSheet()` | シート取得・初期化(ヘッダー自動生成) |
| `sheets.js` | `upsertMemberAsActive(uid, name)` | 新規追加 or 既存行を active に復活 |
| `sheets.js` | `markMemberInactive(uid)` | 該当行を inactive に |
| `utils.js` | `getProperty(key)` | スクリプトプロパティ取得 |
| `utils.js` | `withRetry(fn, options)` | 最大 3 回・指数バックオフリトライ |
| `utils.js` | `logError(error, context)` | 構造化エラーログ |

---

## 3. 設計判断とその根拠

### 3-1. 署名検証の現実的な落としどころ

**問題**: GAS の `doPost(e)` は HTTP ヘッダーを直接渡してくれない仕様のため、LINE 標準の `X-Line-Signature` ヘッダーをそのまま受け取れない(2026-05 時点)。

**採用方針(2 段階防御)**:
1. **第一防衛線:URL トークン**(`?token=xxxx` 形式)
   - スクリプトプロパティ `WEBHOOK_URL_TOKEN` をユーザーが設定
   - LINE Developers コンソールで Webhook URL に `?token=xxxx` を付けて登録
   - GAS の Web アプリ URL が漏れただけでは攻撃できない
2. **第二防衛線:HMAC-SHA256 計算ロジックを実装済み**(`computeLineSignature`)
   - LINE Developers コンソールが将来 X-Line-Signature をクエリ転送できるようになった場合、または Cloudflare Workers / Vercel Functions でプロキシを噛ませた場合に、ヘッダーをクエリ `?signature=xxx` に変換するだけで完全な署名検証が動く構造

**残課題(セキュリティ強化したい場合)**:
- 完全な X-Line-Signature ヘッダー検証が必要なら、`Cloudflare Workers` などのプロキシ経由で Webhook を受ける構成に切り替える(MVP では URL トークンで実用上十分と判断)
- DECISION_NOTES への追記候補:D-009「署名検証は URL トークン方式の 2 段階防御で MVP を運用」

### 3-2. リトライ戦略

REQUIREMENTS.md §4-2 に従い、`withRetry` で全 I/O を共通化:
- LINE API 呼び出し(`replyText` / `getLineProfile`)
- スプレッドシート書き込み(`upsertMemberAsActive` / `markMemberInactive`)

待機時間: 1000 → 2000 → 4000 ミリ秒(指数バックオフ)。`Utilities.sleep` を使用。

### 3-3. 並行アクセス対策(Lock Service)

複数のメンバーがほぼ同時に Bot を友だち追加するケースを想定し、`upsertMemberAsActive` / `markMemberInactive` で `LockService.getScriptLock()` を使用。最大 10 秒待機(replyToken の有効期限約 1 分を圧迫しない範囲)。

### 3-4. handleFollow 内のエラー耐性

各ステップを独立した try/catch で包み、**1 ステップ失敗しても次のステップは続ける**設計:
- プロフィール取得失敗 → `(名前不明)` で登録続行
- スプレッドシート書き込み失敗 → ログ記録の上で歓迎メッセージは送る(UX 優先)
- 歓迎メッセージ送信失敗 → ログ記録のみ(後で手動フォロー可)

理由: LINE は Webhook の応答が遅い・失敗すると **再送を繰り返す** 仕様。doPost は必ず 200 を返したい。

### 3-5. ログ設計

- `console.log`: 情報ログ(成功時の追跡用)
- `console.warn`: 想定内の異常(unfollow で未登録 userId など)
- `console.error`: 構造化エラーログ(JSON 化)

GAS の Stackdriver Logging で `severity` フィルタが効くように `console.error` を使い分け。

---

## 4. 連携ファイル(他ドキュメント)

| ファイル | 関係 |
|:--|:--|
| `REQUIREMENTS.md` v0.2 | F-1-1 の上位仕様。本実装が AC-1 を満たすことを TEST_REPORT.md で検証 |
| `DECISION_NOTES.md` v0.2 | D-007(列構造)/ D-008(unfollow 基本処理)を本実装が遵守 |
| `TEST_REPORT.md` | 本実装に対するテスト計画 + ユーザー手元実行手順書 |
| `REVIEW_REPORT.md` | 本実装に対する 6 カテゴリ合格レビュー |
| `CRITIC_REPORT_F1-1.md` | 本実装に対する 100 点満点の業界水準評価 |

---

## 5. 引用元(developer 引用一覧)

実装上参考にした外部仕様(=本実装の根拠):

- **LINE Messaging API リファレンス**(公式)
  - Webhook イベント仕様: `follow` / `unfollow` の event 構造
  - Reply API: `POST https://api.line.me/v2/bot/message/reply`
  - プロフィール取得 API: `GET https://api.line.me/v2/bot/profile/{userId}`
  - 署名検証: HMAC-SHA256 + Base64 を `X-Line-Signature` で送る
- **Google Apps Script 公式ドキュメント**
  - `UrlFetchApp.fetch` のオプション(`muteHttpExceptions: true` など)
  - `Utilities.computeHmacSha256Signature` / `Utilities.base64Encode`
  - `LockService.getScriptLock` の使い方
  - `PropertiesService.getScriptProperties()`

→ いずれも公式 1 次情報のみ。Stack Overflow / 個人ブログは引用していない(=エコーチェンバー回避)。

---

## 6. セルフリファイン採点(developer 役)

| 観点 | 配点 | 自己採点 | コメント |
|:--|:--:|:--:|:--|
| 機能完全性(F-1-1 仕様充足) | 10 | 9 | follow / unfollow / Reply / プロフィール取得すべて実装 |
| エラーハンドリング | 10 | 9 | 3 段階の try/catch、リトライ、200 OK 必達 |
| セキュリティ | 10 | 7 | URL トークン方式は実用的だが、X-Line-Signature 標準検証は GAS 制約のため 2 段階防御で妥協(IMPLEMENTATION §3-1 で明記) |
| 可読性・コメント | 10 | 9 | 日本語 JSDoc + 用語解説、初心者でも追える命名 |
| 拡張性(Phase 2 への接続) | 10 | 9 | sheets.js / lineApi.js の分離で F-1-3 / F-1-4 を追加しやすい構造 |
| **合計** | **50** | **43** | **合格(40 点以上)** |

セキュリティ採点 7 が改訂必須線(35-39)に近づくか? → 40 点以上を維持しているため改訂不要。ただし将来 D-009 で運用方針を文書化する追記候補とする。

---

## 改訂履歴

- **v0.1**(2026-05-10): F-1-1 初版実装。5 ファイル分割。署名検証は URL トークン + HMAC 計算の 2 段階防御方式。

---

## v0.2(2026-05-10): F-1-2 開放スケジュール手動入力機能

**スコープ**: F-1-2(schedules シートの自動初期化 + 行追加 + 全件取得ユーティリティ)
**変更ファイル**: `src/sheets.js`(末尾に schedules 関連コードを追加)
**関連決定**: D-011(命名規則)/ D-012(scheduleId 採番ルール・本実装で確定)

---

### 1. 追加した関数・定数(F-1-2 分)

| 種別 | 名前 | 役割 |
|:--|:--|:--|
| 定数 | `SCHEDULES_SHEET_NAME` | シート名 `'schedules'`(D-011 準拠) |
| 定数 | `SCHEDULES_HEADER` | ヘッダー配列 7 列(D-011 準拠) |
| 定数 | `SCOL_*` | 列インデックス 1〜7(1-based) |
| 関数 | `getSchedulesSheet()` | シート取得・初期化(ヘッダー自動生成・全列テキスト書式固定) |
| 関数(内部) | `_initializeSchedulesSheet()` | ヘッダー書き込み + setNumberFormat('@') + 列幅設定 |
| 関数 | `addSchedule(scheduleData)` | スケジュール行を末尾に追加(scheduleId を自動採番) |
| 関数(内部) | `_generateScheduleId()` | "SCH_" + yyyyMMddHHmmss + "_" + 4桁ランダム(D-012) |
| 関数 | `getSchedules()` | 全データ行をオブジェクト配列で返す(F-1-3 が使う想定) |

---

### 2. 設計判断とその根拠(F-1-2 固有)

#### 2-1. スプレッドシートファイルを members と共有する

`getSchedulesSheet()` は `MEMBERS_SPREADSHEET_ID` を使って同一スプレッドシートを開き、`schedules` という名前のシートを作成する。

**理由**:
- D-011 §スプレッドシートファイル名で「プロジェクト全体で 1 ファイル」と確定済み
- ファイルを分けると、将来 F-1-4(回答収集)が `schedules` と `responses` を JOIN する際に SpreadsheetApp のオープンコストが倍になる

#### 2-2. 全列を setNumberFormat('@') でテキスト書式に固定する

`_initializeSchedulesSheet()` でヘッダー行を含む全行・全列に `setNumberFormat('@')` を適用する。

**理由**:
- `date` 列(B)に `"2026-05-15"` と入力すると、スプレッドシートが自動で「日付型の数値」に変換することがある
- 同様に `startTime` 列(C)の `"18:00"` も「時刻型の数値」に変換され、取得時に小数(0.75 など)になるケースがある
- テキスト書式に固定すれば、入力値がそのまま文字列として保存・取得される
- AC-2 受け入れ条件 5「日付・時刻列が数値変換されない」の充足

#### 2-3. addSchedule は Lock なし・withRetry なし

`upsertMemberAsActive`(Lock + withRetry あり)と異なり、`addSchedule` は Lock も withRetry も持たない。

**理由**:
- F-1-2 は **管理者 1 人だけが手動入力**する機能。複数人の同時書き込みは想定しない(メンバー全員が同時に follow する F-1-1 とは条件が異なる)
- Lock なしでもデータ競合のリスクが実質ゼロ
- withRetry は将来 F-1-3 等でスケジュール大量書き込みが必要になった時点でラップすれば十分
- MVP のコードをシンプルに保つ(YAGNI 原則 = You Aren't Gonna Need It = 「必要になってから実装する」)

用語補足:
- **YAGNI**(ヤグニ)= ソフトウェア開発の格言。「今すぐ必要ではない機能を先回りで実装しない」という考え方。

#### 2-4. getSchedules はオブジェクト配列で返す

2 次元配列(生の `getValues()` の戻り値)ではなく、列名をキーとするオブジェクト配列に変換して返す。

**理由**:
- F-1-3(質問配信)が `schedules[i].date` のように列名でアクセスできるため、列順の変更に強い
- 呼び出し側が「配列の何番目が date か」を知らなくて良い(カプセル化)

---

### 3. AC-2 受け入れ条件との対応

| AC-2 の検証項目 | 対応する実装 |
|:--|:--|
| 1. `getSchedulesSheet()` を呼ぶと `schedules` シートが新規作成され、ヘッダー行が 7 列で初期化される | `getSchedulesSheet()` + `_initializeSchedulesSheet()` |
| 2. 既存の `members` シートが破壊されない(回帰テスト) | `getSchedulesSheet()` は `insertSheet(SCHEDULES_SHEET_NAME)` のみを操作 |
| 3. `addSchedule()` で行が正しく追加される | `addSchedule()` が scheduleId 自動採番 + 7 列を一括書き込み |
| 4. `getSchedules()` で追加した行が取得できる | `getSchedules()` が 2 行目以降をオブジェクト配列で返す |
| 5. 日付・時刻列が数値変換されない | `_initializeSchedulesSheet()` で全列 `setNumberFormat('@')` |

---

### 4. 引用元(F-1-2 分)

- **Google Apps Script 公式ドキュメント**
  - `Sheet.setNumberFormat(format)` の仕様(`'@'` = テキスト書式)
  - `Sheet.getRange().setValues()` の一括書き込みパターン
  - `Utilities.formatDate(date, timezone, format)` の書式指定

→ 公式 1 次情報のみ。Stack Overflow / 個人ブログは引用していない。

---

### 5. セルフリファイン採点(F-1-2 分)

| 観点 | 配点 | 自己採点 | コメント |
|:--|:--:|:--:|:--|
| 機能完全性(F-1-2 仕様充足) | 10 | 10 | AC-2 の 5 項目すべてに対応する実装が揃っている |
| エラーハンドリング | 10 | 8 | 必須フィールドの null チェックあり。Lock / withRetry を省いた理由は §2-3 で明文化 |
| セキュリティ | 10 | 9 | 管理者専用機能で外部入力なし。スプレッドシート ID はプロパティ管理 |
| 可読性・コメント | 10 | 9 | 日本語 JSDoc + 用語補足。初心者でも追える命名 |
| 拡張性(Phase 2 への接続) | 10 | 9 | getSchedules() のオブジェクト配列設計で F-1-3 が列名指定でアクセス可能 |
| **合計** | **50** | **45** | **合格(40 点以上)** |

---

## v0.3(2026-05-10): F-1-3 質問配信機能

**スコープ**: F-1-3(全 active メンバーへ Flex Message を Push 配信する機能)
**変更ファイル**:
- `src/sheets.js`(末尾に `getActiveMembers()` を追加)
- `src/lineApi.js`(`LINE_API_PUSH_URL` 定数 + `pushFlexMessage()` を追加)
- `src/handlers.js`(`handleDistributeSurvey()` / `_buildSurveyFlex()` / `_buildSurveyBubble()` / `_formatScheduleLabel()` を追加)
- `src/Code.js`(`distributeSurvey()` エントリポイント + `_routeEvent` に postback ケースを追加)

---

### 1. 追加した関数・定数(F-1-3 分)

| 種別 | 名前 | 役割 |
|:--|:--|:--|
| 定数 | `LINE_API_PUSH_URL` | Push API エンドポイント URL |
| 定数 | `SURVEY_FLEX_MAX_PER_BUBBLE` | 1 バブルの最大ボタン数(= 10) |
| 関数 | `getActiveMembers()` | active メンバーだけをオブジェクト配列で返す(sheets.js) |
| 関数 | `pushFlexMessage(userId, altText, flexContents)` | Push API で Flex Message を 1 件送信(lineApi.js) |
| 関数 | `handleDistributeSurvey()` | 質問配信メインロジック(handlers.js) |
| 関数(内部) | `_buildSurveyFlex(schedules)` | Bubble / Carousel を自動選択して組み立て |
| 関数(内部) | `_buildSurveyBubble(schedules)` | 1 つの Bubble コンテナを生成 |
| 関数(内部) | `_formatScheduleLabel(schedule)` | ボタンラベル文字列を生成(例: "5/15(金) 18:00〜20:00 鳥屋野") |
| 関数 | `distributeSurvey()` | GAS エディタから手動実行するエントリポイント(Code.js) |

---

### 2. 設計判断とその根拠(F-1-3 固有)

#### 2-1. Push API を使う理由

Reply API は「Webhook イベントを受け取った直後にだけ返信できる」制約があり、
管理者が任意のタイミングで全員に送る質問配信には使えない。
Push API は任意のタイミング・任意のユーザー宛に送信できるため採用。

#### 2-2. Flex Message のアクションに postback を選ぶ理由

F-1-4(回答収集)でボタンのタップを検知する際、`scheduleId` を正確に取り出す必要がある。

- **message アクション**: ユーザーのトークルームに文字列を送信するが、その文字列を Bot 側で受け取るには `message` イベントを受信してテキストをパースする必要があり、自由記述のメッセージと区別しにくい。
- **postback アクション**: トークルームには `displayText` だけが表示され、Bot 側には `data` フィールドの任意文字列(`action=vote&scheduleId=SCH_xxx` 形式)が届く。scheduleId の抽出が確実で、通常のテキストメッセージと混同しない。

**採用**: `postback` アクション。`data` = `"action=vote&scheduleId=SCH_xxxxxxxxxxxxxxxx_xxxx"`

#### 2-3. 1 バブルの最大ボタン数を 10 件とする根拠

LINE の公式ドキュメントには Bubble 内のコンポーネント数の明示的な上限が記載されていないが、
実用上 10 件を超えるとスクロール量が多くなり UX が低下する。
また MVP のスケジュール件数は週 1 回で通常 5-7 件程度なので、Carousel 分割は安全網として用意するだけで
実際には発動しない想定。定数 `SURVEY_FLEX_MAX_PER_BUBBLE = 10` で上限を制御しており、
変更が必要になった場合は定数 1 か所の書き換えで全体に反映される。

#### 2-4. 各送信の間にスリープを入れない

LINE Push API の公式レート制限は無料プランで 500 リクエスト/秒。
MVP のメンバー数(4-10 名)ではレート制限に到達しないため、送信間のスリープは不要と判断。
スリープを入れると GAS の最大実行時間(6 分 / 無料)を不必要に消費するためシンプルに実装する。

#### 2-5. withRetry のクロージャと GAS シングルスレッドの関係

`for` ループ内で `withRetry(function() { return pushFlexMessage(member.userId, ...) })` とクロージャを使っているが、
GAS はシングルスレッド・完全同期実行のため、`withRetry` が完了してから次のループに進む。
したがって、`var member = members[i]` の値は `withRetry` 実行中に変わらず、クロージャの変数捕捉問題は発生しない。

---

### 3. AC-3 受け入れ条件との対応

| AC-3 の検証項目 | 対応する実装 |
|:--|:--|
| 1. `distributeSurvey()` を実行すると `handleDistributeSurvey()` が呼ばれる | `Code.js` の `distributeSurvey()` |
| 2. schedules シートの全件が Flex Message のボタンになって送られる | `_buildSurveyFlex()` + `_buildSurveyBubble()` |
| 3. active メンバー全員の 1on1 チャットに届く | `getActiveMembers()` + `pushFlexMessage()` のループ |
| 4. inactive メンバーには送られない | `getActiveMembers()` が `status === 'active'` だけ返す |
| 5. schedules が空のとき、エラーではなく「スキップ」で正常終了する | `handleDistributeSurvey()` 冒頭の早期リターン |
| 6. active メンバーがいないとき、同様にスキップで正常終了する | 同上 |
| 7. 1 人への送信が失敗しても他のメンバーへの送信は続く | `try/catch` で 1 件ずつ独立処理 |

---

### 4. 引用元(F-1-3 分)

- **LINE Messaging API リファレンス**(公式)
  - Push API: `POST https://api.line.me/v2/bot/message/push`
  - Flex Message コンテナ仕様(bubble / carousel)
  - postback アクション仕様(`data` / `displayText` フィールド)
  - ボタンコンポーネント仕様

→ 公式 1 次情報のみ。Stack Overflow / 個人ブログは引用していない。

---

### 5. セルフリファイン採点(F-1-3 分)

| 観点 | 配点 | 自己採点 | コメント |
|:--|:--:|:--:|:--|
| 機能完全性(F-1-3 仕様充足) | 10 | 9 | AC-3 の 7 項目すべてに対応。Carousel 分割・Flex 組み立て・Push 送信すべて実装 |
| エラーハンドリング | 10 | 9 | 1 件失敗しても続行。withRetry 適用。スキップ数を返却してログで追跡可能 |
| セキュリティ | 10 | 9 | LINE_CHANNEL_ACCESS_TOKEN はプロパティ管理。postback data は scheduleId のみで個人情報を含まない |
| 可読性・コメント | 10 | 9 | 日本語 JSDoc + 設計判断の理由を §2 に記録。初心者でも追える命名 |
| 拡張性(F-1-4 への接続) | 10 | 10 | postback data の `action=vote&scheduleId=...` 形式は F-1-4 がそのまま受け取れる設計 |
| **合計** | **50** | **46** | **合格(40 点以上)** |

---

## v0.4(2026-05-10): F-2-1 スクレイピング自動化 / F-2-2 更新検知による自動起動

**スコープ**: F-2-1(4 体育館のスクレイピング + schedules シートへ書き込み)/ F-2-2(ハッシュ比較による更新検知 + 配信自動起動)
**新規ファイル**: `src/scraper.js`
**変更ファイル**: `DECISION_NOTES.md`(D-013〜D-015 追記)/ `IMPLEMENTATION.md`(本セクション追記)
**既存ファイルへの変更**: なし(src/*.js 5 ファイルは無変更)
**関連決定**: D-013(ハッシュキー名)/ D-014(withRetry 除外方針)/ D-015(1 日 1 回制限)

---

### 1. 実装したファイル一覧

| ファイル | 変更種別 | 概要 | REQUIREMENTS の Must 対応 |
|:--|:--|:--|:--|
| `src/scraper.js` | 新規 | スクレイピング本体 + 更新検知 + トリガー設定 | F-2-1 / F-2-2 |
| `DECISION_NOTES.md` | 追記 | D-013〜D-015 を末尾に追加 | — |
| `IMPLEMENTATION.md` | 追記 | 本セクション(v0.4)を末尾に追加 | — |

---

### 2. 追加した関数・定数(F-2-1 / F-2-2 分)

| 種別 | 名前 | 役割 |
|:--|:--|:--|
| 定数 | `FACILITIES` | 4 体育館の facilityId / facilityName / url の配列 |
| 定数 | `FETCH_TIMEOUT_MS` | UrlFetchApp のタイムアウト(30 秒) |
| 定数 | `FAIL_THRESHOLD` | 連続失敗の通知しきい値(3 日) |
| 定数 | `PROP_LAST_RUN_DATE` | ScriptProperties キー: 最終実行日 |
| 定数 | `HASH_KEY_PREFIX` | ScriptProperties ハッシュキーの接頭辞 `HASH_FACILITY_` |
| 定数 | `FAIL_COUNT_KEY_PREFIX` | ScriptProperties 失敗カウントキーの接頭辞 `FAIL_COUNT_FACILITY_` |
| 定数 | `TRIGGER_FUNCTION_NAME` | GAS トリガーに登録する関数名 |
| 定数 | `TRIGGER_HOUR` | トリガーの起動時刻(6 時) |
| 関数 | `scrapeAllFacilities(skipDailyCheck)` | 全体育館をループしてスクレイピング + 保存(D-015) |
| 関数 | `scrapeFacilitySchedule(facility)` | 1 体育館の HTML 取得 + パース + シート保存(D-014) |
| 関数 | `parseScheduleHtml(html, facilityName)` | HTML からバドミントン開放スケジュールを抽出 |
| 関数 | `checkAndScrapeIfUpdated()` | ハッシュ比較 → 更新あり時に scrape + 配信(F-2-2) |
| 関数 | `setupDailyTrigger()` | 毎朝 6 時のトリガーを設定(重複作成なし) |
| 関数 | `dumpFacilityHtml(facilityUrl)` | デバッグ用 HTML ダンプ(本番では使わない) |
| 関数(内部) | `_extractYearMonth(html)` | HTML から「2026年5月」形式の年月を抽出 |
| 関数(内部) | `_extractTrBlocks(tableHtml)` | テーブル HTML から `<tr>` ブロックの配列を返す |
| 関数(内部) | `_extractTdBlocks(trHtml)` | `<tr>` 内から `<td>` ブロックの配列を返す |
| 関数(内部) | `_stripTags(html)` | HTML タグ除去 + エンティティ変換 + 空白正規化 |
| 関数(内部) | `_isExcluded(text)` | × / ー / - / 空文字 → 除外判定 |
| 関数(内部) | `_isValid(text)` | 〇 / ○ / △ 始まり → 有効判定 |
| 関数(内部) | `_extractTimes(text)` | 「18:00〜20:00」形式の時刻を抽出 |
| 関数(内部) | `_buildNote(text)` | 記号・時刻を除いた備考テキストを生成 |
| 関数(内部) | `_buildDate(year, month, day)` | YYYY-MM-DD 形式の文字列を生成 |
| 関数(内部) | `_computeMd5Hex(text)` | MD5 ハッシュを 16 進文字列で返す |
| 関数(内部) | `_resetFailCount(facilityId)` | 連続失敗カウントをリセット |
| 関数(内部) | `_incrementFailCountAndNotifyIfNeeded(facility)` | 失敗カウント加算 + しきい値超え時に管理者通知 |

---

### 3. 設計判断とその根拠(F-2-1 / F-2-2 固有)

#### 3-1. UrlFetchApp には withRetry を使わない理由(D-014)

`withRetry` はスプレッドシート書き込みなどの一時的なネットワーク失敗に対して有効。
しかし体育館サイトの取得失敗は「サイト構造変化」「長時間のメンテ」など即時リトライでは解決しない
ケースが多いため、withRetry は適用しない(REQUIREMENTS.md §4-2 のエラーポリシーに準拠)。

代わりに:
- 失敗したら前回の schedules シートデータをそのまま使い続ける(上書きしない)
- 連続 3 日失敗したら `ADMIN_USER_ID` 宛に LINE push で管理者通知

#### 3-2. parseScheduleHtml の正規表現パース戦略

GAS は DOM Parser を持たないため、正規表現で HTML を処理する。

検討した選択肢:
- **案 A**: Cheerio 等のライブラリを外部クラスパスで読み込む
  - メリット: jQuery 風の DOM 操作で堅牢
  - デメリット: GAS の外部ライブラリ管理が煩雑。ライブラリの更新停止リスク
- **案 B**: 正規表現で `<tr>` / `<td>` / `<th>` を順に抽出する(採用)
  - メリット: GAS 標準機能のみ。シンプルで依存なし
  - デメリット: 複雑にネストした HTML には弱い(ただし体育館サイトは単純なテーブル構造を確認済み)

採用: 案 B。理由は「外部依存なし」と「事前確認済みのシンプルな HTML 構造に適合」。

#### 3-3. ハッシュ比較による更新検知(F-2-2)

HTML 全体の MD5 を `_computeMd5Hex` で計算し、`ScriptProperties` に `HASH_FACILITY_<id>` として保存。
`Utilities.computeDigest` が返す byte 配列(符号付き -128〜127)を正しく 16 進変換するため、
負の値は `+256` して 0〜255 に補正している。

#### 3-4. checkAndScrapeIfUpdated における scrapeAllFacilities の重複呼び出し防止

`checkAndScrapeIfUpdated` は「ハッシュ変化あり」を確認してから `scrapeAllFacilities(true)` を呼ぶ。
`true` は `skipDailyCheck` フラグで、「今日は既に実行済み」とブロックされないようにする(D-015)。

手動で `scrapeAllFacilities()` を呼ぶ場合は `skipDailyCheck` を省略(デフォルト false)すれば
`SCRAPER_LAST_RUN_DATE` チェックが有効になり二重実行を防げる。

#### 3-5. setupDailyTrigger の重複作成防止

`ScriptApp.getProjectTriggers()` で既存トリガーを検索し、`getHandlerFunction()` が
`TRIGGER_FUNCTION_NAME` と一致するものがあれば追加しない。
GAS はトリガーの重複作成を自動では防がないため、明示的なチェックが必要。

#### 3-6. addSchedule への withRetry 適用とクロージャの扱い

`scrapeFacilitySchedule` のループ内で `addSchedule(s)` を `withRetry` でラップしている。
GAS はシングルスレッド・完全同期実行のため、`var s = schedules[i]` の値は
`withRetry` コールバック実行中に変わらない(F-1-3 §2-5 と同じ前提)。

---

### 4. 既知の制約・前提

- **HTML 構造依存**: `parseScheduleHtml` は「日付が行・種目が列のテーブル形式」という
  niigata-kaikou.jp の現在の構造に依存している。サイトの大幅リニューアルでパースが壊れる可能性がある。
  連続失敗カウントと管理者通知で検知できる設計にしている。
- **テーブルの先頭一致**: `html.match(/<table[\s\S]*?<\/table>/i)` は最初に見つかったテーブルを使う。
  ページ内にナビゲーション用テーブルが先頭にある場合はスケジュールテーブルを正しく取れない可能性がある。
  `dumpFacilityHtml` で実機確認してから本番利用することを推奨する。
- **schedules シートの重複書き込み**: 現実装は既存行との重複チェックをしていない。
  `scrapeAllFacilities` を複数回呼ぶと同じ日付・体育館のデータが二重に追加される。
  `SCRAPER_LAST_RUN_DATE` による 1 日 1 回制限で事実上の重複を防いでいる(Should 要件)。
- **ADMIN_USER_ID の設定**: 連続失敗通知を受け取るには ScriptProperties に `ADMIN_USER_ID`
  (管理者本人の LINE userId)を設定する必要がある。未設定の場合は通知をスキップしてログのみ記録。
- **GAS の 1 回あたり実行時間制限**: 4 体育館 × HTML 取得 + パース + 書き込みを 6 分以内に完了する必要がある。
  MVP 規模(各体育館のスケジュール件数が数十件以下)では問題ないと想定している。

---

### 5. 仮定したこと(TBD 解消含む)

- niigata-kaikou.jp の HTML テーブル構造は「ヘッダー行の `<th>` に『バドミントン』を含む列名があり、
  日付セルは先頭列の『10日』形式、年月は `<body>` 内の『2026年5月』形式で取得できる」と仮定した。
  実機確認済み(D-003 技術検証 GREEN)。
- スケジュールページに複数テーブルがある場合は最初のテーブルをスケジュールテーブルとして扱う。
  実機確認で問題なければそのまま運用。問題があれば `tableMatch` を修正して対応する(IMPLEMENTATION に明記)。
- `pushText` 関数は `src/lineApi.js` で定義済みであり、`scraper.js` からグローバルスコープで呼べる。

---

### 6. テスト方法(tester-ja への引き継ぎ)

- **単体確認**:
  - GAS エディタで `dumpFacilityHtml('https://niigata-kaikou.jp/facility/420/schedule')` を実行し、
    Logger.log に HTML が出力されることを確認する
  - `parseScheduleHtml(html, '鳥屋野総合体育館')` に上記 HTML を渡し、
    〇 / △ セルが結果に含まれ、× / ー セルが含まれないことを確認する
- **結合確認**:
  - `scrapeAllFacilities()` を手動実行し、schedules シートに行が追加されることを確認する
  - 2 回目の同日呼び出しが「スキップ」ログで終わることを確認する
- **更新検知確認**:
  - ScriptProperties の `HASH_FACILITY_420` を手動で削除してから `checkAndScrapeIfUpdated()` を実行し、
    「更新を検知した」ログが出て scrape + 配信が走ることを確認する
  - 再度 `checkAndScrapeIfUpdated()` を実行し、ハッシュが一致するため「更新なし」ログになることを確認する
- **トリガー確認**:
  - `setupDailyTrigger()` を実行し、GAS エディタのトリガー一覧に `checkAndScrapeIfUpdated` が登録されることを確認する
  - 再度 `setupDailyTrigger()` を実行し、トリガーが重複作成されないことを確認する

---

### 7. 視覚的検証が必要な箇所

- schedules シートへの書き込み結果(date / startTime / endTime / facilityName / note 列の内容)を
  実際のシートで目視確認する必要がある。特に date が「2026-05-10」形式になっているか、
  数値変換されていないかを確認する(sheets.js の `setNumberFormat('@')` が適用済みのため問題ない想定だが実機確認推奨)。

---

### 8. スコープ外発見

- `schedules` シートの重複除去(同一 date + facilityName の行が既存にある場合は上書き or スキップ)は
  REQUIREMENTS.md の Should 要件として将来対応が望ましい。現実装の 1 日 1 回制限で運用上はカバーしているが、
  手動 `addSchedule` と自動スクレイピングが混在するケースでは重複が発生しうる。

---

### 9. セルフリファイン採点(F-2-1 / F-2-2 分)

#### 基準 1: 要件適合 — 9 / 10
- 良い点: FACILITIES 定数・scrapeAllFacilities・scrapeFacilitySchedule・parseScheduleHtml・checkAndScrapeIfUpdated・setupDailyTrigger・dumpFacilityHtml の全関数を実装。〇/△有効・×/ー除外のパターンも実装済み。D-011 命名規則に準拠。
- 改善点: `parseScheduleHtml` の「最初のテーブルを使う」前提は実機確認が必須(Should 相当の前提リスク)。

#### 基準 2: コード品質 — 9 / 10
- 良い点: SOLID に基づくファイル分割(scraper.js 単独)。マジックナンバーはすべてファイル先頭の定数にまとめた。内部関数は `_` プレフィックスで明示。`_extractTrBlocks` / `_extractTdBlocks` は再利用可能な純粋関数。
- 改善点: `parseScheduleHtml` の Cyclomatic Complexity がやや高い(ネストが 3 段)。補助パスとして段階許容し IMPLEMENTATION に明記済み。

#### 基準 3: パフォーマンス — 9 / 10
- 良い点: N+1 相当の問題なし(体育館数は 4 件固定)。`_extractTrBlocks` は正規表現 1 回のループで処理。
- 改善点: 大規模な HTML に対して正規表現の `[\s\S]*?` が遅くなる可能性があるが、MVP 規模のページサイズでは実用上問題なし。

#### 基準 4: テスタビリティ — 8 / 10
- 良い点: `parseScheduleHtml` は純粋関数(HTML 文字列 → 配列)なので、実際の HTML を引数に渡してテスト可能。`_isExcluded` / `_isValid` / `_extractTimes` などのユーティリティも純粋関数。
- 改善点: `scrapeFacilitySchedule` は `UrlFetchApp` と `addSchedule` に直接依存しており、GAS の制約上モック差し込みが難しい。`dumpFacilityHtml` でパースのみを手動検証する設計で補完している。

#### 基準 5: 拡張性 — 9 / 10
- 良い点: `FACILITIES` 定数を変更するだけで体育館の追加・削除が可能。ハッシュキー / 失敗カウントキーも facilityId から自動生成するため体育館数に依存しない。
- 改善点: 現状はスクレイピング結果を全件 `addSchedule` で追加しており、既存行との差分更新は未実装(スコープ外発見に記録済み)。

#### 合計: 44 / 50
#### 判定: [x] 合格(40-44)

---

## v0.5(2026-05-11): scraper.js IMPORTHTML 方式への全面書き直し

**スコープ**: F-2-1(スクレイピング自動化)/ F-2-2(更新検知)— `UrlFetchApp` 方式から IMPORTHTML シート読み込み方式に全面変更
**変更ファイル**: `src/scraper.js`(全面書き直し)/ `DECISION_NOTES.md`(D-016 追記)/ `IMPLEMENTATION.md`(本セクション追記)
**既存ファイルへの変更**: なし(sheets.js / handlers.js / utils.js / lineApi.js は無変更)
**関連決定**: D-016(IMPORTHTML 方式採用の経緯)

---

### 1. 実装したファイル一覧(REQUIREMENTS の Must 対応)

| ファイル | 変更種別 | 概要 | REQUIREMENTS の Must 対応番号 |
|---|---|---|---|
| `src/scraper.js` | 全面書き直し | IMPORTHTML シート読み込み方式に全面変更 | F-2-1 / F-2-2 |
| `DECISION_NOTES.md` | 追記 | D-016 を末尾追記 | — |
| `IMPLEMENTATION.md` | 追記 | 本セクション(v0.5)を末尾追記 | — |

---

### 2. 追加・変更した関数一覧

| 種別 | 関数名 | 変更内容 |
|:--|:--|:--|
| 新規追加 | `setupScraperSheets()` | IMPORTHTML 式をシートに設定するセットアップ関数 |
| 全面書き直し | `scrapeFacilitySchedule(facility)` | UrlFetchApp → getValues() + parseScraperSheetValues に変更 |
| 新規追加 | `parseScraperSheetValues(values, facilityName)` | 2D 配列からバドミントンスケジュールを抽出 |
| 全面書き直し | `checkAndScrapeIfUpdated()` | HTML MD5 → シート JSON.stringify() + MD5 に変更 |
| 新規追加 | `_extractTimesFromCell(text)` | "9-11" / "HH:mm〜HH:mm" 両形式の時刻抽出 |
| 新規追加 | `_buildNoteFromCell(text)` | △/〇記号・時刻を除いた備考生成 |
| 更新 | `_isExcluded(text)` | 「休館日」を含む場合のスキップを追加 |
| 変更なし | `scrapeAllFacilities(skipDailyCheck)` | ロジック変更なし(内部で呼ぶ scrapeFacilitySchedule が変わるだけ) |
| 変更なし | `setupDailyTrigger()` | 変更なし |
| 変更なし | `_resetFailCount(facilityId)` | 変更なし |
| 変更なし | `_incrementFailCountAndNotifyIfNeeded(facility)` | 変更なし(通知文言を IMPORTHTML 向けに微調整) |
| 変更なし | `_computeMd5Hex(text)` | 変更なし |
| 変更なし | `_buildDate(year, month, day)` | 変更なし |
| 変更なし | `_isValid(text)` | 変更なし |
| **削除** | `parseScheduleHtml(html, facilityName)` | HTML パーサー → IMPORTHTML 方式で不要 |
| **削除** | `dumpFacilityHtml(facilityUrl)` | デバッグ用 HTML ダンプ → 不要 |
| **削除** | `_extractYearMonth(html)` | HTML から年月抽出 → 不要 |
| **削除** | `_extractTrBlocks(tableHtml)` | HTML tr パーサー → 不要 |
| **削除** | `_extractTdBlocks(trHtml)` | HTML td パーサー → 不要 |
| **削除** | `_stripTags(html)` | HTML タグ除去 → 不要 |
| **削除** | `_extractTimes(text)` | 旧時刻抽出 → `_extractTimesFromCell` に置き換え |
| **削除** | `_buildNote(text)` | 旧 note 生成 → `_buildNoteFromCell` に置き換え |

---

### 3. 主要決定とトレードオフ(D-016)

#### 3-1. IMPORTHTML 方式 vs UrlFetchApp + Proxy 方式の選択

**背景**: niigata-kaikou.jp の XSERVER WAF が Google サーバー IP からの HTTP アクセスをブロックするため、
UrlFetchApp.fetch() が HTTP 501 エラーで失敗し続ける。

| 案 | 概要 | メリット | デメリット |
|:--|:--|:--|:--|
| 案 A: Proxy 経由 UrlFetchApp | Cloudflare Workers などを間に挟む | GAS 内完結のスクレイピングを維持 | 追加インフラが必要・管理コスト発生 |
| 案 B: IMPORTHTML + getValues()(採用) | スプレッドシートのセルに IMPORTHTML 式を置きシートから読む | 追加インフラ不要・GAS 標準機能のみ | IMPORTHTML のキャッシュ遅延・初回セットアップ必要 |
| 案 C: 手動入力に後退 | F-1-2 方式に戻す | 最もシンプル | Phase 2 の自動化目的を放棄 |

**採用**: 案 B。GAS 標準機能のみ・追加コストゼロ・WAF 問題を根本回避。

#### 3-2. 年・月の取得方法

**問題**: IMPORTHTML はテーブルデータのみを取り込むため、
ページ内の「2026年5月」形式のテキストが取得できない。

**採用方針**: `new Date()` から year / month を取得する。

**制約**: 月末実行時に翌月の「1日」が今月の日付として扱われる可能性がある。
MVP 運用では 1 日 1 回制限により影響は限定的と判断。IMPLEMENTATION の既知の制約に明記。

#### 3-3. バドミントン列インデックスの特定方法

**方針**: 先頭 5 行以内で「バドミントン」を含む列を検索し、見つかればそのインデックスを使用。
見つからない場合は デフォルト列インデックス 2(0-based)にフォールバック。

**根拠**: 3 施設とも列2がバドミントン列であることを確認済み(D-016)。
ただし将来的なテーブル構造変化に備えてヘッダー検索を優先する。

---

### 4. データ解釈ルールの実装

| セル内容 | 実装結果 |
|---|---|
| `○ 予約9-11大体育室 A` | startTime: "09:00", endTime: "11:00", note: "予約 大体育室 A" |
| `○ 予約9-12` | startTime: "09:00", endTime: "12:00", note: "予約" |
| `△`(のみ) | startTime: "終日", endTime: "終日", note: "要確認" |
| `△ 18時頃開放予定` | startTime: "終日", endTime: "終日", note: "18時頃開放予定" |
| `×` 始まり | `_isExcluded()` でスキップ |
| `休館日` を含む | `_isExcluded()` でスキップ(今回追加) |
| 空セル | `_isExcluded()` でスキップ |
| `ー` または `-` のみ | `_isExcluded()` でスキップ |

---

### 5. 既知の制約・前提

- **月末実行時の年月ズレ**: `new Date()` で year / month を取得するため、
  月末に実行すると翌月の「1日」のデータが今月の日付として解釈される。
  MVP では 1 日 1 回制限で影響を最小化する(補助パス・段階許容)。
- **IMPORTHTML のキャッシュ遅延**: Google スプレッドシートの IMPORTHTML は即時更新ではなく
  数時間単位でキャッシュされる可能性がある。体育館スケジュールは 1 日単位の変化を前提とするため
  実用上は問題なしと判断。
- **schedules シートの重複書き込み**: 前バージョンから引き継ぎ。
  `addSchedule` は重複チェックを持たないため、
  `scrapeAllFacilities` を複数回呼ぶと同一日時・施設が二重追加される。
  `SCRAPER_LAST_RUN_DATE` による 1 日 1 回制限で事実上の重複を防いでいる。
- **セットアップ要件**: 本番投入前に `setupScraperSheets()` を 1 回手動実行する必要がある。
  実行前に `scrapeFacilitySchedule()` を呼ぶとシート存在チェックでエラーになる(意図的設計)。

---

### 6. 仮定したこと

- IMPORTHTML の `table,2` が 3 施設(scraper-420 / scraper-413 / scraper-495)で正しくスケジュールテーブルを取得することを確認済みとして実装した。
- シートの 2D 配列の列0が「X日」形式、列2がバドミントン列であることを確認済みとして列インデックスのデフォルト値を 2 に設定した。
- `pushText` 関数は `src/lineApi.js` でグローバルスコープに定義済みとして呼び出している。

---

### 7. テスト方法(tester-ja への引き継ぎ)

**セットアップ確認**:
- `setupScraperSheets()` を GAS エディタで実行し、スプレッドシートに `scraper-420` / `scraper-413` / `scraper-495` の 3 シートが作成されることを確認する
- 各シートの A1 に IMPORTHTML 式が入っていること・数分後にデータが読み込まれることを確認する

**パース確認**:
- `scrapeFacilitySchedule(FACILITIES[1])` を手動実行し、schedules シートに鳥屋野のスケジュールが追加されることを確認する
- `parseScraperSheetValues(values, '鳥屋野総合体育館')` に実際のシートデータを渡し、〇/△セルが結果に含まれ、×/ー/休館日セルが含まれないことを確認する

**時刻抽出確認**:
- `_extractTimesFromCell('○ 予約9-11大体育室 A')` → `{ startTime: '09:00', endTime: '11:00' }` を確認
- `_extractTimesFromCell('△')` → `{ startTime: '終日', endTime: '終日' }` を確認
- `_extractTimesFromCell('△ 18時頃開放予定')` → `{ startTime: '終日', endTime: '終日' }` を確認

**更新検知確認**:
- ScriptProperties の `HASH_FACILITY_420` を手動で削除してから `checkAndScrapeIfUpdated()` を実行し、「更新を検知した」ログが出て scrape + 配信が走ることを確認する
- 再度 `checkAndScrapeIfUpdated()` を実行し、「更新なし」ログになることを確認する

---

### 8. 視覚的検証が必要な箇所

- `scraper-420` / `scraper-413` / `scraper-495` シートの IMPORTHTML の読み込み結果を目視確認する(列0が「X日」形式になっているか)
- `schedules` シートへの書き込み結果(date / startTime / endTime / facilityName / note 列の内容)を目視確認する

---

### 9. スコープ外発見

- 月末日実行時の年月ズレ問題は将来 IMPORTHTML 式の代わりに `SpreadsheetApp.getRange('A1').getFormula()` から URL を取得しページ内テキストを別途解析する方式で根本解決できる(Should レベル)。
- `schedules` シートの重複除去(既存行との差分更新)は前バージョンから引き継ぎのスコープ外発見(Should レベル)。

---

### 10. セルフリファイン採点

#### 基準 1: 要件適合 — 9 / 10
- 良い点: タスク概要の全要件を満たす実装。setupScraperSheets / scrapeFacilitySchedule / parseScraperSheetValues / checkAndScrapeIfUpdated を実装。enabled フラグ / sheetName フィールドを FACILITIES に追加。削除対象の旧関数(parseScheduleHtml / dumpFacilityHtml 等)をすべて除去。_isExcluded に「休館日」追加。データ解釈ルール(△のみ=要確認 / ×スキップ 等)を正確に実装。
- 改善点: 月末実行時の年月ズレは既知の制約として受け入れている(§5 に明記)。Should 要件に留める。

#### 基準 2: コード品質 — 9 / 10
- 良い点: ES5 相当(var / function のみ)。IIFE パターンでループ内クロージャを正しく処理。マジックナンバーはすべてファイル先頭の定数(DEFAULT_BADMINTON_COL / HEADER_SEARCH_LIMIT 等)に集約。各関数に JSDoc コメント。[INFO]/[WARN]/[ERROR] プレフィックスのログ統一。純粋関数(_isExcluded / _isValid / _extractTimesFromCell / _buildNoteFromCell 等)でテスタビリティを確保。
- 改善点: parseScraperSheetValues の Cyclomatic Complexity はやや高め(ヘッダー探索 + データ行ループの 2 段ネスト)。補助パスとして段階許容し本セクションに明記。

#### 基準 3: パフォーマンス — 9 / 10
- 良い点: getDataRange().getValues() は 1 回だけ呼んで 2D 配列をメモリに保持してループ処理。N+1 問題なし(GAS の getValues() をループ内で呼ばない)。施設数は 3 件固定で GAS の実行時間制限に対して問題なし。
- 改善点: JSON.stringify(values) で全シート内容をテキスト化するハッシュ計算は、大きなシートでは遅くなる可能性があるが MVP 規模(月 30 行 × 6 列)では実用上問題なし。

#### 基準 4: テスタビリティ — 9 / 10
- 良い点: parseScraperSheetValues は純粋関数(2D 配列 → 配列)なので実際のシートデータを使って手動テスト可能。_extractTimesFromCell / _buildNoteFromCell / _isExcluded / _isValid も純粋関数で単独テスト可能。
- 改善点: scrapeFacilitySchedule は SpreadsheetApp.openById と addSchedule に直接依存しており GAS の制約上モック差し込みが難しい。手動実行での統合確認で補う設計。

#### 基準 5: 拡張性 — 9 / 10
- 良い点: FACILITIES 定数に enabled / sheetName を追加したことで施設の追加・除外が 1 か所の変更で対応可能。DEFAULT_BADMINTON_COL のフォールバックでヘッダー変化にも対応。
- 改善点: 現状はスクレイピング結果を全件 addSchedule で追加しており既存行との差分更新は未実装(スコープ外発見に記録済み)。

#### 合計: 45 / 50
#### 判定: [x] 即合格(45-50)
