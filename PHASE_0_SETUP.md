# Phase 0 セットアップ手順書 — gas-badminton-scheduler

**作成日**: 2026-05-10
**対象**: プロジェクト管理者(Yoshiki さん本人)
**前提環境**: Windows 11、PowerShell、Node.js 未インストールの可能性あり
**所要時間目安**: **合計 約 90〜120 分**(初心者の場合・うち待ち時間含む)

---

## 0. このドキュメントの読み方

### 0-1. 何のためのドキュメントか

このドキュメントは、**Phase 1(Bot 本体の開発)を始める前に必ず終わらせておく「環境構築」の手順書** です。
LINE と Google Apps Script(GAS)を連携させるための土台を整える作業を、初心者でも迷わず進められるように 1 ステップずつ解説しています。

> **GAS(Google Apps Script)** とは、Google が無料で提供している「ブラウザ上でプログラムを動かせる仕組み」のことです。サーバーを借りなくても、自動処理を作って実行できます。

### 0-2. 所要時間の目安

| Step | 内容 | 目安時間 |
|:--|:--|--:|
| Step 1 | LINE Developers アカウント作成 + プロバイダー作成 | 10 分 |
| Step 2 | Messaging API チャネル作成 + 各種キー取得 | 15 分 |
| Step 3 | Bot の初期設定(LINE Official Account Manager) | 10 分 |
| Step 4 | Google アカウント確認 + GAS プロジェクト作成 | 10 分 |
| Step 5 | Node.js インストール確認 + インストール | 15 分(未インストール時) |
| Step 6 | clasp のグローバルインストール | 5 分 |
| Step 7 | clasp で Google アカウントにログイン | 5 分 |
| Step 8 | clasp clone でローカル開発環境セットアップ | 10 分 |
| Step 9 | 初回テストプッシュ(疎通確認) | 10 分 |
| Step 10 | Phase 0 完了確認チェックリスト | 5 分 |
| **合計** | | **約 95 分(待ち時間含めて 90〜120 分)** |

### 0-3. 必要なもの一覧

- **Windows 11 PC**(本ドキュメントは Windows + PowerShell 前提)
- **LINE アカウント**(個人の LINE で OK)
- **Google アカウント**(Gmail を持っていればそれでよい・ビジネス用 / 個人用どちらでも OK)
- **インターネット接続**
- **テキストエディタ**(VS Code 推奨。メモ帳でも進められる)
- **メモを取る場所**(後述する各種 ID やキーを書き留めるため・ローカルのメモアプリやテキストファイル推奨)

> ⚠️ **重要**: Step 2 で取得する「チャネルアクセストークン」「チャネルシークレット」は、**他人に知られると Bot を乗っ取られる** 重要情報です。LINE のチャットや SNS に貼り付けて他人に共有しないでください。

### 0-4. 作業の流れ図

```
┌─────────────────────────────────────────┐
│ LINE 側のセットアップ(Step 1〜3)               │
│   Step 1: LINE Developers + プロバイダー       │
│   Step 2: Messaging API チャネル + キー取得   │
│   Step 3: Bot 初期設定(応答 OFF / Webhook ON)│
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│ Google 側のセットアップ(Step 4)             │
│   Step 4: GAS プロジェクト + スクリプト ID 取得 │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│ ローカル PC 側のセットアップ(Step 5〜9)           │
│   Step 5: Node.js                       │
│   Step 6: clasp インストール              │
│   Step 7: clasp ログイン                  │
│   Step 8: clasp clone                   │
│   Step 9: テストプッシュ(疎通確認)            │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│ Step 10: 完了チェック → Phase 1 へ           │
└─────────────────────────────────────────┘
```

### 0-5. このドキュメントの記号の意味

- 💡 = ハマりやすいポイント・コツ
- ⚠️ = 危険・注意してほしい操作
- ✅ = 各 Step の完了確認チェック
- 🔍 = 用語の補足解説
- 📝 = メモしておくべき情報

---

## Step 1: LINE Developers アカウント作成 + プロバイダー作成

**所要時間**: 約 10 分

### 1-1. このステップで何をするか

LINE が提供している **「Bot を作るための管理画面」** に、自分の LINE アカウントでログインします。
そして、「プロバイダー(provider)」という入れ物を 1 つ作ります。

