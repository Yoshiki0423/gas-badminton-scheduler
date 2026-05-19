# コードレビューレポート(実施日時: 2026-05-14T12:00)

## 総合判定

**PASS ✅** — 必須 Must 項目はすべて充足。指摘件数: 🔴 0 件 / 🟡 3 件 / 🟢 4 件

> 致命的ブロッカーはなし。ただし IMPLEMENTATION_F3.md に記載された設計(GAS ホスト型 + `google.script.run`)と実際の実装(GitHub Pages + `fetch()` + GET API)が大きく乖離しているため、ドキュメント追記を強く推奨する。

---

## チェック観点(6 カテゴリ)

| # | カテゴリ | 結果 | 備考 |
|---|---|---|---|
| 1 | バグ・ロジックエラー | ✅ | `var data` 二重宣言あり(🟡)。動作には影響しない |
| 2 | セキュリティ | ✅ | ID Token を GAS 側で LINE API 検証済み。GET URL への idToken 露出は許容範囲内(後述) |
| 3 | パフォーマンス | ✅ | `handleLiffSubmitFast` で Lock 1 回・`setValues` 一括書き込みに最適化済み |
| 4 | コード品質 | ✅ | SRP 準拠(Code.js = ルーティング / handlers.js = 処理)。デフォルト引数設計も後方互換を維持 |
| 5 | 可読性・保守性 | ✅ | JSDoc・インラインコメント充実。ただし IMPLEMENTATION_F3.md との設計乖離で保守時の混乱リスクあり(🟡) |
| 6 | ベストプラクティス | ✅ | `LockService`・`SpreadsheetApp.flush()`・後方削除による行番号ズレ防止など GAS ベストプラクティスを踏襲 |

---

## 仕様適合(`REQUIREMENTS.md` Must との突合)

| Must 項目 | 充足 | 根拠(コード参照) |
|---|---|---|
| AC-9: LIFF 回答フォームが開き 14 日分のスケジュールを表示 | ✅ | `handlers.js:798-829` `_filterUpcomingSchedules` が SURVEY_SCHEDULE_DAYS=14 で絞り込み / `docs/liff.html` でフォームを描画 |
| AC-10: 前回答の復元表示 | ✅ | `sheets.js:906-933` `getResponsesByUserId` → `handlers.js:813-823` `userAnswers` に変換 → `docs/liff.html:149-151` で復元 |
| AC-11: 送信後に Bot メッセージなし | ✅ | `handlers.js:846` コメント「AC-11」明記、`handleLiffSubmit`/`handleLiffSubmitFast` ともに LINE Push API 呼び出しなし |
| AC-12: 全員の回答状況を LINE 表示名で表示 | ✅ | `handlers.js:977-1028` `handleLiffGetAllResponses` が `members` シートの `displayName` を使用 / `docs/liffResults.html` で描画 |
| AC-13: 2 ボタン形式配信 | ✅ | `handlers.js:208-269` `_buildTwoButtonFlex` / `handleDistributeSurvey`・`handleSendReminders` が `pushFlexMessage` で送信 |
| F-3-5 セキュリティ要件: クライアントから displayName を直接送らせない | ✅ | `lineApi.js:283-343` `verifyLineIdToken` が LINE 検証 API を呼び、`sub`(userId)と `name`(displayName)を取得 / クライアントは idToken のみ送信 |
| D-017: `setXFrameOptionsMode(ALLOWALL)` 設定 | ✅ | `Code.js:154,170` 両ページに `setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)` を設定 |
| D-020: 全削除→再挿入パターン | ✅ | `handlers.js:858-888` `handleLiffSubmit` / `handlers.js:897-947` `handleLiffSubmitFast` 両方で実装 |

---

## 良い点

- ⭐ **`handleLiffSubmitFast` によるパフォーマンス最適化の完成度**: `LockService.tryLock(15000)` で排他制御 → userId の既存行を B 列一括読み込みで検出 → 後ろから `deleteRow` で行番号ズレを防止 → `setValues` で一括書き込み → `SpreadsheetApp.flush()` で即時反映、という GAS のベストプラクティスを 4 点すべて満たした実装になっている。処理時間の 50 秒→数秒化という要件を最小のコード変更で達成している。

