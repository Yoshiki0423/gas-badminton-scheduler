# 業界水準批評レポート（CRITIC_REPORT_FINAL）

実施日時: 2026-05-16 / 評価対象: gas-badminton-scheduler 全機能（Phase 1〜3 完成版）

---

## 1. 総合スコア・一言評価

### 合計: 84 / 100 点 — 業界水準を超える「個人開発の手本」

「友人 4〜10 名規模のクローズドコミュニティ向け個人開発」というスコープで見ると、**コード品質・セキュリティ・ドキュメントの三位一体が個人開発水準を明確に超えている**。一方で「自動テスト不在」「Phase 3 で技術的負債（後方互換コード）が増えてきた」という 2 点が、業界水準（≥85 点）に届かなかった主因。

---

## 2. W1〜W10 採点

| W# | 評価軸 | 点数 | 採点根拠 |
|:--|:--|:--:|:--|
| W1 | コード品質・保守性 | 9/10 | JSDoc が公式 JSDoc 3 規格に完全準拠（全関数で `@param`/`@returns`/`@private`/`@deprecated` を使用）。命名規則・列インデックス定数化・IIFE によるクロージャバグ回避まで配慮。減点 1 点は `handlers.js` が 1425 行に肥大化し、deprecated 関数 5 個以上が残存している点。 |
| W2 | アーキテクチャ設計 | 9/10 | レイヤー分離が教科書水準: `Code.js`(ルーター) / `handlers.js`(ビジネスロジック) / `lineApi.js`(API ラッパー) / `sheets.js`(永続層) / `scraper.js`(外部取得) / `utils.js`(共通)。減点 1 点は F-4 データモデル変更時に旧 `RESPONSES_HEADER` が残り、新旧 2 系統の定数が併存している点。 |
| W3 | セキュリティ | 8/10 | `timingSafeEqual` で timing-safe 比較を独自実装（個人開発で稀な多層防御）。WEBHOOK_URL_TOKEN + HMAC-SHA256 の二段防御も採用。減点 2 点: (a) LIFF_ID と GAS API URL がクライアント側 HTML にハードコード / (b) 署名を HTTP ヘッダーではなく query パラメータで受け取っている（GAS 制約上やむを得ない妥協）。 |
| W4 | エラーハンドリング・信頼性 | 9/10 | `withRetry` で指数バックオフ + 30% jitter まで実装。Webhook は必ず 200 を返す。構造化 JSON ログ。スクレイピング連続 3 日失敗で管理者通知。減点 1 点は dead letter queue / リトライ全失敗後の手動復旧フローが未整備な点。 |
| W5 | UX（LINE Bot / LIFF フォーム） | 8/10 | グリッドフォームの「タップで ○ → △ → 空欄サイクル」は類似ツールにない独自 UX。`prefers-reduced-motion` / WCAG 2.5.5 AAA タップターゲット / `aria-pressed="mixed"` も配慮。減点 2 点: (a) 送信後 1.5 秒で強制クローズが速すぎる / (b) 4 人即通知が回答送信の同期処理に組み込まれ UX レスポンスが伸びる。 |
| W6 | テスト・品質保証 | 6/10 | **本プロジェクト最大の業界差分**。手動テストレポートは毎フェーズ作成しているが、自動テストが 0 件。`scraper.js` のパース系関数・月またぎロジック・スロット判定は複雑な正規表現と条件分岐を含み、自動テストなしでのリグレッションリスクが高い（実際 D-018 で月またぎバグが事後発覚）。 |
| W7 | ドキュメント品質 | 10/10 | **業界 1 位水準**。REQUIREMENTS / DECISION_NOTES / GLOSSARY / PHASE_0_SETUP / IMPLEMENTATION / REVIEW / CRITIC の 5 軸ドキュメントが揃い、「なぜ（DECISION_NOTES）」と「何を（REQUIREMENTS）」が完全分離。新規参入者のオンボーディング所要時間は 1〜2 時間と推定（業界水準は半日〜1 日）。 |
| W8 | 運用性・デプロイ容易性 | 8/10 | clasp + `.claspignore` + `appsscript.json` の標準構成。setup 系関数も整備済み。減点 2 点: (a) CI/CD 不在（push 漏れリスク）/ (b) GitHub Pages 配信の liff.html と GAS デプロイ ID 同期手順がチェックリスト化されていない。 |
| W9 | スケーラビリティ・拡張性 | 7/10 | 4〜10 名スコープでは十分。課題: (a) `_findRowByUserId` が線形探索 O(N) / (b) `VIABLE_NOTIFIED_SLOT_*` が蓄積しリーク可能性 / (c) 施設追加が `FACILITIES` 配列ハードコードでコード改修必須。 |
| W10 | プロジェクト全体の完成度 | 10/10 | Phase 0〜3 の段階的価値提供を完遂。各 Phase で REQUIREMENTS → IMPLEMENTATION → TEST → REVIEW → CRITIC の 5 工程を回し切り、**小規模 SaaS 開発水準のプロジェクト管理プロセスに到達**。 |

---

## 3. 特に優れている点（TOP 3）