> 🔍 **プロバイダー** とは、LINE 上で Bot や LINE ログイン機能を提供する「会社・サービス事業者」を表す概念です。本来は企業が「○○株式会社」のような単位で 1 つ作るものですが、個人開発でも 1 つ作る必要があります。
> なぜ必要かと言うと、LINE 側が「この Bot は誰が作っているのか」を識別するためです。プロバイダーの下に複数のチャネル(=個別の Bot)をぶら下げる構造になっています。

### 1-2. 手順

1. ブラウザで以下の URL を開く
   - https://developers.line.biz/ja/
2. 画面右上の **「ログイン」** ボタンをクリック
3. **「LINE アカウントでログイン」** を選び、普段使っている LINE と同じメールアドレス・パスワードでログイン
   - 💡 LINE アプリで設定した「メールアドレスとパスワード」がそのまま使えます。設定していない場合は、LINE アプリの「ホーム → 設定 → アカウント」から登録してください。
4. ログイン後、規約に同意する画面が出たら **「同意する」** をクリック
5. ログイン後の画面で、**「プロバイダー」** という見出しの下にある **「作成」** ボタン(または「Create a new provider」)をクリック
6. プロバイダー名の入力欄が出るので、自分がわかる名前を入力
   - 例: `バドミントン日程調整`(日本語可)
   - 💡 プロバイダー名は **後から変えられない可能性がある** ので、自分が一目で識別できる名前にしましょう
7. **「作成」** をクリック → プロバイダー画面に遷移すれば完了

### ✅ Step 1 完了チェック

- [ ] LINE Developers にログインできた
- [ ] プロバイダーが 1 つ作成され、その画面に入れる状態になっている

<details>
<summary>💥 よくあるエラーと対処</summary>

- **「LINE アカウントでログインできない」** → LINE アプリで「ホーム → 設定 → アカウント」を開き、メールアドレスとパスワードが設定されているか確認。未設定なら登録してから再試行。
- **「プロバイダー作成ボタンが見つからない」** → ページ最下部までスクロール、または右上の「コンソール」リンクをクリックして管理画面に入り直す。

</details>

---

## Step 2: Messaging API チャネル作成

**所要時間**: 約 15 分

### 2-1. このステップで何をするか

Step 1 で作ったプロバイダーの下に、**Bot 本体になる「チャネル」を作成** します。
そして、Bot が動くために必要な **3 つの認証情報**(チャネルアクセストークン / チャネルシークレット / Bot Basic ID)をメモします。

> 🔍 **チャネル** とは、Bot や LINE ログインのような「個別のサービス機能」を表す単位です。今回は「Messaging API(=メッセージ送受信機能)」のチャネルを作ります。

### 2-2. 手順