- ⭐ **`verifyLineIdToken` の堅牢な設計**: idToken が空・`LINE_CHANNEL_ID` 未設定・HTTP エラー・JSON パース失敗・`sub` フィールド欠損のすべてのケースで `null` を返して呼び出し元に判定を委ねる設計。各 `null` を返す分岐に `console.warn` でログを残しており、デバッグ容易性も高い。F-3-5 のセキュリティ要件(なりすまし防止)を適切にカバーしている。

- ✅ **後方互換の徹底的な維持**: `upsertResponse(userId, scheduleId, canAttend)` の第 3 引数デフォルト値を `true` とすることで、既存の `handleVote` 呼び出し(`sheets.js:747`)が一切変更不要。`_buildSurveyFlex`/`_buildSurveyBubble` も D-021 に従って削除せず残存。`doGet` のデフォルトパスがヘルスチェックテキストを維持している点も確認。

- ✅ **HTML の XSS 対策**: `docs/liff.html` / `docs/liffResults.html` 両方に `esc()` 関数(5 種類のエスケープ: `&`, `<`, `>`, `"`, `'`)が実装されており、サーバーから受け取った `displayName`・スケジュール情報を HTML に出力する際に必ず `esc()` を通している。

- ✅ **`handleLiffGetAllResponses` のデータ取得設計**: `members` シートの `displayName` を事前にマップ化して `getAllResponses` の結果と紐付ける 2 段階処理により、LINE Profile API を都度叩かない設計になっており、GAS の実行時間上限(90 分/日)への影響を最小化している。

---

## 改善優先度リスト

### 🔴 致命的(リリースブロッカー)

なし

---

### 🟡 要改善

#### [可読性・保守性] IMPLEMENTATION_F3.md の設計説明が実際の実装と大きく乖離している

- **場所**: `IMPLEMENTATION_F3.md:29-45` / `docs/liff.html:104-105` / `docs/liffResults.html:82-83`
- **問題**: IMPLEMENTATION_F3.md の「設計の判断根拠」(§7 D-019 候補)では「`google.script.run` を採用する」「GAS ホスト型 HTML から呼ぶ場合は `google.script.run` が正攻法」と明記されているが、実際の実装は GitHub Pages ホスティング + `fetch()` + GET パラメータ JSON API(`?liff=getSchedules&idToken=...`)に変更されている。ファイルの置き場所も `src/liff.html` ではなく `docs/liff.html` になっている。
- **理由**: DECISION_NOTES.md の D-017 で「GAS の `script.google.com` ドメインでは `liff.init()` がハングする」という問題が発生しフォールバック(外部ホスティング)を採用したことは妥当な判断だが、その意思決定が IMPLEMENTATION_F3.md / DECISION_NOTES.md に反映されていない。将来の保守者が「なぜ `google.script.run` でなく `fetch()` なのか」を理解できず、誤って書き直してしまうリスクがある。Context Confusion(無関係な古い設計情報が判断に影響する)を引き起こす典型例。
- **修正案**: `DECISION_NOTES.md` に D-019 を新規追記する。

```markdown
## D-019: GitHub Pages + fetch() 方式を採用(LIFF 通信・フォールバック確定)

- **決定日**: 2026-05-12
- **決定**: LIFF HTML の GAS 通信に `google.script.run` ではなく
  GitHub Pages ホスティング + `fetch()` + GET パラメータ JSON API を採用する。
- **背景・課題**: D-017 で記録した「GAS の `script.google.com` ドメインでは
  `liff.init()` がハングする」問題が実機検証で確認された。
- **採用理由**:
  - GitHub Pages は `https` で配信でき、LIFF の必須要件を満たす
  - GAS の doGet を JSON API として公開する実装は既存のルーターを活用でき最小変更で済む
  - `google.script.run` は GAS ホスト HTML 専用のため、GitHub Pages からは使用不可
- **影響範囲**:
  - `docs/liff.html` / `docs/liffResults.html` — GitHub Pages 配置
  - `Code.js` — `_handleLiffApi` / `_jsonResponse` の新規追加
  - `IMPLEMENTATION_F3.md` §7 D-019 候補の記述は本決定で「`google.script.run` 案を不採用」
    に確定したため、v1.2 で更新要
```

