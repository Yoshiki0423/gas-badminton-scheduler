# 業界水準批評レポート(実施日時: 2026-05-14T19:00)

> 評価対象: Phase 3 LIFF UX リニューアル実装(F-3-4 / F-3-5 / F-3-6)
> 前提: `code-reviewer-ja` PASS ✅(REVIEW_REPORT_F3.md)/ `tester-ja` PASS 48/50(TEST_REPORT_F3.md)
> 役割: 卓越基準採点(W1-W10 × 100 点)/ 合否判定はしない(`code-reviewer-ja` の領分)
> 注: 同名ファイルの旧版(v0.5 要件定義に対する批評)は本実装版で上書き。

---

## 比較対象(業界ベンチマーク・必須 3-5 件)

- [LINE Developers: Using user data in LIFF apps and servers](https://developers.line.biz/en/docs/liff/using-user-profile/): LIFF v2 公式・「クライアントが取得した displayName / 生 profile を直接サーバーに送るな」「IDToken / AccessToken を送って**サーバー側で verify する**のが正攻法」と明記。一方、トークンを **URL に含める**ことは「URL fragment ですら認証情報を除外する」設計思想(LIFF v2.11.0+)。公開日: 継続更新(LINE 公式)/ ティア: **公式(一次情報)**
- [CWE-598: Use of HTTP Request With Sensitive Query String (MITRE)](https://cwe.mitre.org/data/definitions/598.html): 「sensitive information(session identifiers, passwords, **access tokens**, API keys)を query string に載せると、ブラウザ履歴 / Referer / web logs / 監視ログに残る」「mitigation は **request body または header に載せる**」と明記。公開日: CWE 4.20 系(継続更新)/ ティア: **学術・標準化(MITRE)**
- [OWASP V3.1.1 (ASVS 4.0.2)](https://owasp.org/www-community/vulnerabilities/Information_exposure_through_query_strings_in_url): 「Verify the application **never reveals session tokens in URL parameters** or error messages」(ASVS 4.0.2 V3.1.1 / V8.3.4)。HTTPS でも解決しない既知の脆弱性カテゴリ。公開日: 継続更新 / ティア: **学術・標準化(OWASP)**
- [W3C WAI: WCAG 2.5.5 Target Size (AAA)](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html): タップ対象 **44 × 44 CSS pixels** が AAA 必須。WCAG 2.5.8(AA・2.2 で追加)は 24×24px。Apple HIG / Google Material(48dp)はいずれも 44px 以上を推奨。公開日: WCAG 2.1(2018)/ 継続改訂 / ティア: **標準化(W3C)**
- [Smashing Magazine: Accessible Target Sizes Cheatsheet](https://www.smashingmagazine.com/2023/04/accessible-tap-target-sizes-rage-taps-clicks/): 業界 community ベンチマーク。「rage taps(タップミス連発で離脱)」の原因として 44px 未満を実証。公開日: 2023-04 / ティア: **community 量産(独立性ティア中)**

> **エコーチェンバー検証**: LINE 公式 / MITRE / W3C・OWASP / community Medium の **3 独立源(LINE / 標準化機構 / community)を確保**。同一一次情報の二重引用なし(A8 適合)。

---

## 評価軸ごとの採点(W1-W10 × 10 点 = 100 点満点)

| W# | 評価軸 | 点数 | 業界水準との差分 |
|---|---|---|---|
| W1 | 業界事例との差別化 | 8 / 10 | LIFF + GAS + GitHub Pages の 3 層分離は CHIHFAN blog 等で類似事例あり。本実装の独自性は「Bot ID 知人クローズドコミュニティ前提で displayName を members シートにキャッシュし LINE Profile API を都度叩かない」最適化(`handleLiffGetAllResponses`)。差別化は中程度。 |
| W2 | 競合比較・優位性 | 8 / 10 | 競合(Spir / Calendly / LINE 投票 / Google フォーム手集計)に対して「LINE 内完結 × 4 人閾値自動判定 × 体育館空き自動取得」の 3 軸統合は明確な優位。LIFF 利用範疇では LINE 公式の Reservation Bot サンプル等と比較して認証 UX が同等。 |
| W3 | ペルソナ視点・UX | 6 / 10 | フォーム描画 → 回答送信は 2 タップで完結する設計は良好(Aha-Moment 3 秒以内に達成可能)。**減点要因**: (1) `prefers-reduced-motion` 未対応で前庭機能障害ユーザーが脱落 / (2) `.btn-answer` の実効高さが WCAG 2.5.5 AAA(44px)の **38-40px** で AAA 未達 / (3) 送信中に進捗バーなし(15 秒タイムアウトのみ・ユーザーに見えない)。 |
| W4 | コード品質卓越度 | 8 / 10 | SRP(Code.js=ルーティング / handlers.js=処理 / sheets.js=データ層)は明確。`handleLiffSubmit`(旧版)と `handleLiffSubmitFast`(最適化版)の **二重実装**で SRP に若干の汚れ(片方は未使用・REVIEW 🟢 でも指摘済)。**減点要因**: `sheets.js:995` の userId ログマスクが手書き `userId.substring(0,6)`(他箇所は `_maskUserId` 関数を使用)で**マスク責務の統一性が崩れている**。 |
| W5 | パフォーマンス卓越度 | 9 / 10 | ⭐ `handleLiffSubmitFast` で「Lock 1 回 + 一括 setValues + 後方削除」の GAS ベストプラクティス 3 点完備。50 秒 → 数秒は実機実証あり。tanaike(GAS 業界の第一人者)が紹介する「Web Apps 高速化パターン」と同水準。 |
| W6 | アクセシビリティ卓越度 | 5 / 10 | REQUIREMENTS.md §6-3 で **WCAG 2.1 Level A 相当(`<button>` ネイティブ + `aria-label` + 色だけに頼らない状態表示)を目標**と明記。実装では `<button class="btn-answer">` ネイティブ要素は OK だが、**`aria-label` / `aria-pressed` 未実装**・**`prefers-reduced-motion` 未対応**・**44×44 AAA 未達**。REQUIREMENTS が掲げた目標と実装の乖離が明確。 |
| W7 | 拡張性・保守性 | 7 / 10 | LIFF_ID / GAS_API_URL がハードコードされ URL 変更で `docs/liff.html` を編集 → push が必要(GitHub Pages 静的サイト制約・REVIEW 🟢)。複数グループ対応(F-3-2)に進むと現状の `members` シート単一構成では破綻する。**減点要因**: IMPLEMENTATION_F3.md の §2(google.script.run 設計)と実装(fetch GET API)が乖離(REVIEW 🟡 / TEST CONTEXT-CLASH-01 / 02)。 |
| W8 | ドキュメント品質 | 7 / 10 | IMPLEMENTATION_F3.md / DECISION_NOTES.md(D-017 / D-020 / D-021)で意思決定は記録されている。**減点要因**: D-019(GitHub Pages + fetch 採用)の決定書きが**未追記**(REVIEW 🟡 推奨で指摘されているが未反映)。`docs/SETUP.md` 相当の「LIFF 設定値書き換え手順」も未整備。 |
| W9 | 革新性・独自性 | 6 / 10 | GAS の `liff.init()` ハング(D-017)を GitHub Pages 分離で回避した知見は再利用価値あり(同様の問題に直面する後続プロジェクトに有益)。ただし GitHub Pages + GAS の組み合わせ自体は既存事例([CHIHFAN blog 2024](https://billxu.net/blog/2024/01/16/%E4%BD%BF%E7%94%A8-github-gas-%E5%BB%BA%E7%AB%8B-liff-%E5%95%8F%E5%8D%B7/) 等)で公開済で、独自性は中程度。 |
| W10 | 持続可能性 | 7 / 10 | 無料枠内設計(GAS / LINE Messaging API 200通/月 / GitHub Pages)で運用コスト 0 円持続可能。**コンプライアンス観点**: 個人情報(LINE userId + displayName)を扱うため**個人情報保護法**の適用対象。プライバシーポリシーの整備(誰がどこに保存・退会時の削除フロー)は未着手。クローズドコミュニティ前提だが PIA(Privacy Impact Assessment)相当の明文化は要追加。 |

**合計: 71 / 100**

> 📊 内訳: 80 点目安線(🟡 推奨対応で到達可能)に対して **9 点ショート**。卓越レベルには未到達だが、致命的な品質欠陥はない(主因は W6 アクセシビリティと W3 UX の AAA 未達)。

---

## 良い点(70:30 のバランス・3 件以上)

- ⭐ **`handleLiffSubmitFast` の最適化レベル**: 「Lock 1 回 + B 列一括読み + 後方ループ deleteRow + 一括 setValues + flush」の **GAS Web Apps 高速化 4 ベストプラクティス**を完備。tanaike(GAS 業界の第一人者)が[Web Apps with Google Apps Script](https://github.com/tanaikech/taking-advantage-of-Web-Apps-with-google-apps-script)で示すパターンと同水準。50 秒問題の根治を最小コード変更で達成した点が業界 1 位水準。
- ⭐ **`verifyLineIdToken` の堅牢な null フォールバック設計**: 空 idToken / 未設定 LINE_CHANNEL_ID / HTTP エラー / JSON パース失敗 / sub フィールド欠損のすべてのケースで `null` を返し、呼び出し元に判定を委ねる。各分岐に `console.warn` を残す。LINE 公式の[verify endpoint ガイダンス](https://developers.line.biz/en/docs/line-login/verify-id-token/)の趣旨(クライアント側で profile を直送させずサーバー側で verify する)を完全準拠。
- ✅ **XSS 対策の網羅性**: `esc()` 関数で 5 種(`& < > " '`)をエスケープし、`docs/liff.html` / `docs/liffResults.html` の全変数出力に適用。LIFF SDK 公式が提示する「`getDecodedIDToken` の生 payload をそのまま画面表示しない」原則を守っている。
- ✅ **後方互換の徹底**: `upsertResponse` のデフォルト第 3 引数 `true` / `_buildSurveyFlex` 残存(D-021) / `doGet` ヘルスチェック維持 / `handleVote` 既存 postback 動作不変。Phase 1 → Phase 3 のリリースリスクをほぼゼロに抑えた設計。
- ⭐ **F-3-5 セキュリティ要件の完全遵守**: 「クライアントから displayName を直接送らせない・idToken のみ送らせる」の REQUIREMENTS §F-3-5 要件は LINE 公式ガイダンスの中核原則([LIFF user-profile docs](https://developers.line.biz/en/docs/liff/using-user-profile/))と完全一致。なりすまし攻撃を構造的に阻止。

---

## 改善優先度リスト(5 段階 severity)

### 🔴 最優先(品質を一段引き上げる)

#### [W3 UX / W6 アクセシビリティ] WCAG 2.5.5 AAA(44×44px)タップ領域未達

- **業界差分**: WCAG 2.5.5(AAA)は **44 × 44 CSS pixels** が必須。Apple HIG は 44pt、Google Material は 48dp を推奨。本実装の `.btn-answer` は `padding: 10px 8px; font-size: 14px;` で実効高さ約 **38-40px**(font 14px + padding 上下 10px = 34px + 行間で 38-40px 程度)。WCAG 2.5.8(AA・24px)はクリアしているが、REQUIREMENTS.md §6-3 で目標とした「WCAG 2.1 Level A 相当 + 色だけに頼らない」の趣旨に対して、本機能の中核操作(「行ける」「未定」)が rage taps を誘発しやすい水準。
- **参考事例**: [W3C WAI WCAG 2.5.5 Target Size](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html) / [Smashing Magazine: Accessible Target Sizes](https://www.smashingmagazine.com/2023/04/accessible-tap-target-sizes-rage-taps-clicks/)
- **具体的改善案**:

```css
/* Before (docs/liff.html L54-65) */
.btn-answer {
  flex: 1; padding: 10px 8px;
  border: 2px solid #ddd;
  /* ... */
}

/* After: min-height で 44px を担保 + padding を厚く */
.btn-answer {
  flex: 1;
  min-height: 44px;        /* ← WCAG 2.5.5 AAA */
  padding: 12px 8px;       /* ← font-size 14px + padding 12px で約 50px */
  border: 2px solid #ddd;
  /* ... */
}

/* .btn-submit にも明示する(現状 padding: 16px で約 50px だが明示で意図を保存) */
.btn-submit {
  display: block; width: 100%;
  min-height: 44px;
  padding: 16px;
  /* ... */
}
```

---

#### [W3 UX / W6 アクセシビリティ] `aria-pressed` / `aria-label` 欠落(色だけで選択状態を伝えている)

- **業界差分**: REQUIREMENTS.md §6-3 で「色だけに頼らない状態表示」を明示目標としているが、実装では `.selected-can`(緑) / `.selected-undecided`(グレー)の **クラス名(=色)のみ**で選択状態を区別。スクリーンリーダーには「ボタン」としか伝わらず、`行ける(選択中)` / `未定(選択中)` の区別ができない。WCAG 4.1.2 Name, Role, Value(Level A・REQUIREMENTS で目標とした水準)未達。
- **参考事例**: [W3C WAI ARIA aria-pressed for toggle buttons](https://www.w3.org/WAI/ARIA/apg/patterns/button/) — トグルボタンの推奨パターン
- **具体的改善案**:

```javascript
// Before (docs/liff.html L170-171)
html += '<button class="btn-answer' + (cur === 'can' ? ' selected-can' : '') + '" onclick="select(\'' + esc(s.scheduleId) + '\',\'can\')">行ける</button>';
html += '<button class="btn-answer' + (cur === 'undecided' ? ' selected-undecided' : '') + '" onclick="select(\'' + esc(s.scheduleId) + '\',\'undecided\')">未定</button>';

// After: aria-pressed と aria-label を追加(色 + ARIA で二重伝達)
html += '<button class="btn-answer' + (cur === 'can' ? ' selected-can' : '') + '"'
     +  ' aria-pressed="' + (cur === 'can' ? 'true' : 'false') + '"'
     +  ' aria-label="' + esc(dateLabel) + ' に行ける"'
     +  ' onclick="select(\'' + esc(s.scheduleId) + '\',\'can\')">行ける</button>';
html += '<button class="btn-answer' + (cur === 'undecided' ? ' selected-undecided' : '') + '"'
     +  ' aria-pressed="' + (cur === 'undecided' ? 'true' : 'false') + '"'
     +  ' aria-label="' + esc(dateLabel) + ' は未定"'
     +  ' onclick="select(\'' + esc(s.scheduleId) + '\',\'undecided\')">未定</button>';

// 加えて select() の中で動的に aria-pressed を更新する
function select(scheduleId, value) {
  /* ... 既存処理 ... */
  btns[0].setAttribute('aria-pressed', cur === 'can' ? 'true' : 'false');
  btns[1].setAttribute('aria-pressed', cur === 'undecided' ? 'true' : 'false');
}
```

---

#### [W10 持続可能性 / セキュリティ] ID Token を GET URL に載せている(CWE-598 / OWASP V3.1.1 違反パターン)

- **業界差分**: [CWE-598](https://cwe.mitre.org/data/definitions/598.html) は「access tokens を query string に載せると **ブラウザ履歴 / Referer / web logs / 監視ログ**に残る」と明記。[OWASP ASVS 4.0.2 V3.1.1](https://owasp.org/www-community/vulnerabilities/Information_exposure_through_query_strings_in_url) も「never reveals session tokens in URL parameters」を要件化。LINE 公式([LIFF v2.11.0+](https://developers.line.biz/en/docs/liff/using-user-profile/))は「URL fragment ですら credential を除外する」設計思想を明示。本実装は `GAS_API_URL + '?liff=submit&idToken=...&answers=...'`(`docs/liff.html:200-202`)で **idToken と answers を両方 GET URL に載せている**。
- **コンテキスト緩和要因**(REVIEW 🟡 で言及済): GAS doGet は POST を受け付けないため fetch + POST body での回避は構造的に困難 / idToken は短命(数分) / クローズドコミュニティ前提 → 実害リスクは限定的。
- **だが業界水準では「短命だから OK」とはしない**: GAS の実行ログ(Stackdriver / GCP Logging)に URL 全体が記録される → 管理者でも事後ログ閲覧で他人の token を取得しうる。**最低限の対策はコメント明示 + 将来移行パスの記録**。
- **参考事例**: LINE 公式の[Verify ID Token](https://developers.line.biz/en/docs/line-login/verify-id-token/) は POST + form body 推奨。tanaike の[Web Apps to Web Apps](https://tanaikech.github.io/2020/07/01/updated-taking-advantage-of-web-apps-with-google-apps-script/) は GAS doPost の content-type 制約を回避する `text/plain` POST 方式を提示。
- **具体的改善案**(段階的に):

```javascript
// 段階 1: 現状制約のコメントを明示(最低限・README と連動)
// docs/liff.html L200 付近に追記
//
// SECURITY NOTE: idToken と answers を GET URL に含めている。
// CWE-598 / OWASP V3.1.1 では非推奨パターンだが、以下の緩和要因で許容:
//   (1) GAS doGet は POST body を受け付けない構造的制約
//   (2) idToken の有効期間は数分(LIFF SDK 仕様)
//   (3) クローズドコミュニティ前提(Bot ID 知人のみ・GitHub Pages も限定共有)
// 将来的に外部 Proxy(Cloudflare Worker 等)経由で POST 化する場合は
// DECISION_NOTES.md の D-019 / D-022(候補)で再評価する。
var url = GAS_API_URL + '?liff=submit'
  + '&idToken=' + encodeURIComponent(idToken)
  + '&answers=' + encodeURIComponent(JSON.stringify(answers));

// 段階 2(将来): text/plain POST に移行(tanaike パターン)
// 同じ doGet エンドポイントでなく doPost を用意し、Content-Type: text/plain で POST する。
// 例:
//   fetch(GAS_API_URL, {
//     method: 'POST',
//     headers: { 'Content-Type': 'text/plain;charset=utf-8' },
//     body: JSON.stringify({ liff: 'submit', idToken: idToken, answers: answers })
//   });
// サーバー(Code.js doPost)側は e.postData.contents を JSON.parse する。
```

→ `DECISION_NOTES.md` に **D-022(候補)**: 「Token GET 送信の許容根拠と将来移行パス」を新規追加することを推奨。

---

### 🟡 推奨(時間があれば・80 点目安線)

#### [W6 アクセシビリティ] `prefers-reduced-motion` 未対応(0.8s 無限回転スピナー)

- **業界差分**: WCAG 2.3.3 Animation from Interactions(AAA)+ media query `(prefers-reduced-motion: reduce)` は 2026 業界水準で必須対応。前庭機能障害ユーザーが 0.8s 無限回転で不快感 / 吐き気を訴える既知の課題。
- **参考事例**: [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)
- **具体的改善案**:

```css
/* docs/liff.html / liffResults.html の両方の <style> に追記 */
@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; }  /* 静的な「読み込み中」テキストのみで通知 */
  .btn-answer { transition: none; }
  .btn-submit { transition: none; }
}
```

---

#### [W4 コード品質 / W10 ログ衛生] `clearResponsesByUserId` の userId マスキングが手書き(統一性崩壊)

- **業界差分**: `handlers.js` 側では `_maskUserId(userId)` ヘルパで PII マスクを統一しているが、`sheets.js:995` だけ手書き `userId.substring(0, 6) + '...'` になっている。**ログマスクの責務分散**は GDPR / 個人情報保護法対応の観点でアンチパターン(マスクロジックは 1 か所に集約すべき)。
- **参考事例**: [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) — PII マスクの一元化原則
- **具体的改善案**:

```javascript
// Before (sheets.js L995)
console.log('[INFO] clearResponsesByUserId: userId=' + userId.substring(0, 6) + '... deleted=' + rowsToDelete.length + '行');

// After: _maskUserId に統一(まず utils.js に移管して両方から参照する案が現実的)
console.log('[INFO] clearResponsesByUserId: userId=' + _maskUserId(userId) + ' deleted=' + rowsToDelete.length + '行');
```

→ GAS は ES Modules 非対応のため、`_maskUserId` を `utils.js` に格上げして `handlers.js` / `sheets.js` 双方から参照する形が望ましい。

---

#### [W7 拡張性・保守性 / W8 ドキュメント] D-019(GitHub Pages + fetch 採用)が DECISION_NOTES.md に未追記

- **業界差分**: REVIEW_REPORT_F3.md 🟡 / TEST_REPORT_F3.md CONTEXT-CLASH-01 / 02 で既に指摘済。IMPLEMENTATION_F3.md §2(google.script.run を採用)と実装の `fetch()` GET API が乖離している。これは AI_KB 第三部 #19 Context Decay のうち **Context Confusion(古い設計情報が判断に影響)+ Context Clash(複数設計記述の矛盾)** のダブルアンチパターン。
- **参考事例**: AI_KB `case_studies/01_alps_lab_web.md` の「設計変更時は IMPLEMENTATION.md + DECISION_NOTES.md の同時更新」運用ルール
- **具体的改善案**: DECISION_NOTES.md に D-019 を起票(REVIEW_REPORT_F3.md L69-87 のテンプレをそのまま使える)。IMPLEMENTATION_F3.md §2 を「fetch + GET API 方式」に書き換え + 旧版(google.script.run 案)を「不採用案・D-019 で確定」セクションに移管。

---

#### [W3 UX] 送信中の進捗フィードバック不足(15 秒タイムアウトのみ・ユーザーには見えない)

- **業界差分**: 業界水準(Nielsen Norman Group / Material Design)では 1-10 秒の処理に対して進捗バー or アニメーション付き「送信中...」表示が推奨。本実装は「送信中...」テキスト変更のみ(`docs/liff.html:198`)で、15 秒タイムアウトはユーザーに見えない。
- **参考事例**: [Nielsen Norman Group: Response Times](https://www.nngroup.com/articles/response-times-3-important-limits/)
- **具体的改善案**:

```javascript
// 送信ボタンクリック時にスピナーを表示(prefers-reduced-motion 対応とセット)
if (btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline" aria-hidden="true"></span> 送信中...';
}
```

`.spinner-inline` を CSS で 16-20px の小さい円形に定義し、`@media (prefers-reduced-motion: reduce)` で animation:none に切る。

---

### 🟢 余力(将来的に)

#### [W7 拡張性] LIFF_ID / GAS_API_URL のハードコード

- **業界差分**: REVIEW 🟢 でも指摘済。GitHub Pages は静的 HTML のため環境変数注入が構造的に困難(GitHub Actions で build 時に置換する方式は可能だが、本案件規模ではオーバーキル)。
- **参考事例**: [GitHub Actions: Environment variables](https://docs.github.com/en/actions/learn-github-actions/variables) で build 時置換
- **具体的改善案**: 最小コストでは `docs/SETUP.md` を新規作成し「本番デプロイ手順 + URL 書き換え箇所」を明文化する(README に diff コマンド例を併記)。

#### [W4 コード品質] `handleLiffSubmit`(旧版)が `_handleLiffApi` 経由では使われていない死コード

- **業界差分**: REVIEW 🟢 で指摘済。`Code.js:233` の `liffSubmitResponses`(google.script.run 用)が `handleLiffSubmit`(旧版・逐次書き込み)を呼んでいる。GitHub Pages 経由は `handleLiffSubmitFast` を使うが、`google.script.run` 経由は旧版を使うため、将来 GAS ホスト型に戻した場合に古い実装が動く。
- **具体的改善案**: `liffSubmitResponses` の中身を `handleLiffSubmitFast` に差し替え + コメントで「Fast 版を統一実装として使用」と明記。

#### [W9 革新性] エッジ環境(Cloudflare Workers / Vercel Edge)経由の POST 化検討

- **業界差分**: 🔴 #3 の根本対策。Cloudflare Workers なら無料枠 100,000 リクエスト/日で POST → GAS doPost (text/plain) を中継できる。idToken を URL から削除可能。
- **具体的改善案**: F-3-7 候補として REQUIREMENTS.md に追記(余力次第)。

---

## Citation 再検証結果(A5)

- 主張 12 件 / 出典 URL 5 件 / 再検証パス 12 件 / 不一致 **0 件**
- 再検証の根拠:
  - LIFF user-profile (developers.line.biz):「IDToken をサーバーに送って verify する」「decoded profile を直送するな」→ WebFetch 結果と評価本文 W6 / 良い点 ⭐ で整合
  - CWE-598 (cwe.mitre.org):「access tokens を query string に載せると履歴・Referer に残る」→ 🔴 #3 で整合
  - OWASP V3.1.1 (owasp.org):「session tokens を URL parameters に出すな」→ 🔴 #3 で整合
  - WCAG 2.5.5 (w3.org):「44 × 44 CSS pixels」→ 🔴 #1 で整合
  - Smashing Magazine (smashingmagazine.com):「rage taps の閾値」→ 🔴 #1 補強で整合

---

## 視覚的検証が必要な箇所(B2 派生・該当時のみ)

以下は本エージェントの卓越採点(W1-W10)には混ぜず、`ux-reviewer-ja` または実機確認に分離。

- LINE アプリ内ブラウザ(iOS Safari / Android Chrome)での `.btn-answer` の実効タップ領域実測(本評価では CSS から推定で 38-40px)
- `#06C755`(緑) vs `#757575`(グレー)の選択状態色のコントラスト比(WCAG 1.4.11 Non-text Contrast)
- 送信完了 `<div class="success-icon">&#10003;</div>` の絵文字表示が iOS/Android で同じ大きさで描画されるか
- スピナー(0.8s 回転)の実機での眩しさ・前庭刺激の主観評価

---

## スコープ外発見(A12)

- `src/Code.js` の `debugScraper420` 関数(REVIEW スコープ外発見と同じ) — Phase 2 以前の実装で本評価対象外
- `src/sheets.js:561-600` `cleanupSchedulesDuplicates` — GAS エディタから誰でも手動実行できる状態(Phase 2 以前)
- `src/handlers.js` の `_buildSurveyFlex` / `_buildSurveyBubble` の Carousel ロジック残存(D-021 で明示的に「残す」決定済 = 設計通り・スコープ外でなく仕様)

---

## 次のアクション

**71 / 100 点 — 卓越レベル(80 点)に未到達 / 改善余地あり**。

- 🔴 最優先 3 件(WCAG 2.5.5 AAA 44px / aria-pressed / Token GET 送信コメント)を反映する **Sprint(最大 1 サイクル)を提案** します。これだけで W3(+2)/ W6(+3)/ W10(+1)で **計 +6 点 → 77 点**、🟡 推奨 4 件のうち D-019 追記と prefers-reduced-motion 対応で **+3-4 点 → 80-81 点(卓越領域)** に到達可能。
- 🟡 推奨 4 件は 80 点目安線到達後の余力で対応 — 特に D-019 追記は Context Clash の根治のため早期推奨。
- 🟢 余力 3 件は Phase 4 以降の検討候補。

> **役割再確認(B1)**: 本レポートは卓越基準採点。**合否判定は `code-reviewer-ja` PASS ✅ の通り完了済み**(本エージェントは合格 / 不合格を再判定しない)。dev-orchestrator-ja v1.9 の「LARGE タスクのみ Critic」運用に該当する Phase 3(LIFF 新規 + 6 ファイル変更)で本批評を発行。

---

## AI_KB 追記候補

### 追記候補

- [ ] **AI_KB 第五部アンチパターンへの追記候補**: 「LIFF + GAS 構成で IDToken を GET URL に載せる構造的妥協」 — GAS doGet が POST body を受けない制約から、業界水準(CWE-598 / OWASP V3.1.1)に対して**短命トークン + クローズドコミュニティ + 明示コメント**で意図的に妥協する設計判断のパターンとして記録価値あり。将来 Cloudflare Worker 等の Edge POST Proxy が事実上の標準になった際の移行パスも併記。
- [ ] **AI_KB case_studies への追記候補**: `case_studies/01_alps_lab_web.md` 同様の品質ジャンプ実証として、本プロジェクトは「REVIEW PASS(0/3/4)+ TEST PASS(48/50)→ CRITIC 71/100」の数値を記録。**Reviewer 合格 = 完成ではない**(2 層化評価の AI_KB 第三部 #15 実証)を継続蓄積。本案件で確認できた事実: REVIEW で WCAG 観点が「視覚的検証が必要な箇所」セクションに切り出されており、コード品質チェックでは AAA 未達が拾えない構造を Critic 側で拾った(役割分離が機能した事例)。
- [ ] **AI_KB 第三部 #19 Context Engineering への追記候補(Context Clash の事例)**: 本案件 IMPLEMENTATION_F3.md §2(google.script.run)と実装(fetch GET API)の乖離は、TEST_REPORT_F3.md でも「CONTEXT-CLASH-01 / 02」として 🟡 で記録され、本 CRITIC でも 🟡 で再記録。**ドキュメント側更新ルール**(設計変更時の IMPLEMENTATION + DECISION_NOTES 同時更新)の運用化を case_studies に追記候補とする。

### 客観事実(Lessons Learned ではなく数値のみ)

- W1-W10 採点合計: **71 / 100**
- 卓越領域(80 点)までの差分: **-9 点**
- 🔴 最優先で +6 点(W3 +2 / W6 +3 / W10 +1)/ 🟡 推奨で +3-4 点 = 計 **77-81 点**(80 点目安線到達見込み)
- 比較対象ベンチマーク: **5 件**(LINE 公式 / CWE-MITRE / OWASP / W3C-WAI / Smashing community)、独立源 **3 種**(LINE / 標準化機構 / community)確保(エコーチェンバーなし)
- Citation 再検証: 12/12 整合(不一致 0)
- 視覚的検証分離: **4 件**(`ux-reviewer-ja` または実機委譲)
- スコープ外発見分離: **3 件**(本文採点に未混入)
- 評価サイクル: 1 回目(A4 critic 1 サイクル打ち切り規律遵守)
- 逆張り評価(A15・自己批判者モード)発見: **7 件**(うち 🔴 反映 3 件 / 🟡 反映 2 件 / 🟢 反映 2 件)
