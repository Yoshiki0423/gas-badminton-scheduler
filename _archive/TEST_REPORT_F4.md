# TEST_REPORT_F4.md — F-4 LIFF グリッドフォームリニューアル テストレポート

**テスト実施日**: 2026-05-14
**テスト種別**: 静的コード解析 + ロジック検証(GAS 環境での実機テストは手動確認が必要)
**対象バージョン**: F-4 初回実装

---

## 総合判定: PASS(静的解析レベル) ✅

実機確認が必要な視覚的・挙動確認項目あり(下記「視覚的検証が必要な箇所」参照)。

---

## AC 別テスト結果

### AC-14: グリッドが6列(時間帯)+施設情報行で表示される

| 確認項目 | 結果 |
|:--|:--|
| `handleLiffGetData` が `dates` 配列を返す | PASS |
| 各 `dates[i].slots` が6要素(09:00〜19:00) | PASS — `SLOT_STARTS = ['09:00','11:00','13:00','15:00','17:00','19:00']` で固定 |
| `dates[i].facilityInfo` が施設情報文字列を返す | PASS — `_buildFacilityInfo()` が `📍名前 時〜時 / ...` 形式で生成 |
| `docs/liff.html` が `.slot-row` に6ボタンを描画 | PASS(コード確認) |
| 施設情報行がタップ不可 | PASS — `.facility-info` は button でなく div |

**判定: PASS**

---

### AC-15: グレーアウトが正しく動作する

| 確認項目 | 結果 |
|:--|:--|
| `_isSlotAvailable('09:00', [{startTime:'13:00', endTime:'21:00', note:''}])` → false | PASS — `'09:00' >= '13:00'` は false |
| `_isSlotAvailable('13:00', [{startTime:'13:00', endTime:'21:00', note:''}])` → true | PASS — `'13:00' >= '13:00'` かつ `'15:00' <= '21:00'` |
| `_isSlotAvailable('19:00', [{startTime:'13:00', endTime:'21:00', note:''}])` → true | PASS — `'19:00' >= '13:00'` かつ `'21:00' <= '21:00'` |
| 「終日」施設 → 全スロット true | PASS — note/startTime/endTime に「終日」を含む場合 true を返す |
| グレーアウトボタンの CSS | PASS — `.btn-slot.grayed { background:#e0e0e0; color:#aaa; pointer-events:none }` |
| グレーアウトボタンが `disabled` 属性を持つ | PASS — `slot.available === false` の場合 `<button disabled aria-disabled="true">` |

**特記事項**: `startTime >= facilityStartTime` の比較は HH:mm の固定桁数(4文字)を前提とする辞書順文字列比較。GAS の schedules シートで時刻が常に `HH:mm` 形式で入力される前提が成立する限り正しく動作する。

**判定: PASS**

---

### AC-16: タップで ○→△→空欄→○ とサイクルする

| 確認項目 | 結果 |
|:--|:--|
| `tapSlot()` — null → 'can' | PASS |
| `tapSlot()` — 'can' → 'undecided' | PASS |
| `tapSlot()` — 'undecided' → null(delete) | PASS |
| `tapSlot()` — null → 'can'(再サイクル) | PASS |
| グレーアウトボタンは `pointer-events:none` + `disabled` でタップ不可 | PASS |
| ボタンテキスト: 未選択=`9時`、○=`○ 9時`、△=`△ 9時` | PASS |

**判定: PASS**

---

### AC-17: 送信データが新データモデルで保存される

| 確認項目 | 結果 |
|:--|:--|
| `answers` オブジェクトのキー形式が `'YYYY-MM-DD|HH:mm'` | PASS — `slotKey = dateInfo.date + '|' + slot.slotStart` |
| `handleLiffSubmitFast` が `|` でキーを分割して `date` と `slotStart` を取り出す | PASS |
| 新シート構造(7列: responseId/userId/date/slotStart/answer/createdAt/updatedAt) | PASS — `SLOT_RESPONSES_HEADER` と `newRows.push([...7列...])` |
| answer 値が 'can'/'undecided' のみ受け付ける | PASS — それ以外は `continue` でスキップ |
| 行けない場合(未選択)はレコードを保存しない | PASS — answers に含まれない場合は newRows に入らない |