---

#### [バグ・ロジックエラー] `_handleLiffApi` 内で `var data` が二重宣言されている

- **場所**: `src/Code.js:392` / `src/Code.js:398`
- **問題**: 同一関数スコープ内に `var data` が 2 回宣言されている。GAS の JavaScript エンジン(V8)は `var` を関数スコープにホイスティングするため動作上は問題ないが、`strict mode` 環境や Lint ツール適用時に警告が出る。また `getAllResponses` と `handleLiffGetData` の戻り値を同じ変数名 `data` で受け取ることで、将来コードを読む人が「どちらの data か」を区別しにくい(Cognitive Complexity を上げる要因)。

```javascript
// 現在: Code.js L391-398
if (action === 'getSchedules') {
  var data = handleLiffGetData(identity.userId);  // ← 1回目
  return _jsonResponse({ ok: true, data: data });
}

if (action === 'getAllResponses') {
  var data = handleLiffGetAllResponses();          // ← 2回目(二重宣言)
  return _jsonResponse({ ok: true, data: data });
}

// 修正後: 変数名を分ける
if (action === 'getSchedules') {
  var scheduleData = handleLiffGetData(identity.userId);
  return _jsonResponse({ ok: true, data: scheduleData });
}

if (action === 'getAllResponses') {
  var allResponseData = handleLiffGetAllResponses();
  return _jsonResponse({ ok: true, data: allResponseData });
}
```

---

#### [セキュリティ] GET パラメータに idToken を含めてサーバーに送信している

- **場所**: `docs/liff.html:137` / `docs/liff.html:200-202` / `docs/liffResults.html:113`
- **問題**: `fetch(GAS_API_URL + '?liff=getSchedules&idToken=' + encodeURIComponent(idToken))` のように、ID Token を GET パラメータとして送信している。GET パラメータはブラウザのアドレスバー・履歴・サーバーアクセスログ・リファラーヘッダーに残る可能性がある。OWASP A02(Cryptographic Failures)の観点では、認証トークンを URL に含めることは推奨されないパターン(CWE-598: Information Exposure Through Query Strings in GET Request)。
- **理由(コンテキスト)**: GAS の `doGet` に POST はできないため、fetch の POST + body でトークンを送れない制約がある。また LIFF ID Token の有効期間は短く(数分)、クローズドコミュニティ前提の本プロジェクトでは実用上リスクは低い。GAS アクセスログは管理者しか見られない。この理由から 🔴 致命的ではなく 🟡 要改善に留める。
- **修正案**: 現状の制約では完全な回避は困難。ただし送信時に `?liff=submit` で answers も GET パラメータに含める(Code.js:402)のはログ露出リスクが高まる。少なくともコメントで「GAS doGet の制約上 POST 不可・短命 idToken のため許容」と記載し、将来外部 Proxy を経由する場合は POST への移行を検討する旨を明記することを推奨する。

```javascript
// docs/liff.html — submit 関数のコメント追記案
// Note: GAS の doGet は POST リクエストを受け付けられないため GET パラメータを使用。
// idToken は LIFF SDK が短命(数分)のトークンを生成するため、実用上のリスクは限定的。
// クローズドコミュニティ前提の運用を超える場合は、外部 Proxy 経由の POST 方式に移行すること。
var url = GAS_API_URL + '?liff=submit'
  + '&idToken=' + encodeURIComponent(idToken)
  + '&answers=' + encodeURIComponent(JSON.stringify(answers));
```

---

### 🟢 提案

