# gas-badminton-scheduler

新潟市の市民体育館の **個人開放(バドミントン)** について、LINE 上で日程調整を全自動化する Bot プロジェクトです。

> **Bot(ボット)** とは、LINE 上で人の代わりに自動で返事をしてくれるプログラムのことです。

---

## 現在のステータス

**Phase 0(環境構築)着手中** — まだコードは書いていません。LINE Developers / GAS / clasp の初期セットアップ段階です。

セットアップ手順は **[`PHASE_0_SETUP.md`](./PHASE_0_SETUP.md)** を参照してください。

---

## このツールがやること(ざっくり)

1. Bot が LINE で「来週いつバドミントンできる?」とメンバー全員に質問
2. メンバーは LINE 上のボタンをタップして候補日時を選ぶ
3. 全員の回答が揃ったら Bot が「4 人以上集まる日時」を自動で割り出す
4. 結果(日時 + 使える体育館)を全員に LINE で通知

これまで手動 LINE で人力調整していた作業をまるごと自動化します。

詳細は [`REQUIREMENTS.md`](./REQUIREMENTS.md)(要件定義書 v0.2)を参照してください。

---

## ファイル構成

```
gas-badminton-scheduler/
├── README.md                     ← このファイル(プロジェクトの入り口)
├── PHASE_0_SETUP.md              ← Phase 0(環境構築)の手順書
├── REQUIREMENTS.md               ← 要件定義書 v0.2(何を作るか)
├── DECISION_NOTES.md             ← なぜその設計にしたかの記録
├── CRITIC_REPORT.md              ← REQUIREMENTS.md v0.2 の品質評価
├── CRITIC_REPORT_v0.1.md         ← REQUIREMENTS.md v0.1 の品質評価(履歴)
├── package.json                  ← Node.js / npm のプロジェクト設定
├── appsscript.json               ← GAS のマニフェスト(動作設定)
├── appsscript.json.md            ← appsscript.json の解説メモ
├── .gitignore                    ← Git に上げないファイル一覧
└── src/                          ← Phase 1 以降、GAS のコードを置く場所
    └── .gitkeep                  ← 空フォルダ保持用(Phase 1 で削除)
```

---

## 開発ロードマップ

| Phase | 内容 | ステータス |
|:--|:--|:--|
| **Phase 0(準備)** | LINE Developers で Bot 作成、GAS プロジェクト作成、clasp 初期設定 | **着手中** |
| Phase 1(MVP) | 質問配信〜回答収集〜リマインド〜判定〜全員通知 を自動化(開放スケジュールは手動入力) | 未着手 |
| Phase 2(拡張) | 4 体育館スクレイピング + サイト更新検知 + 「どの体育館が使えるか併記」 | 未着手 |
| Phase 3(任意) | ランキング表示、複数グループ対応、過去履歴閲覧 | 未着手 |

---

## 技術スタック

| 役割 | 技術 |
|:--|:--|
| サーバーロジック | **GAS(Google Apps Script)** — Google 提供の無料サーバー実行環境 |
| ローカル開発・デプロイ | **clasp** — GAS コードをローカル PC で書いてアップロードできる公式ツール |
| LINE 連携 | **LINE Messaging API** — Bot からのメッセージ送受信 |
| データ保存 | **Google スプレッドシート** — メンバー / スケジュール / 回答履歴 |
| Web 取得(Phase 2) | **GAS の `UrlFetchApp`** — 体育館サイトから情報取得 |

---

## 関連ドキュメント

- 要件定義書: [`REQUIREMENTS.md`](./REQUIREMENTS.md)
- 意思決定の記録: [`DECISION_NOTES.md`](./DECISION_NOTES.md)
- 要件定義書の品質評価: [`CRITIC_REPORT.md`](./CRITIC_REPORT.md)
- Phase 0 セットアップ手順: [`PHASE_0_SETUP.md`](./PHASE_0_SETUP.md)

---

## ライセンス

個人開発・学習用途のため非公開(UNLICENSED)。