### ⭐ 1: timing-safe 比較を独自実装した Webhook 多重防御
`utils.js` の `timingSafeEqual` は LINE 公式が推奨する constant-time 比較をネイティブ JavaScript で再実装。`WEBHOOK_URL_TOKEN`（第一防衛線）と `LINE_CHANNEL_SECRET`（HMAC-SHA256 第二防衛線）の二段構成。個人開発でここまでセキュリティを多層化する例は稀で、小規模 SaaS 本番環境と同等の水準。

### ⭐ 2: 「タップサイクル ○→△→空欄」 UI（独自発明）
`liff.html` のサイクル UI は Spir / Calendly / LINE 投票のいずれにも存在しない独自 UX。日付 × 6 スロット = 最大 84 ボタンが 1 画面に収まり、3 状態のトグルで「行ける / 未定 / 行けない」を表現。`aria-pressed="mixed"` で「未定」状態も a11y で正しく表現しており、本ツールの差別化コア。

### ⭐ 3: 5 軸ドキュメント体制（業界 1 位水準）
REQUIREMENTS / DECISION_NOTES（D-001〜D-022）/ GLOSSARY / PHASE_0_SETUP / フェーズ別 IMPLEMENTATION の 5 軸が揃い、OSS 中堅プロジェクト水準のドキュメント整備を個人開発で実現。「なぜこの設計か」が D-XXX として全て残っており、半年後の自分でもすぐ追跡できる。

---

## 4. 改善を推奨する点（優先度付き・TOP 5）

### 🔴 最優先-1: 重要モジュールの自動テスト導入
- **問題**: 複雑なパース/集計ロジックに自動テストが 0 件。月またぎバグが事後発覚した経緯（D-018）で構造的リスクが実証済み。
- **対象**: `scraper.js` の `_extractTimesFromCell` / `parseScraperSheetValues` / `_isSlotAvailable` / `_checkAndNotifyNewMonths`
- **方法**: ローカル Jest で実行（`tests/` フォルダを `.claspignore` 対象に追加）。カバレッジ目標 60%。

### 🔴 最優先-2: F-5 グループ移行のカバレッジ漏れリスク検証
- **問題**: グループ通知 + 個別リマインドの二段構成では「グループに参加していないが active のメンバー」が通知から漏れる構造的リスクがある。
- **改善案**: `/状況` コマンドで「グループ未参加の active メンバー」を検出して管理者に警告表示する機能を追加。

### 🔴 最優先-3: deprecated コード一掃 Sprint
- **問題**: `handlers.js` に deprecated 関数が 5 個以上（`handleVote` / `_buildSurveyFlex` / `_buildSurveyBubble` / `handleLiffSubmit` 等）、`sheets.js` に旧形式の RESPONSES 系関数が残存。コード行数 1425 行の約 20% が非アクティブ。
- **目標**: Phase 4 冒頭で一掃 Sprint を 1 サイクル実施。コード行数 1100 行程度を目標。

### 🟡 推奨-1: クライアント側 LIFF_ID / GAS API URL の環境変数化
- **問題**: `liff.html` に API URL がハードコードされており、公開リポジトリ運用時の情報漏洩リスクがある（現状は private リポジトリのため実害は低い）。
- **改善案**: `docs/liff.config.js` を `.gitignore` 対象として管理し、そこから読み込む構成に変更。

### 🟡 推奨-2: 4 人即通知の非同期化
- **問題**: `_checkAndNotifyViableSlots` が LIFF 回答送信の同期処理に組み込まれており、LINE API 呼び出しが挟まることで回答 UX のレスポンス時間が伸びる可能性がある。
- **改善案**: ScriptProperties に「要チェック」フラグを立てて毎朝の `checkAndScrapeIfUpdated` で処理する非同期化、または GAS の time-based trigger を使った遅延実行。

---

## 5. 次フェーズへの提言

### Phase 4 推奨タスク（優先順）

1. **自動テスト導入**（1〜2 週・`scraper.js` パース系 4 関数を最優先）
2. **グループ未参加検出**（数日・F-5 カバレッジ漏れを埋める）
3. **deprecated 一掃 Sprint**（1 週・コード行数 -300 行）
4. **環境変数化**（数時間・公開リポジトリ化を視野に入れる場合は最優先昇格）
5. **4 人即通知の非同期化**（実機テストでレスポンス遅延が体感された場合のみ）

### 「完成」を名乗ってよい段階
友人 4〜10 名スコープで 84 点・卓越レベル・4 人実機テスト待ちという段階。**自動テスト未導入のまま運用を始め、バグが出たらその修正と同時にテストを書き足す（TDD 後付け方式）**でも個人開発スコープなら十分。過剰品質を追わず、実運用で得た知見をナレッジ化することの方が長期的価値が高い。

---

## 業界ベンチマーク（参照出典）

- [LINE Developers — Verify ID token](https://developers.line.biz/en/docs/line-login/verify-id-token/)
- [LINE Developers — Verify webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [Class LockService | Google Apps Script](https://developers.google.com/apps-script/reference/lock/lock-service)
- [Google JavaScript Style Guide](https://google.github.io/styleguide/jsguide.html)
- [JavaScript Documentation Standards (JSDoc 3) | WordPress](https://developer.wordpress.org/coding-standards/inline-documentation-standards/javascript/)