#### [可読性・保守性] `liff.html` / `liffResults.html` に LIFF_ID と GAS_API_URL がハードコードされている

- **場所**: `docs/liff.html:104-105` / `docs/liffResults.html:82-83`
- **問題**: LIFF_ID(`2010067159-goZKGxNN`)と GAS デプロイ URL がソースコードに平文で書かれており、GitHub にそのまま push されている状態。URL が変わるたびにファイルを書き換えて push が必要になる。
- **理由(コンテキスト)**: GitHub Pages の静的 HTML では環境変数を実行時に注入できない制約がある。LIFF アプリは公開 URL が必要なためある程度の公開は前提。実害リスクは低い(GAS 側で idToken 検証を必須としているため悪用は困難)。
- **提案**: `README.md` や `docs/SETUP.md` に「本番用の LIFF_ID / GAS_API_URL は `docs/liff.html` / `docs/liffResults.html` の該当行を書き換えて push する」手順を明記し、機密情報ではない旨を記録しておく。

#### [ベストプラクティス] `Code.js` の `liffSubmitResponses` が `handleLiffSubmit`(旧版)を呼んでいる

- **場所**: `src/Code.js:233`
- **問題**: `google.script.run` 用サーバー関数 `liffSubmitResponses` は `handleLiffSubmit`(旧版・逐次書き込み)を呼んでいるが、`_handleLiffApi` の `submit` アクションは `handleLiffSubmitFast`(一括最適化版)を呼んでいる。実際の GitHub Pages 構成では `_handleLiffApi` 経由が使われるため動作上の問題はないが、`liffSubmitResponses` 関数が「使われないが旧版を呼ぶ」状態になっており、将来 `google.script.run` 方式に戻す際に混乱する可能性がある。
- **提案**: `liffSubmitResponses` のコメントに「現在は GitHub Pages + `_handleLiffApi` 経由が実運用。本関数は `google.script.run` 方式に戻す際のために残しているが、最新版は `handleLiffSubmitFast` を使う」と注記する。

#### [パフォーマンス] `clearResponsesByUserId` と `handleLiffSubmitFast` の両方で LockService を取得している

- **場所**: `src/handlers.js:897-947` (`handleLiffSubmitFast`) / `src/sheets.js:954-1000` (`clearResponsesByUserId`)
- **問題**: `handleLiffSubmit` は `clearResponsesByUserId`(Lock 取得あり)→ `upsertResponse`(Lock 取得あり)と 2 回 Lock を取得する設計になっているが、`handleLiffSubmitFast` は自前で 1 回 Lock を取得して全処理を完結させる最適化版になっている。`handleLiffSubmit` 経由のパスは現在未使用のため問題ないが、将来 `handleLiffSubmit` を使う場合は 2 重 Lock(GAS の `ScriptLock` は再入不可)でデッドロックする可能性がある。
- **提案**: `handleLiffSubmit` のコメントに「Lock の二重取得に注意。本関数内では `clearResponsesByUserId` と `upsertResponse` がそれぞれ LockService を取得するため、外側でさらに Lock を取得しないこと」を追記する。

#### [可読性・保守性] `handleLiffGetAllResponses` の `members` 参照が `active` のみに限定されている

- **場所**: `src/handlers.js:993` `var members = getActiveMembers();`
- **問題**: `getActiveMembers()` は `status === 'active'` のメンバーのみを返す。`inactive`(ブロック済み)なメンバーが以前に回答していた場合、`userNameMap` に存在せず `allResponses` の振り分け時に `'(不明)'` として表示される(`handlers.js:1016`)。動作としては破綻していないが、「無効メンバーの過去回答が `(不明)` として表示される」挙動が仕様上意図したものかコメントに記載がない。
- **提案**: コメントに「inactive メンバーの過去回答は `(不明)` として表示される。これは仕様(inactive メンバーの名前を新たに取得しないため)」と明記することで、将来の保守者への意図伝達を確実にする。

---

## 視覚的検証が必要な箇所