1. Step 1 で作ったプロバイダーの画面を開く(URL: https://developers.line.biz/console/)
2. プロバイダー画面の中段にある **「チャネル設定」** または **「新規チャネル作成」** という選択肢から、**「Messaging API」** を選ぶ
   - 💡 「LINE ログイン」「LINE ミニアプリ」など他の選択肢もありますが、Bot 機能には必ず **Messaging API** を選ぶ
3. チャネル作成フォームが開くので、以下の項目を順に入力
   - **チャネルの種類**: `Messaging API`(自動選択されているはず)
   - **プロバイダー**: Step 1 で作ったプロバイダーが選ばれていることを確認
   - **チャネルアイコン**: 任意(後から変更可能・スキップして OK)
   - **チャネル名**: `バドミントン日程調整Bot` など分かりやすい名前
     - ⚠️ チャネル名に「LINE」という文字列を含めるとエラーになります
   - **チャネル説明**: `新潟市の市民体育館での個人開放(バドミントン)の日程調整を自動化する Bot`(1〜2 文で OK)
   - **大業種** / **小業種**: 該当するものを選ぶ(例: 大業種 = `個人`、小業種 = `個人(その他)`)
   - **メールアドレス**: 自分の Gmail アドレスなど(LINE からの通知が届く)
   - **プライバシーポリシー URL** / **サービス利用規約 URL**: 任意(空欄で OK・個人開発のため)
4. **料金プラン**: フリープラン(無料)を選択
   - 💡 後から有料プランに変更可能。最初はフリーで開始
5. ページ下部の **利用規約に同意** チェックボックスをすべて ON にする
6. **「作成」** をクリック → チャネル管理画面に遷移すれば成功

### 2-3. 認証情報を取得・メモする(超重要)

チャネル作成後、以下の 3 つの情報を **必ず安全な場所にメモ** します。
Phase 1 で Bot のコードを書くときに毎回使う情報です。

> ⚠️ **絶対に SNS や公開リポジトリに貼り付けないこと**。漏れると Bot が乗っ取られます。

#### 📝 メモ対象 (1): チャネル ID + チャネルシークレット

1. チャネル管理画面の上部タブから **「チャネル基本設定」** をクリック
2. 以下の 2 つの値を見つけてメモする
   - **チャネル ID**(数字のみ・例: `1234567890`)
   - **チャネルシークレット**(英数字の文字列・例: `abc123def456ghi789...`)

#### 📝 メモ対象 (2): チャネルアクセストークン

1. 上部タブから **「Messaging API 設定」** をクリック
2. ページ最下部までスクロールし、**「チャネルアクセストークン」** のセクションを見つける
3. **「発行」** ボタンをクリック → 長い文字列(英数字 100 文字以上)が表示される
4. **「コピー」** ボタンでコピーしてメモ

#### 📝 メモ対象 (3): Bot Basic ID(@xxxxxxx の形式)

1. 同じ「Messaging API 設定」タブの上部に **「Bot 情報」** というセクションがある
2. **Bot Basic ID**(`@123abcde` のように `@` で始まる ID)をメモ
   - これは後で「友だち追加用 ID」として使う

### 2-4. メモ用テンプレート(コピペして自分用メモに保存)

```
========================================
LINE Messaging API 認証情報メモ(機密)
========================================
作成日: 2026-05-XX
プロバイダー名: バドミントン日程調整
チャネル名: バドミントン日程調整Bot

チャネル ID:           [数字 10 桁]
チャネルシークレット:    [英数字 32 文字程度]
チャネルアクセストークン: [英数字 100 文字以上]
Bot Basic ID:        @xxxxxxxx
========================================
※ このメモは絶対に他人に共有しない
※ Git リポジトリに上げない
※ パスワード管理ツール(1Password / Bitwarden 等)に保存推奨
========================================
```

### ✅ Step 2 完了チェック

- [ ] Messaging API チャネルが作成できた
- [ ] チャネル ID をメモした
- [ ] チャネルシークレットをメモした
- [ ] チャネルアクセストークンを発行・メモした
- [ ] Bot Basic ID(`@xxxxxxxx`)をメモした

<details>
<summary>💥 よくあるエラーと対処</summary>

- **「チャネル名に LINE が含まれる」エラー** → チャネル名から「LINE」の文字列を外して再投稿
- **「チャネルアクセストークン」発行ボタンが見つからない** → 「Messaging API 設定」タブの最下部までスクロール
- **「メールアドレスが既に使用されています」** → 別の Google アカウントのメールアドレスを使うか、サポートに問い合わせ

</details>

---

## Step 3: Bot の初期設定(LINE Official Account Manager)

**所要時間**: 約 10 分

### 3-1. このステップで何をするか

LINE Developers でチャネルを作っただけでは、Bot は「LINE 標準の自動応答メッセージ」を返してしまいます。
これを **「自分の作ったプログラムが応答する」モードに切り替える** 設定をします。
具体的には:

- **応答メッセージ**: OFF(LINE 標準の決まり文句を送らない)
- **Webhook**: ON(自分の Bot プログラムにイベント通知を送る)
- **あいさつメッセージ**: 任意(友だち追加直後に送る一文・OFF にしてプログラム側で送ってもよい)

### 3-2. 手順

1. LINE Developers のチャネル管理画面で、上部タブの **「Messaging API 設定」** をクリック
2. 「LINE 公式アカウント機能」セクションの中にある **「LINE Official Account Manager」** のリンクをクリック(別タブで開く)
   - 💡 LINE Official Account Manager は、LINE が用意した別の管理画面です。Bot の応答動作はこちらで設定します
3. Official Account Manager の画面が開いたら、左サイドバーの **「設定」 → 「応答設定」** をクリック
4. 以下の項目を設定
   - **応答モード**: **「Bot」** を選択(「チャット」ではない)
   - **あいさつメッセージ**: **OFF**(後で Bot プログラム側で歓迎メッセージを送るため)
   - **応答メッセージ**: **OFF**(LINE 標準の自動応答を止める)
   - **Webhook**: **ON**(これが ON になっていないと Bot にイベントが届かない・最重要)
5. 設定変更後、ページ上部または下部の **「保存」** ボタンをクリック

### 3-3. QR コードの取得方法

メンバーが Bot を友だち追加するときに使う **QR コード** または **追加 URL** を取得します。

1. LINE Official Account Manager の左サイドバーで **「ホーム」** をクリック
2. ページ上部または「友だち追加」セクションに **QR コード** が表示されている
3. **「友だち追加ガイド」** または **「友だち追加用 URL」** ボタンから:
   - QR コードの画像をダウンロード(PNG 形式)
   - 友だち追加用 URL(`https://line.me/R/ti/p/@xxxxxxxx`)をコピー
4. これらを Step 2 のメモに追記

### ✅ Step 3 完了チェック

- [ ] 応答モードが「Bot」に設定されている
- [ ] あいさつメッセージが OFF
- [ ] 応答メッセージが OFF
- [ ] Webhook が ON
- [ ] QR コード(または追加用 URL)を取得・メモした

<details>
<summary>💥 よくあるエラーと対処</summary>

- **「LINE Official Account Manager のリンクが見つからない」** → 直接 https://manager.line.biz/ にアクセスして該当アカウントを選ぶ
- **「Webhook を ON にしても Bot が反応しない」** → Step 9 でテストプッシュ後に Webhook URL を設定する必要があります(Phase 1 で扱う)。今は ON にしておくだけで OK
- **「保存ボタンが見当たらない」** → トグルスイッチは ON / OFF を切り替えた瞬間に保存される(自動保存)タイプのこともある。一度ページをリロードして反映確認

</details>

---

## Step 4: Google アカウント確認 + GAS プロジェクト作成

**所要時間**: 約 10 分

### 4-1. このステップで何をするか

Google Apps Script(GAS)のプロジェクトを新規作成し、**スクリプト ID** を取得します。
スクリプト ID は次のステップで `clasp clone` を実行するときに必要になります。

> 🔍 **スクリプト ID** とは、GAS プロジェクトを世界で 1 つに識別する固有の ID(英数字 50 文字以上の長い文字列)です。

### 4-2. 手順

1. ブラウザで以下にアクセス
   - https://script.google.com/
2. 普段使っている Google アカウント(Gmail)でログイン
3. 画面左上の **「+ 新しいプロジェクト」** ボタンをクリック
   - 💡 ボタンが見当たらないときは、左サイドバーの **「プロジェクト」 → 「+ 新しいプロジェクト」** から
4. 新しいプロジェクトが「無題のプロジェクト」という名前で開く
5. 画面左上の **「無題のプロジェクト」** という文字をクリックし、名前を `gas-badminton-scheduler` に変更 → **「名前を変更」** をクリック
6. 左サイドバーの **歯車アイコン(プロジェクトの設定)** をクリック
7. 設定画面の **「ID」** セクションにある **「スクリプト ID」** をコピー
   - 例: `1abc...XYZ`(50 文字以上の英数字)

### 📝 メモ対象 (4): スクリプト ID

```
GAS スクリプト ID: [50 文字以上の英数字をここに貼る]
GAS プロジェクト URL: https://script.google.com/d/[スクリプトID]/edit
```

### ✅ Step 4 完了チェック

- [ ] script.google.com にログインできた
- [ ] `gas-badminton-scheduler` という名前のプロジェクトが作成された
- [ ] スクリプト ID をメモした

<details>
<summary>💥 よくあるエラーと対処</summary>

- **「組織アカウントで GAS が制限されている」** → 個人の Gmail アカウントに切り替えて再試行
- **「スクリプト ID が見つからない」** → 設定画面(歯車アイコン)を一番下までスクロール
- **「新しいプロジェクトボタンが押せない」** → ブラウザを Chrome に切り替える、または広告ブロッカーを一時 OFF

</details>

---

## Step 5: Node.js インストール確認 + インストール手順

**所要時間**: 約 15 分(未インストール時)

### 5-1. このステップで何をするか

`clasp` を使うために必要な **Node.js**(ノードジェイエス)というツールをインストールします。
すでに入っていれば、バージョン確認だけで OK です。

> 🔍 **Node.js** とは、本来ブラウザ上でしか動かない JavaScript を、PC 上のコマンドラインからも動かせるようにする実行環境です。clasp や npm はこの上で動きます。
> 🔍 **npm**(エヌピーエム = Node Package Manager)は、Node.js と一緒にインストールされる「ライブラリ管理ツール」。`npm install xxx` で世界中の便利ツールを取り込めます。

### 5-2. 既存インストール確認

PowerShell を開いて、以下のコマンドを実行します。

> 💡 **PowerShell の開き方**: スタートメニューで「PowerShell」と入力 → 「Windows PowerShell」をクリック。または `Win + X` キー → 「ターミナル」を選ぶ。

```powershell
PS C:\Users\Yoshiki> node --version
```

- 出力が `v18.x.x` 以上(例: `v20.10.0`)なら **インストール済み・このステップは終了** → Step 6 へ
- `node : 用語 'node' は、コマンドレット...として認識されません` のようなエラーが出たら **未インストール** → 5-3 へ

ついでに npm のバージョンも確認:

```powershell
PS C:\Users\Yoshiki> npm --version
```

- 出力が `9.x.x` 以上なら問題なし

### 5-3. インストール手順(未インストール時)

1. ブラウザで以下にアクセス
   - https://nodejs.org/ja
2. 画面中央に **「LTS(推奨版)」** と **「Current(最新版)」** の 2 つのボタンが並んでいる
3. **必ず左側の「LTS(推奨版)」** をクリックしてダウンロード
   - 💡 LTS = Long Term Support(長期サポート版)。安定していて、ほとんどの開発はこちらで OK
4. ダウンロードした `.msi` ファイル(例: `node-v20.x.x-x64.msi`)をダブルクリックして実行
5. インストーラーが起動するので、基本的に **「Next」を押し続けて全部デフォルト設定で OK**
   - ⚠️ ライセンス同意のチェックは ON にすること
   - ⚠️ 「Tools for Native Modules」のチェックは **OFF のままで OK**(初心者には不要)
6. 「Install」をクリック → 数分待つ → 「Finish」で完了
7. **インストール後は必ず PowerShell を開き直す**(=現在開いている PowerShell では `node` コマンドが認識されない)
8. 開き直した PowerShell で再度バージョン確認

```powershell
PS C:\Users\Yoshiki> node --version
PS C:\Users\Yoshiki> npm --version
```

- 両方バージョンが表示されれば成功

### ✅ Step 5 完了チェック

- [ ] PowerShell で `node --version` が `v18` 以上で表示される
- [ ] PowerShell で `npm --version` が表示される

<details>
<summary>💥 よくあるエラーと対処</summary>

- **「`node` は認識されません」エラーが続く** → 一度 PC を再起動 → PowerShell を新しく開いて再度コマンド実行
- **「インストール中に Permission denied」** → インストーラーを右クリック →「管理者として実行」
- **「Node.js のサイトにアクセスできない」** → 一時的な接続エラーの可能性。数分後に再試行
- **「以前 Node.js を入れた気がするが古いバージョン」** → `Win + I` →「アプリ」→「インストールされているアプリ」で「Node.js」を検索 → アンインストール後、新版を入れ直す

</details>

---

## Step 6: clasp のグローバルインストール

**所要時間**: 約 5 分

### 6-1. このステップで何をするか

GAS をローカル PC で開発するための公式ツール **clasp** を、PC 全体で使えるようにインストールします。

> 🔍 **clasp**(クラスプ)= Command Line Apps Script Projects の略。Google が公式に出している「GAS をローカル PC で書いて、コマンドでアップロードできる」ツールです。

> 🔍 **グローバルインストール** とは、ある特定のプロジェクト内だけでなく、PC のどこからでもそのコマンドを使えるように入れる方法です。`-g` オプション(global の g)で指定します。
> 代替案として「プロジェクトごとのローカルインストール」もありますが、clasp は複数の GAS プロジェクトで使い回す前提のツールなので、グローバルインストールが推奨です。

### 6-2. 手順

PowerShell を開いて以下のコマンドを実行:

```powershell
PS C:\Users\Yoshiki> npm install -g @google/clasp
```

- 数十秒〜数分待つ(ネット環境次第)
- 完了すると「added X packages in Ys」のようなメッセージが出る

### 6-3. インストール確認

```powershell
PS C:\Users\Yoshiki> clasp --version
```

- バージョン番号(例: `2.4.2`)が表示されれば成功

### ✅ Step 6 完了チェック

- [ ] `clasp --version` が動作する

<details>
<summary>💥 よくあるエラーと対処</summary>

- **「権限がないと言われる(EACCES エラー)」** → PowerShell を「管理者として実行」で開き直してから再実行
- **「clasp コマンドが認識されない」** → PowerShell を一度閉じて開き直す。それでもダメなら `npm root -g` で出力されたパスが PATH に通っているか確認
- **「インストール中にネットワークエラー」** → ネット接続を確認後、`npm install -g @google/clasp --registry=https://registry.npmjs.org/` で公式レジストリ明示

</details>

---

## Step 7: clasp で Google アカウントにログイン

**所要時間**: 約 5 分

### 7-1. このステップで何をするか

ローカル PC の clasp と Google アカウントを連携させます。
コマンドを実行するとブラウザが自動で開き、Google アカウントへの「許可」画面が出るのでそこで承認します。
承認情報はローカル PC の隠しファイル(`.clasprc.json`)に保存され、以後 `clasp push` などのコマンドで自動利用されます。

### 7-2. 手順

1. PowerShell で以下を実行

```powershell
PS C:\Users\Yoshiki> clasp login
```

2. ブラウザが自動で立ち上がり、Google ログイン画面が表示される
3. **Step 4 で GAS プロジェクトを作ったときと同じ Google アカウント** を選択
   - ⚠️ 別のアカウントでログインすると、Step 8 の `clasp clone` で「権限なし」エラーになります
4. 「clasp が次の権限を要求します」という画面が出る
   - 「Google ドライブのファイルの表示・編集」など
   - **「許可」** をクリック
5. 「ログインに成功しました(Logged in! You may close this browser tab.)」と表示されたらブラウザを閉じる
6. PowerShell に戻って、`Authorization successful.` のようなメッセージが表示されているか確認

### ✅ Step 7 完了チェック

- [ ] PowerShell に `Authorization successful.` または `Logged in.` が表示された
- [ ] ホームディレクトリ(`C:\Users\Yoshiki`)に `.clasprc.json` ファイルが生成された
  - 確認コマンド: `Get-Item C:\Users\Yoshiki\.clasprc.json`
  - ⚠️ このファイルは **絶対に他人と共有してはいけません**(=プロジェクトの `.gitignore` で除外済み)

<details>
<summary>💥 よくあるエラーと対処</summary>

- **「ブラウザが開かない」** → 表示された URL を手動でコピーしてブラウザに貼り付ける
- **「アカウントが選択肢に出ない」** → ブラウザで一度 Google からログアウト → `clasp login` を再実行
- **「組織のアカウントで権限が制限されている」** → 個人 Gmail アカウントを使う、または管理者に確認

</details>

---

## Step 8: clasp clone でローカル開発環境セットアップ

**所要時間**: 約 10 分

### 8-1. このステップで何をするか

Step 4 で作った GAS プロジェクトを、**ローカル PC 内の `gas-badminton-scheduler/` フォルダにダウンロード(clone)** します。
これにより、GAS のコードを VS Code などのエディタで書き、`clasp push` で GAS にアップロードできるようになります。

### 8-2. 事前確認

すでに以下のフォルダ・ファイルが存在することを確認します(Phase 0 開始前に dev-orchestrator が用意済み)。

```powershell
PS C:\Users\Yoshiki> cd C:\Users\Yoshiki\projects\gas-badminton-scheduler
PS C:\Users\Yoshiki\projects\gas-badminton-scheduler> Get-ChildItem
```

期待される表示(主要ファイルのみ抜粋):

- `README.md`
- `PHASE_0_SETUP.md`(このファイル)
- `REQUIREMENTS.md`
- `DECISION_NOTES.md`
- `package.json`
- `appsscript.json`
- `appsscript.json.md`
- `.gitignore`
- `src/`(フォルダ)

### 8-3. 手順

1. PowerShell でプロジェクトフォルダに移動

```powershell
PS C:\Users\Yoshiki> cd C:\Users\Yoshiki\projects\gas-badminton-scheduler
```

2. **既存の `appsscript.json` を一時的にバックアップ**(clone で上書きされるのを防ぐ)
   - 💡 dev-orchestrator が用意した雛形 `appsscript.json` には `timeZone: Asia/Tokyo` 等が設定済みなので、保護したい

```powershell
PS C:\Users\Yoshiki\projects\gas-badminton-scheduler> Copy-Item appsscript.json appsscript.json.bak
```

3. `clasp clone` を実行

```powershell
PS C:\Users\Yoshiki\projects\gas-badminton-scheduler> clasp clone <ここにスクリプトIDを貼る>
```

> ⚠️ `<ここにスクリプトIDを貼る>` の部分を、Step 4 でメモしたスクリプト ID(50 文字以上の英数字)に置き換えてください。山かっこ `<>` も削除します。
> 例: `clasp clone 1abcDEF2gHij3kLMno4PQrs5tUvw...`

4. 実行後、以下のメッセージが出れば成功

```
Cloned 0 files.
└─ appsscript.json
```

(GAS プロジェクトはまだ空なので 0 files でOK)

5. 生成されたファイルを確認

```powershell
PS C:\Users\Yoshiki\projects\gas-badminton-scheduler> Get-ChildItem -Force | Where-Object { $_.Name -in '.clasp.json','appsscript.json' }
```

- `.clasp.json` が新たに生成されている(=GAS プロジェクトとの紐付け情報)
- `appsscript.json` は GAS 側の空の状態で上書きされている可能性あり

6. **バックアップを復元**(自分が用意した `timeZone: Asia/Tokyo` の設定を戻す)

```powershell
PS C:\Users\Yoshiki\projects\gas-badminton-scheduler> Move-Item appsscript.json.bak appsscript.json -Force
```

7. 復元後の `appsscript.json` を確認(`timeZone` などが残っているか)

```powershell
PS C:\Users\Yoshiki\projects\gas-badminton-scheduler> Get-Content appsscript.json
```

期待される表示:

```json
{
  "timeZone": "Asia/Tokyo",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8"
}
```

### 8-4. 生成されたファイルの説明

| ファイル | 役割 |
|:--|:--|
| `.clasp.json` | このローカルフォルダがどの GAS プロジェクトに紐づいているかを記録(スクリプト ID を含む)。`.gitignore` で Git 除外済み |
| `appsscript.json` | GAS の動作設定(タイムゾーン等)。詳細は `appsscript.json.md` 参照 |

### ✅ Step 8 完了チェック

- [ ] `.clasp.json` がプロジェクト直下に存在する
- [ ] `appsscript.json` が `timeZone: Asia/Tokyo` を含む内容で残っている

<details>
<summary>💥 よくあるエラーと対処</summary>

- **「Could not read API credentials. Are you logged in?」** → Step 7 の `clasp login` が完了していない。再度 `clasp login` を実行
- **「ScriptId not found」** → スクリプト ID をコピペし間違えている。Step 4 のメモを再確認、または GAS プロジェクトの URL から再取得
- **「Project file (.clasp.json) already exists」** → 既に clone 済み。`.clasp.json` を一度削除してから再実行(または上書きでも OK の確認)
- **「appsscript.json が上書きされてしまった」** → バックアップ(`appsscript.json.bak`)を復元、またはこの手順書 8-3 の最終的な内容を手で書き直す

</details>

---

## Step 9: 初回テストプッシュ(疎通確認)

**所要時間**: 約 10 分

### 9-1. このステップで何をするか

「ローカルで書いたコードが本当に GAS にアップロードされ、GAS 側で実行できる」ことを確認します。
これが Phase 0 の最終ゴールです。

### 9-2. 手順

1. プロジェクトの `src/` フォルダ内に **テスト用の `Code.js`** を作成

```powershell
PS C:\Users\Yoshiki\projects\gas-badminton-scheduler> New-Item -Path src\Code.js -ItemType File
```

2. VS Code やメモ帳で `src/Code.js` を開き、以下のコードを貼り付けて保存

```javascript
/**
 * Phase 0 疎通確認用のテスト関数
 * GAS エディタで「helloWorld」を実行すると、ログに「こんにちは、GAS!」が出る
 */
function helloWorld() {
  console.log('こんにちは、GAS!');
  console.log('現在時刻: ' + new Date().toString());
  return 'OK';
}
```

3. `clasp push` でアップロード

```powershell
PS C:\Users\Yoshiki\projects\gas-badminton-scheduler> clasp push
```

- 初回は「Manifest file has been updated. Do you want to push and overwrite? (y/N)」と聞かれることがある → `y` を入力して Enter
- 成功すると以下のような表示

```
└─ src/Code.js
└─ appsscript.json
Pushed 2 files.
```

4. GAS エディタを開いて確認

```powershell
PS C:\Users\Yoshiki\projects\gas-badminton-scheduler> clasp open
```

- ブラウザで GAS プロジェクトが開く

5. GAS エディタの左サイドバーに `Code` ファイルが追加されているはず
   - 💡 ローカルの `src/Code.js` が GAS 上では `Code`(`.js` なしの表記)になる
6. エディタ画面の上部、関数選択ドロップダウンで `helloWorld` を選択
7. **「実行」** ボタンをクリック
8. 初回実行時は「承認が必要です」というダイアログが出る → **「権限を確認」** → 自分の Google アカウント選択 →「詳細」→「(プロジェクト名)に移動」→「許可」
9. 実行後、画面下部の「実行ログ」セクションに以下が表示されれば成功

```
こんにちは、GAS!
現在時刻: Sun May 10 2026 12:34:56 GMT+0900 (Japan Standard Time)
```

### 9-3. ローカルからログを見る(オプション)

```powershell
PS C:\Users\Yoshiki\projects\gas-badminton-scheduler> clasp logs
```

- 直近の実行ログがターミナルに出る(ただし反映までに数分のタイムラグあり)

### ✅ Step 9 完了チェック

- [ ] `clasp push` が成功する
- [ ] GAS エディタで `helloWorld` 関数が選択肢に出る
- [ ] `helloWorld` の実行ログに「こんにちは、GAS!」が表示される

<details>
<summary>💥 よくあるエラーと対処</summary>

- **「Push failed. Errors: appsscript.json: ...」** → `appsscript.json` の内容を確認。中身が空 or JSON 構文エラーの可能性
- **「実行ボタンを押しても関数が選択肢に出ない」** → `clasp push` が成功しているか確認 → ブラウザを再読込(F5)
- **「権限ダイアログで『このアプリは Google で確認されていません』警告」** → 自分が作ったプロジェクトなので問題なし。「詳細」→「(プロジェクト名)に移動」→「許可」で OK
- **「PowerShell で `;` 区切りができない」** → コマンドは 1 行 1 コマンドで個別に実行。`&&` は PowerShell では使えません(バッシュとは違う)

</details>

---

## Step 10: Phase 0 完了確認チェックリスト

**所要時間**: 約 5 分

ここまでの作業がすべて完了していることを確認してください。
**1 つでも未達があれば、その Step に戻って完了させてから Phase 1 に進んでください。**

### 10-1. LINE 側

- [ ] LINE Developers にログインできる
- [ ] プロバイダーが 1 つ作成されている
- [ ] Messaging API チャネルが作成されている
- [ ] チャネル ID をメモした(機密保管)
- [ ] チャネルシークレットをメモした(機密保管)
- [ ] チャネルアクセストークンを発行・メモした(機密保管)
- [ ] Bot Basic ID(`@xxxxxxxx`)をメモした
- [ ] LINE Official Account Manager で:
  - [ ] 応答モードが「Bot」
  - [ ] あいさつメッセージ OFF
  - [ ] 応答メッセージ OFF
  - [ ] Webhook ON
- [ ] QR コードまたは追加用 URL を取得した

### 10-2. Google 側

- [ ] GAS プロジェクト `gas-badminton-scheduler` が作成されている
- [ ] スクリプト ID をメモした

### 10-3. ローカル PC 側

- [ ] Node.js v18 以上がインストールされている(`node --version` で確認)
- [ ] npm が動作する(`npm --version` で確認)
- [ ] clasp がインストールされている(`clasp --version` で確認)
- [ ] `clasp login` が完了している
- [ ] `C:\Users\Yoshiki\projects\gas-badminton-scheduler\` 配下に以下が存在
  - [ ] `.clasp.json`(スクリプト ID 紐付け・Git 除外済み)
  - [ ] `appsscript.json`(timeZone Asia/Tokyo 含む)
  - [ ] `src/Code.js`(helloWorld 関数あり)
  - [ ] `package.json`、`README.md`、`.gitignore`、`REQUIREMENTS.md` など

### 10-4. 疎通確認

- [ ] `clasp push` が成功した
- [ ] GAS エディタで `helloWorld` 関数を実行し、ログに「こんにちは、GAS!」が表示された

### 10-5. ✨ すべてチェックがついたら

→ **Phase 1(MVP 開発)に進める状態** です。

次のアクションとして、`dev-orchestrator-ja` に Phase 1 着手を依頼するときは以下のような依頼文がスムーズです。

```
Phase 0 のセットアップが完了しました。Phase 1(MVP)着手をお願いします。
- LINE Messaging API の認証情報は手元のメモにあります(チャネルアクセストークン等)
- GAS プロジェクト + clasp + ローカルディレクトリは完備
- src/Code.js には helloWorld の疎通確認コードのみ
- まずは REQUIREMENTS.md §3-1 の F-1-1(メンバー自動登録機能)から着手してください
```

---

## 改訂履歴

- **v1.0**(2026-05-10): 初版作成。dev-orchestrator-ja(Tier 1)が developer-ja の役割を兼任し、REQUIREMENTS.md v0.2 / DECISION_NOTES.md v0.1 を踏まえて起草。
