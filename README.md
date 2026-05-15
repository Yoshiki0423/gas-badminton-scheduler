# gas-badminton-scheduler

新潟市の市民体育館の **個人開放(バドミントン)** について、LINE グループトーク上で日程調整を全自動化する Bot プロジェクトです。

> **Bot(ボット)** とは、LINE 上で人の代わりに自動で返事をしてくれるプログラムのことです。

---

## 現在のステータス

**Phase 3(LIFF UX リニューアル + F-5 グループトーク移行)実装完了 — 実機テスト進行中**

| Phase | ステータス |
|:--|:--:|
| Phase 0(準備) | ✅ 完了(2026-05-10) |
| Phase 1(MVP) | ✅ 完了(2026-05-10) |
| Phase 2(スクレイピング自動化 + 新月通知) | ✅ 完了(2026-05-15) |
| Phase 3(LIFF グリッドフォーム + グループトーク移行) | ✅ 実装完了(2026-05-15) / 4人実機テスト待ち |

詳細は [`REQUIREMENTS.md`](./REQUIREMENTS.md) v0.8(2026-05-15) を参照してください。

---

## このツールがやること

1. 施設サイトのスケジュール更新を毎朝自動検知 → グループトークに「日程調整フォーム」を配信
2. メンバーは LINE アプリ内で開くフォーム(LIFF)をタップして候補日時を選ぶ
3. 4 人以上集まるスロットが確定したら Bot がグループにすぐ通知
4. 全員回答後に Bot が「4 人以上集まる日時」を自動集計してグループに通知

これまで手動 LINE で人力調整していた作業をまるごと自動化します。

---

## 技術スタック

| 役割 | 技術 |
|:--|:--|
| サーバーロジック | **GAS(Google Apps Script)** — Webhook 受信・LINE 送信・データ集計 |
| LIFF フォームホスティング | **GitHub Pages** — `docs/liff.html` / `docs/liffResults.html` |
| ローカル開発・デプロイ | **clasp** — GAS コードをローカル PC で書いてアップロードする公式ツール |
| LINE 連携 | **LINE Messaging API** + **LIFF** — メッセージ送受信・フォーム表示 |
| データ保存 | **Google スプレッドシート** — メンバー / スケジュール / 回答履歴 |
| スケジュール取得 | **IMPORTHTML 関数** — 体育館サイトから情報を自動取得(毎朝 7 時) |

---

## ファイル構成

```
gas-badminton-scheduler/
├── README.md                  ← このファイル
├── REQUIREMENTS.md            ← 要件定義書 v0.8
├── DECISION_NOTES.md          ← 意思決定の記録
├── GLOSSARY.md                ← 略号・用語集
├── PHASE_0_SETUP.md           ← 初期セットアップ手順書
│
├── docs/                      ← GitHub Pages でホスティング(LIFF フォーム)
│   ├── liff.html              ← 日程回答フォーム(LINE アプリ内で開く)
│   └── liffResults.html       ← 回答状況確認ページ
│
├── src/                       ← GAS にデプロイするソースコード
│   ├── Code.js                ← Webhook エントリポイント / LIFF API ルーター
│   ├── handlers.js            ← イベントハンドラー群
│   ├── lineApi.js             ← LINE API 呼び出し関数
│   ├── sheets.js              ← スプレッドシート読み書き
│   ├── scraper.js             ← スクレイピング・更新検知・新月通知
│   └── utils.js               ← ユーティリティ関数
│
├── appsscript.json            ← GAS マニフェスト
└── .claspignore               ← clasp push 除外ファイル一覧
```

---

## 関連ドキュメント

### 要件・設計
- 要件定義書: [`REQUIREMENTS.md`](./REQUIREMENTS.md)
- 意思決定の記録: [`DECISION_NOTES.md`](./DECISION_NOTES.md)
- セットアップ手順: [`PHASE_0_SETUP.md`](./PHASE_0_SETUP.md)

### 実装記録
- Phase 1〜2-2 実装: [`IMPLEMENTATION.md`](./IMPLEMENTATION.md)
- F-3 LIFF UX 実装: [`IMPLEMENTATION_F3.md`](./IMPLEMENTATION_F3.md)
- F-4 グリッドフォーム実装: [`IMPLEMENTATION_F4.md`](./IMPLEMENTATION_F4.md)
- F-2-5 新月通知実装: [`IMPLEMENTATION_F25.md`](./IMPLEMENTATION_F25.md)
- F-5 グループトーク移行実装: [`IMPLEMENTATION_F5.md`](./IMPLEMENTATION_F5.md)

### 品質評価
- テスト結果: `TEST_REPORT.md` / `TEST_REPORT_F3.md` / `TEST_REPORT_F4.md`
- コードレビュー: `REVIEW_REPORT.md` / `REVIEW_REPORT_F3.md` / `REVIEW_REPORT_F4.md` / `REVIEW_REPORT_F5.md`
- 品質評価: `CRITIC_REPORT.md` / `CRITIC_REPORT_F1-1.md` / `CRITIC_REPORT_F2.md` 他

---

## ライセンス

個人開発・学習用途のため非公開(UNLICENSED)。
