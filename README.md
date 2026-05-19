# gas-badminton-scheduler

新潟市の市民体育館の **個人開放(バドミントン)** について、LINE グループトーク上で日程調整から体育館予約まで全自動化する Bot プロジェクトです。

> **Bot(ボット)** とは、LINE 上で人の代わりに自動で返事をしてくれるプログラムのことです。

---

## 現在のステータス

**全機能実装完了 — 検証・実機テスト進行中**

| Phase | ステータス |
|:--|:--:|
| Phase 0(準備) | ✅ 完了(2026-05-10) |
| Phase 1(MVP) | ✅ 完了(2026-05-10) |
| Phase 2(スクレイピング自動化 + 新月通知) | ✅ 完了(2026-05-15) |
| Phase 3(LIFF グリッドフォーム + グループトーク移行) | ✅ 完了(2026-05-15) |
| Phase 4(F-6 LIFF 予約自動化) | ✅ 実装完了(2026-05-19) / 実機テスト待ち |

詳細は [`REQUIREMENTS.md`](./REQUIREMENTS.md) v1.5(2026-05-17) を参照してください。

---

## このツールがやること

1. 施設サイトのスケジュール更新を毎朝自動検知 → グループトークに「日程調整フォーム」を配信
2. メンバーは LINE アプリ内で開くフォーム(LIFF)をタップして候補日時を選ぶ
3. 4 人以上集まるスロットが確定したら Bot がグループにすぐ通知
4. 全員回答後に Bot が「4 人以上集まる日時」を自動集計してグループに通知
5. 「予約する」ボタンをタップすると LIFF が開き、コートを選ぶだけでバド卓ねっとへの体育館予約が自動完了する

これまで手動 LINE で人力調整していた作業をまるごと自動化します。

---

## 技術スタック

| 役割 | 技術 |
|:--|:--|
| サーバーロジック | **GAS(Google Apps Script)** — Webhook 受信・LINE 送信・データ集計 |
| LIFF フォームホスティング | **GitHub Pages** — `docs/liff.html` / `docs/liffResults.html` / `docs/reserve.html` |
| 予約自動化 | **AWS Lambda + API Gateway** — バド卓ねっとへのフォーム自動送信(GAS からは直接呼べないため別サーバーを経由) |
| ローカル開発・デプロイ | **clasp** — GAS コードをローカル PC で書いてアップロードする公式ツール |
| LINE 連携 | **LINE Messaging API** + **LIFF** — メッセージ送受信・フォーム表示 |
| データ保存 | **Google スプレッドシート** — メンバー / スケジュール / 回答履歴 |
| スケジュール取得 | **IMPORTHTML 関数** — 体育館サイトから情報を自動取得(毎朝 7 時) |

---

## ファイル構成

```
gas-badminton-scheduler/
├── README.md                  ← このファイル
├── REQUIREMENTS.md            ← 要件定義書 v1.5
├── DECISION_NOTES.md          ← 意思決定の記録
├── GLOSSARY.md                ← 略号・用語集
├── PHASE_0_SETUP.md           ← 初期セットアップ手順書
│
├── docs/                      ← GitHub Pages でホスティング(LIFF フォーム)
│   ├── reserve.html           ← ★ F-6 予約 LIFF(LIFFが実際に読み込む本番ファイル)
│   ├── liff.html              ← 日程回答フォーム(LINE アプリ内で開く)
│   ├── liffResults.html       ← 回答状況確認ページ
│   ├── liff.config.js         ← LIFF 設定ファイル
│   ├── USER_GUIDE.md          ← ユーザー向け使い方ガイド
│   └── AWS_SETUP_GUIDE.md     ← AWS Lambda セットアップ手順
│
├── src/                       ← GAS にデプロイするソースコード
│   ├── Code.js                ← Webhook エントリポイント / LIFF API ルーター
│   ├── handlers.js            ← イベントハンドラー群
│   ├── lineApi.js             ← LINE API 呼び出し関数
│   ├── sheets.js              ← スプレッドシート読み書き
│   ├── scraper.js             ← スクレイピング・更新検知・新月通知
│   ├── utils.js               ← ユーティリティ関数
│   ├── liff.html              ← GAS 配信用テンプレ(doGet 用 / 本番は docs/liff.html)
│   └── liffResults.html       ← GAS 配信用テンプレ(doGet 用 / 本番は docs/liffResults.html)
│
├── liff/                      ← GAS にデプロイする LIFF 雛形
│   └── reserve.html           ← F-6 予約フォームの GAS 雛形(clasp push のみ / 本番は docs/reserve.html)
│
├── lambda/                    ← AWS Lambda 関数(体育館予約フォームの自動送信)
│   ├── reserve.js             ← バド卓ねっとへのスキャン・予約処理
│   ├── package.json           ← Lambda 依存パッケージ定義
│   └── package-lock.json      ← Lambda 依存パッケージロック
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
- ユーザー向けガイド: [`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md)
- AWS セットアップ: [`docs/AWS_SETUP_GUIDE.md`](./docs/AWS_SETUP_GUIDE.md)

### 作業ログ（開発過程の記録）
各フェーズの実装記録・コードレビュー・テスト結果は [`_archive/`](./_archive/) に保管しています。プロジェクト完了後に削除予定です。

---

## ライセンス

個人開発・学習用途のため非公開(UNLICENSED)。
