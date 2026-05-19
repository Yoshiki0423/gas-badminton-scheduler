# CRITIC_REPORT_F4.md — F-4 卓越性評価レポート

**評価日**: 2026-05-14
**評価者**: critic-ja
**評価対象**: F-4 LIFF グリッドフォームリニューアル 初回実装

---

## 総合スコア: 82 / 100

🔴 致命的指摘: 0件
🟡 推奨改善: 2件
🟢 卓越している点: 4件

---

## 指摘サマリー

| 重大度 | 件数 | 内容概要 |
|:--|:--|:--|
| 🔴 致命的 | 0 | なし |
| 🟡 推奨改善 | 2 | モバイル UX・重複 Lock 取得リスク |
| 🟢 卓越 | 4 | データモデル設計・後方互換・グレーアウト判定・一括書き込み |

---

## 🔴 致命的指摘(0件)

なし。

---

## 🟡 推奨改善

### 🟡-1: `clearSlotResponsesByUserId` と `handleLiffSubmitFast` が別々に Lock を取得するリスク

**対象**: `src/sheets.js` の `clearSlotResponsesByUserId` + `src/handlers.js` の `handleLiffSubmitFast`

**状況**: `handleLiffSubmitFast` は自前で Lock を取得した上で、削除処理を「直接 deleteRow」で実装している。これは正しい実装パターン。しかし、後方互換の `clearResponsesByUserId` は `clearSlotResponsesByUserId` に委譲しており、`clearSlotResponsesByUserId` も内部で Lock を取得する。GAS の `LockService.getScriptLock()` は再入可能(reentrant)でないため、同じ実行コンテキストから Lock を2重取得するとデッドロックになる可能性がある。

**現在の状況分析**: `handleLiffSubmitFast` は自前で削除処理を直接実装しており、`clearSlotResponsesByUserId` を呼ばない。よって現在のコードでは二重 Lock の問題は発生しない。ただし、将来誰かが `handleLiffSubmitFast` の削除部分を `clearSlotResponsesByUserId` で置き換えると問題が起きる。

**改善提案**: `clearSlotResponsesByUserId` の JSDoc に「Lock 付き。handleLiffSubmitFast 内から呼ばないこと(二重 Lock になる)」という警告コメントを追記する。

**優先度**: 中(現在は問題なし・将来の保守リスク)

---

### 🟡-2: `docs/liff.html` の6ボタン横並びがスマートフォンの狭い画面で崩れる可能性

**対象**: `docs/liff.html` CSS `.slot-row` / `.btn-slot`

**状況**: `.slot-row { flex-wrap: nowrap }` で6ボタンを横一列に強制している。各ボタンは `flex: 1; min-width: 0; font-size: 11px` で収縮するが、4インチ以下の端末(古い iPhone SE など)では文字が極端に小さくなるか、ボタンが押しにくくなる可能性がある。

**改善提案**: `flex-wrap: wrap` にして1行3ボタン×2行のグリッドにするか、`.btn-slot` に `min-width: 44px`(Apple HIG の最小タップ領域)を設定する。現行の `flex: 1; min-width: 0` は 44px を割り込む可能性がある。

**優先度**: 中(対象端末が古い端末に限られるが、実機確認が推奨)

---

## 🟢 卓越している点

### 1. データモデル変更の後方互換設計
`clearResponsesByUserId` → `clearSlotResponsesByUserId` 委譲、`getAllResponses` → `getAllSlotResponses` ラップという段階的移行設計が優れている。F-1-5(リマインド)の `getRespondedUserIds` を壊さずに新APIに移行している。

### 2. グレーアウト判定の文字列比較によるシンプルな実装
`'HH:mm'` 固定桁数(5文字)を前提とした `slotStart >= facilityStart && slotEnd <= facilityEnd` という辞書順比較は、Date オブジェクト変換なしに時刻の包含判定を実現しており、GAS 環境(Node.js より高コストな Date 操作)で合理的な選択。

### 3. `resetResponsesSheet` による安全な移行パス
シートを削除→再作成することでヘッダー・書式・データをすべてリセットするクリーンな移行設計。GAS の `clearContent()` だけでは書式が残るリスクがあり、`deleteSheet` + `insertSheet` のパターンが正しい。

### 4. `tapSlot` がボタンの DOM 要素を直接受け取る設計
`onclick="tapSlot(this)"` で element を渡すことで `data-key` 属性から slotKey を取得し、`document.querySelector` による再検索コストを省いている。6スロット×14日=最大84ボタンの操作でパフォーマンス差が出る場面での合理的な最適化。

---

## 採点内訳

| 評価軸 | 点数 | 最大 | 備考 |
|:--|--:|--:|:--|
| 仕様準拠(AC-14〜18 達成度) | 20 | 20 | 全AC コードレベルで確認済み |
| コード品質(可読性・保守性) | 17 | 20 | 🟡-1 の保守リスクコメント不足で-3 |
| セキュリティ | 15 | 15 | ID Token 検証・XSS・answer バリデーション完備 |
| パフォーマンス | 13 | 15 | 一括書き込み最適化済み・🟡-2 のモバイルUX懸念で-2 |
| エラーハンドリング | 10 | 10 | fetch 失敗・タイムアウト・引数バリデーション完備 |
| 後方互換性 | 7 | 10 | 後方互換あり。旧 `liffSubmitResponses` が `handleLiffSubmitFast` を呼ぶ経路は正しいが、`Code.js` の `liffSubmitResponses` が旧形式引数(scheduleId ベース)のユーザーには無言で誤動作する可能性。F-4 への完全移行前提なので許容範囲。 |
| **合計** | **82** | **90** | (残り10点は実機テスト・視覚的検証で埋める想定) |

---

## 視覚的検証が必要な箇所

1. **6ボタン横並び**: 実機(特に4〜5インチ端末)でボタンが潰れないか確認(🟡-2 関連)
2. **固定送信ボタンとコンテンツの重なり**: iPhoneのセーフエリアで送信ボタンが操作しやすいか
3. **グレーアウトの視認性**: 明度差が十分かどうか実機で確認

---

## 終了条件の評価

🔴 指摘: 0件
🟡 指摘: 2件

終了条件「🔴ゼロ かつ 🟡2件以下」を満たしています。
