# REVIEW_REPORT_F4.md — F-4 コードレビュー

**レビュー実施日**: 2026-05-14
**レビュー対象**: F-4 実装(sheets.js / handlers.js / Code.js / docs/liff.html / docs/liffResults.html)
**レビュアー**: code-reviewer-ja

---

## 総合判定: PASS ✅

致命的指摘(🔴) なし。推奨改善(🟡) 3件。良い点(🟢) 4件。

---

## 指摘サマリー

| 重大度 | 件数 |
|:--|:--|
| 🔴 致命的(修正必須) | 0 |
| 🟡 推奨改善 | 3 |
| 🟢 良い点 | 4 |

---

## 🟢 良い点

### 1. 後方互換の設計が丁寧
`clearResponsesByUserId` を `clearSlotResponsesByUserId` に委譲し、`getAllResponses` が旧形式のマッピングを提供している。F-1-5(リマインド)や F-1-6(集計)の既存コードを壊さない設計になっている。

### 2. `handleLiffSubmitFast` の高速化パターンを踏襲
一括取得→行番号収集→後ろから deleteRow→`setValues` 一括挿入のパターンを維持。API 呼び出し回数を最小化している。

### 3. グレーアウト判定の明確な仕様化
`_isSlotAvailable` が「スロット全体が施設開放時間に完全に含まれる」という厳格な包含判定を実装。「途中から入れる」による混乱を防ぐ F-4-5 不変制約に準拠している。

### 4. docs/liff.html の XSS 対策
innerHTML に挿入するすべての動的値を `esc()` でサニタイズしている。`onclick="tapSlot(this)"` で data 属性からキーを取得する設計も XSS リスクを下げている。

---

## 🟡 推奨改善

### 1. `handleLiffGetAllResponses` が `handleLiffGetData('')` を空 userId で呼んでいる
**対象**: `src/handlers.js` L1051
**現状**: `handleLiffGetData('')` を呼ぶことで `getSlotResponsesByUserId('')` が `{}` を返す。動作は正しいが、設計上の意図が分かりにくい。
**改善案**: `_buildDateGrid()` などの内部関数に日付グリッド生成ロジックを抽出し、`handleLiffGetData` と `handleLiffGetAllResponses` の両方から呼ぶようにリファクタリングすると可読性が上がる。
**優先度**: 低(動作に問題なし・将来のリファクタリング候補)

### 2. `_buildFacilityInfo` の施設情報フォーマットで、日本語の時間帯表示(H〜H)に全角数字を使っていない
**対象**: `src/handlers.js` L938-940
**現状**: `startH + '〜' + endH` で `13〜21` のような表示になる。要件仕様の例示と一致しているが、1桁の場合(例: 9〜11)は `9〜11` となり2桁と混在する。
**改善案**: この挙動は仕様通り(REQUIREMENTS.md §F-4-1 の例示が「13〜21」「終日」形式)のため、現状を記録するだけで良い。TBD-17 で3施設以上の場合の折り返し・省略ルールが決まった際に再検討。
**優先度**: 低(仕様通りの動作)

### 3. `docs/liff.html` の `.content` に `padding-bottom: 100px` が設定されているが、送信ボタン(fixed)の高さが変わった場合に追従しない
**対象**: `docs/liff.html` CSS
**現状**: `padding-bottom: 100px` がハードコードされており、固定ボタンエリア(約80px)との差分が手動管理になっている。
**改善案**: CSS 変数や動的な padding 計算(JS で高さを測定して設定)を検討。スマートフォンのセーフエリア(iPhone のホームバー等)への対応として `padding-bottom: max(100px, env(safe-area-inset-bottom) + 80px)` の使用も候補。
**優先度**: 低(現状で実用上問題なし)

---

## カテゴリ別評価

| カテゴリ | 評価 | 備考 |
|:--|:--|:--|
| 1. 正確性・仕様準拠 | 合格 | AC-14〜18 すべてコードレベルで確認済み |
| 2. セキュリティ | 合格 | ID Token 検証・XSS 対策・answer 値バリデーション |
| 3. パフォーマンス | 合格 | 一括書き込み・Lock 使用・API 呼び出し最小化 |
| 4. 保守性・可読性 | 合格(一部改善余地あり) | 🟡-1 参照 |
| 5. エラーハンドリング | 合格 | 引数バリデーション・fetch エラー・タイムアウト対応 |
| 6. テスト容易性 | 合格 | 各関数の責務が明確で単体テスト可能な構造 |

---

## セルフリファイン点数: 45 / 50

差し引き項目:
- -3: 実機レビュー不可(GAS デプロイ環境での実際の動作確認なし)
- -2: 🟡-1 の設計改善余地あり
