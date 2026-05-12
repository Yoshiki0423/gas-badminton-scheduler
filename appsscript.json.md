# `appsscript.json` の役割と各項目の意味

このメモは、隣にある `appsscript.json` の各項目が何を意味するかを解説するものです。
JSON ファイルにはコメントを書けないため、別ファイルとして併設しています。

---

## このファイルは何か

`appsscript.json` は **GAS(Google Apps Script)プロジェクトの設定書** です。
GAS の動作モードや、使う外部サービス、タイムゾーンなどを定義します。

GAS エディタの画面上では「プロジェクトの設定」→「`appsscript.json` マニフェスト ファイルを表示する」を ON にすると、Web 画面でも見えるようになります。

`clasp push` でこのファイルをアップロードすると、GAS 側の設定が上書きされます。

---

## 各項目の意味

### `timeZone`: `"Asia/Tokyo"`

スクリプトが扱う **タイムゾーン(時間帯)** を指定します。
日本国内向けのツールなので `Asia/Tokyo`(=日本標準時 JST)を指定。
これを忘れると、日付処理が UTC(協定世界時)になり、9 時間ズレた日付で動作します。

### `dependencies`: `{}`(空)

外部の GAS ライブラリやサービスを使うときに、ここに依存関係を書きます。
今は何も使っていないので空。Phase 1 で必要が出てきたら追記します。

(例: 後で「Cheerio 風ライブラリ」を使う場合は `libraries` セクションが追加されます)

### `exceptionLogging`: `"STACKDRIVER"`

エラー(例外)を **Google Cloud Logging(旧 Stackdriver)** に飛ばす設定です。
GAS エディタの「実行数」「ログ」画面でエラーの詳細が見られるようになります。
`NONE` にするとエラーが追跡できなくなるため、必ず `STACKDRIVER` を指定。

### `runtimeVersion`: `"V8"`

スクリプトの実行エンジンを **V8(モダンな JavaScript エンジン)** に指定。
古い「Rhino」エンジンだと、`let` / `const` / アロー関数(`=>`)など現代的な書き方が使えません。
新規プロジェクトは必ず `V8` で始めるのが定石です。

---

## 触ってよいか?

Phase 0 段階では **このファイルを直接編集する必要はありません**。
Phase 1 以降で「タイマートリガー(`triggers`)」「ウェブアプリ公開設定(`webapp`)」「OAuth スコープ(`oauthScopes`)」などを追加する場合に、開発者(または dev-orchestrator-ja の指示)が編集します。

---

## 参考

- 公式リファレンス: https://developers.google.com/apps-script/manifest