以下は静的コードレビューでは判定不能。`ux-reviewer-ja` または手動での実機確認を推奨する。

- `docs/liff.html` のボタン(`btn-answer`)のタップ領域サイズ(最低 44×44px の WCAG 2.5.5 ターゲットサイズ)
- `selected-can`(緑)/`selected-undecided`(グレー)の選択状態が「色 + テキスト」の両方で区別されているかの視覚確認(WCAG 1.4.1 色の使用)
- LINE アプリ内ブラウザ(iOS/Android)での実際のレンダリング確認
- 送信完了後 1500ms で `liff.closeWindow()` が呼ばれ、LINE チャットに戻ることの実機確認(AC-11)

---

## critic-ja 再委譲推奨(該当時のみ)

- **GAS doGet の GET パラメータへの idToken 送信は業界水準でどう評価されるか**: OWASP ASVS(Application Security Verification Standard)Level 1 における「4.2.2 認証トークンを URL に含めない」要件との照合。本プロジェクトの制約(GAS doGet は POST 不可)を前提とした場合の業界的な許容基準について、`critic-ja` の業界比較が有益。
- **`handleLiffSubmitFast` のパフォーマンス業界水準**: GAS のスプレッドシート一括書き込みのベンチマーク(行数 × 処理時間)と、本実装の O(n) 削除(後方ループ `deleteRow`)が実用上限(メンバー 10 名規模)でどの程度のマージンを持つかの業界水準評価。

---

## スコープ外発見

以下は `IMPLEMENTATION_F3.md` で言及されていない既存コード内の発見事項のため、本文の 6 カテゴリ評価には混入させていない。ユーザーの判断に委ねる。

- `src/Code.js:450-468` `debugScraper420` 関数: デバッグ用コードが本番コードに残存。スコープ外(Phase 2 以前の実装)のため採点対象外。将来的に削除を検討する価値あり。
- `src/sheets.js:561-600` `cleanupSchedulesDuplicates`: 手動実行用の初期化関数。本番 Webhook 経由で誤って呼ばれるリスクはないが、GAS エディタから誰でも実行できる状態。Phase 2 実装済みの既存関数のためスコープ外。

---

## 次のアクション

**PASS ✅** の判定です。全 Must 項目(AC-9〜AC-13 / F-3-5 セキュリティ要件 / D-017 制約対応 / D-020 全削除再挿入パターン)を充足しています。

🟡 要改善 3 件(IMPLEMENTATION_F3.md 乖離の記録 / `var data` 二重宣言 / GET パラメータへの idToken 露出のコメント追記)は次の開発サイクルで対応を推奨します。

`critic-ja`(卓越基準・W1-W10 × 100 点採点)へ進む場合は、上記「critic-ja 再委譲推奨」セクションの 2 件を評価軸として渡すことを推奨します。

---

## AI_KB 追記候補

### 追記候補

- [ ] AI_KB 第五部アンチパターンへの追記: 「IMPLEMENTATION.md の設計案(採用前提で書かれた設計)と、実際に実装した方式が乖離したまま放置される Context Confusion リスク」を追記候補とする。本案件では D-017 フォールバック(GAS+LIFF の liff.init ハング → GitHub Pages に切り替え)が発生したにもかかわらず IMPLEMENTATION_F3.md が更新されなかった。設計変更時は IMPLEMENTATION.md + DECISION_NOTES.md の同時更新をワークフローに組み込むことを推奨するパターンとして記録価値あり。

### 客観事実(Lessons Learned ではなく数値のみ)

- 6 カテゴリ結果: 6/6 ✅(致命的 FAIL なし)
- Must 項目充足率: 8/8(AC-9〜AC-13 + F-3-5 セキュリティ + D-017 + D-020)= 100%
- 改善優先度内訳: 🔴 0 件 / 🟡 3 件 / 🟢 4 件
- スコープ外発見: 2 件(本文未混入・分離済)
- 評価サイクル: 1 回目(最大 2 サイクル・A4 基準内)