**判定: PASS**

---

### AC-18: 前回答が正しく復元される

| 確認項目 | 結果 |
|:--|:--|
| `getSlotResponsesByUserId(userId)` が `{ 'YYYY-MM-DD|HH:mm': 'can'|'undecided' }` を返す | PASS |
| `handleLiffGetData` が `userAnswers` を返す | PASS |
| `renderForm` が `userAnswers` を `answers` オブジェクトに読み込む | PASS |
| 復元された回答で `btn-slot.selected-can` / `selected-undecided` クラスが付与される | PASS |

**判定: PASS**

---

## 機能テスト(F-4スコープ外との整合性)

### メンバー管理・質問配信

| 確認項目 | 結果 |
|:--|:--|
| `handleFollow` / `handleUnfollow` に変更なし | PASS |
| `handleDistributeSurvey` に変更なし | PASS |
| `handleSendReminders` の `getRespondedUserIds()` が新 API ベースで動作 | PASS — `getAllSlotResponses()` を使用 |

### handleVote no-op 化

| 確認項目 | 結果 |
|:--|:--|
| `handleVote` がログだけ出して return | PASS |
| `_routeEvent` の `case 'postback'` が `handleVote` を呼ぶ | PASS — 既存のルーティングを維持 |

### 集計ロジック

| 確認項目 | 結果 |
|:--|:--|
| `handleAggregateAndNotify` が `getAllSlotResponses()` を使う | PASS |
| `(date, slotStart)` キーごとに can 票を集計 | PASS |
| 4人以上スロットをアナウンス | PASS |

---

## 非機能テスト

### パフォーマンス

| 確認項目 | 結果 |
|:--|:--|
| `handleLiffSubmitFast` がロック取得→一括削除→`setValues` 一括挿入 | PASS — 高速化パターン踏襲 |
| `getSlotResponsesByUserId` が B〜E 列(4列)を一括取得 | PASS |
| `clearSlotResponsesByUserId` が後ろから削除して行番号ズレを防止 | PASS |

### セキュリティ

| 確認項目 | 結果 |
|:--|:--|
| `_handleLiffApi` で `verifyLineIdToken` を必ず呼ぶ | PASS(変更なし) |
| HTML の `esc()` 関数で XSS 防止 | PASS — 全 innerHTML 挿入前にエスケープ |
| answer 値のバリデーション(can/undecided 以外はスキップ) | PASS |

### エラーハンドリング

| 確認項目 | 結果 |
|:--|:--|
| `upsertSlotResponse` の引数バリデーション | PASS — userId/date/slotStart が空・answer が不正の場合に throw |
| `handleLiffSubmitFast` の引数バリデーション | PASS |
| LIFF 初期化失敗・fetch 失敗時のエラー表示 | PASS |
| タイムアウト処理(15秒) | PASS |

---

## 視覚的検証が必要な箇所

以下の項目は実機(スマートフォン + LINE LIFF)での目視確認が必要:

1. **6ボタン横並びのレイアウト**: 5インチ以下のスマホ画面で `flex-wrap:nowrap` が崩れないか確認
2. **グレーアウトの視認性**: `#e0e0e0`/`#aaa` の配色が実機で分かりやすいか
3. **固定送信ボタン(fixed)**: スクロール時に他の要素に重ならないか・コンテンツが `padding-bottom:100px` で隠れないか
4. **施設情報行の折り返し**: 3施設以上が並ぶ場合に `facility-info` の折り返し表示を確認(TBD-17)
5. **liffResults.html のスロット一覧**: 全スロット×全日付が縦長で読みやすいか

---

## セルフリファイン点数: 44 / 50

差し引き項目:
- -3: 実機テストなし(GAS / LIFF 環境での統合テスト不可)
- -3: 施設情報の3施設以上折り返しが TBD のままで未テスト

---

## 次のステップ

コードレビュー(REVIEW_REPORT_F4.md)に進んでください。
実機確認は clasp push + GitHub Pages デプロイ後に実施してください。
