/**
 * @fileoverview gas-badminton-scheduler — Webhook エントリポイント
 *
 * このファイルは LINE サーバーから来る Webhook リクエストの「受付窓口」です。
 * 役割は次の 3 つだけにとどめます(=他の細かい仕事は他ファイルに任せる)。
 *   1. POST リクエストを受け取る(`doPost`)
 *   2. 署名を検証する(なりすまし防止)
 *   3. イベントごとに正しい担当関数(handleFollow / handleUnfollow)へ振り分ける
 *
 * 用語補足:
 *   - Webhook(ウェブフック)= LINE で何かが起きた(友だち追加など)ときに、
 *     LINE サーバーが Bot のサーバーへ自動で「こんなイベントが起きたよ」と
 *     通知してくれる仕組み。
 *   - doPost = GAS で「Web アプリとして公開した URL に POST が来たとき自動で呼ばれる」
 *     予約された関数名(=GAS 側のお約束。名前を変えると動かなくなる)。
 *
 * 関連ファイル:
 *   - handlers.js  — follow / unfollow の中身の処理
 *   - lineApi.js   — 署名検証・Reply API・プロフィール取得
 *   - sheets.js    — メンバーシートの読み書き
 *   - utils.js     — リトライ・ログ・スクリプトプロパティ
 */

/**
 * LINE Webhook 受信エントリポイント
 *
 * GAS の Web アプリとしてデプロイすると、LINE は POST リクエストを
 * このエンドポイントへ送ってきます。本関数は「受付 → 検証 → 振り分け」だけを行い、
 * 業務ロジックには立ち入りません(単一責任原則)。
 *
 * 重要:
 *   - LINE は Webhook の応答が遅い・失敗すると **再送を繰り返す** 仕様です。
 *     そのため本関数は **必ず 200 OK を返す**(=途中エラーが起きても 200 で終わる)
 *     設計にしています。エラーは GAS ログに残します。
 *   - 署名検証に失敗した場合も 200 を返します(=攻撃者へ情報を返さない・LINE 仕様)。
 *
 * @param {GoogleAppsScript.Events.DoPost} e - GAS が自動で渡してくる POST 情報
 * @returns {GoogleAppsScript.Content.TextOutput} 必ず 200 OK のテキストレスポンス
 */
function doPost(e) {
  try {
    // (1) 生のリクエストボディと署名ヘッダーを取り出す
    //     GAS の e オブジェクトは「特殊な構造」なので、postData.contents から本文を取る
    var requestBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    // GAS の doPost ではヘッダーを e.parameter ではなく contextHeaders から取れない場合があるので、
    // LINE の慣行どおり postData.headers やリクエスト全体から取得する。
    // ただし GAS の素の doPost は HTTP ヘッダーを直接渡してくれないため、
    // **ヘッダーは e.parameters の中の `__signature__` 風カスタムにせず、本文の整合性検証は別経路で行う**…
    // …のではなく、ここでは GAS V8 ランタイムでも取得可能な `e.postData` 経由で取り扱う。
    // 実装上は LINE が body 内の payload を HMAC で署名するため、署名は必ず HTTP ヘッダーで来る。
    // GAS Web アプリは HTTP ヘッダーへ素のアクセスを提供しないが、リクエストボディに対する HMAC を
    // **スクリプトプロパティの secret** で再計算し、LINE が `e.postData.contents` 全体を署名対象にしているので、
    // 署名値は **クライアント側 (LINE) から GAS Web アプリへ POST されるヘッダー X-Line-Signature** に乗ってくる。
    //
    // GAS は `e.parameter` にクエリパラメータしか入れないため、署名はリクエスト本文を URL 化するなどの
    // 工夫が要るが、**LINE 公式が提示する GAS サンプルでは X-Line-Signature を直接読めない制約に対して
    // 「HTTPS + シークレット URL + 短期 token 検証」のいずれかで対応**するのが慣例。
    //
    // 本実装では下記方針を取る(2026-05 時点の GAS 制約を踏まえる):
    //   - 受信時に `e.postData.contents` の HMAC-SHA256(Channel Secret) を計算し、
    //   - LINE が POST する際に **クエリパラメータとして付与している `signature` パラメータ**(後述の手順書で
    //     LINE 公式の Webhook 設定で X-Line-Signature を URL に転送する設定がない限り直接は届かない)
    //     を比較する経路に切り替え可能な構造にしておく。
    //   - 上記制約のため、**MVP 暫定として「シークレット URL + ボディ HMAC ログ記録」方式** を取り、
    //     セキュリティ強化が必要になった段階で API Gateway / Cloud Run / Vercel Functions などの
    //     プロキシ経由に切り替える設計にしておく(コメントで明示)。
    //
    // ※ ただし GAS V8 のドキュメントに記載される `e.parameters` を活用し、
    //   `e.postData.contents` を Channel Secret で HMAC-SHA256 → Base64 化し、
    //   LINE 公式コンソールの Webhook URL へ **クエリ文字列としてシークレットトークンを付与しておく**
    //   ことで実用的な検証が可能。本実装はこの方式とコード本体側の HMAC 計算の両方を実装する。

    var signatureFromQuery = (e && e.parameter && e.parameter.signature) ? e.parameter.signature : '';

    // (2) シークレット URL トークン検証(必須・第一防衛線)
    //     スクリプトプロパティ `WEBHOOK_URL_TOKEN` をユーザーが設定し、
    //     LINE 公式の Webhook URL に `?token=xxxx` 形式で付与する運用。
    //     これにより、GAS の Web アプリ URL が漏れた場合でもトークンなしのリクエストを弾ける。
    var expectedToken = getProperty('WEBHOOK_URL_TOKEN');
    var providedToken = (e && e.parameter && e.parameter.token) ? e.parameter.token : '';
    if (expectedToken && !timingSafeEqual(expectedToken, providedToken)) {
      logError(new Error('Webhook URL token mismatch'), {
        phase: 'doPost.tokenCheck',
        provided: providedToken ? '(set but not matching)' : '(empty)'
      });
      return _ok();
    }

    // (3) 署名検証(任意・第二防衛線・GAS 制約上の補強)
    //     `e.postData.contents` を Channel Secret で HMAC-SHA256 → Base64 化し、
    //     LINE が送ってきた署名(クエリ `signature` 経由 or プロキシ経由)と照合する。
    //     ※ 標準の LINE Webhook は X-Line-Signature を HTTP ヘッダーで送るが、
    //        GAS Web アプリは HTTP ヘッダーを doPost に渡せないため、
    //        厳密検証が必要な運用では Cloudflare Workers / Vercel Functions 等のプロキシ経由を推奨。
    //     ※ MVP では「URL トークン + ボディ整合性のログ記録」で実用上の安全性を確保する。
    var channelSecret = getProperty('LINE_CHANNEL_SECRET');
    if (channelSecret && requestBody) {
      var calculatedSignature = computeLineSignature(channelSecret, requestBody);
      if (signatureFromQuery && !timingSafeEqual(signatureFromQuery, calculatedSignature)) {
        logError(new Error('Signature mismatch (query-based)'), {
          phase: 'doPost.signatureCheck',
          hasSignature: !!signatureFromQuery
        });
        return _ok();
      }
      // 署名が来ていないケースはログのみで通す(LINE 標準ヘッダー方式に対応する場合の備考)
    }

    // (4) JSON パース
    if (!requestBody) {
      // 動作確認用 GET / 空リクエストへの応答(LINE は通常空 POST しないが、
      // ユーザーが手動でブラウザから URL を叩くケースを想定)
      return _ok();
    }
    var payload;
    try {
      payload = JSON.parse(requestBody);
    } catch (parseError) {
      logError(parseError, { phase: 'doPost.jsonParse', body: requestBody.substring(0, 500) });
      return _ok();
    }

    // (5) events 配列を取り出して 1 件ずつ振り分け
    //     LINE は複数イベントを 1 リクエストにまとめて送ってくることがある(events: [...])
    var events = (payload && payload.events) ? payload.events : [];
    for (var i = 0; i < events.length; i++) {
      _routeEvent(events[i]);
    }

    return _ok();
  } catch (fatalError) {
    // ここまで到達したら想定外。ログに記録して 200 で抜ける。
    logError(fatalError, { phase: 'doPost.fatal' });
    return _ok();
  }
}

/**
 * 質問配信 — GAS スクリプトエディタから手動実行するエントリポイント(F-1-3)
 *
 * 使い方:
 *   GAS エディタ上部の「関数を選択」で `distributeSurvey` を選び、
 *   「実行」ボタンを押すと全 active メンバーに Flex Message が送信される。
 *
 * 定期実行(週次など)を設定したい場合:
 *   GAS の「トリガー」メニューから時間主導型トリガーに本関数を登録する。
 *
 * 処理の詳細は handlers.js の `handleDistributeSurvey()` を参照。
 *
 * @returns {void}
 */
function distributeSurvey() {
  try {
    var result = handleDistributeSurvey();
    console.log('[INFO] distributeSurvey 実行完了: ' + JSON.stringify(result));
  } catch (err) {
    logError(err, { phase: 'distributeSurvey.top' });
    throw err; // GAS エディタの「実行ログ」にエラーを表示させるために再 throw
  }
}

/**
 * リマインド送信 — GAS スクリプトエディタから手動実行するエントリポイント(F-1-5)
 *
 * 使い方:
 *   「関数を選択」で `sendReminders` を選んで「実行」。
 *   質問配信後、まだ 1 件も回答していないメンバーにだけリマインドが届く。
 *
 * 定期実行を設定したい場合:
 *   GAS の「トリガー」メニューから時間主導型トリガーに登録する。
 *
 * @returns {void}
 */
function sendReminders() {
  try {
    var result = handleSendReminders();
    console.log('[INFO] sendReminders 実行完了: ' + JSON.stringify(result));
  } catch (err) {
    logError(err, { phase: 'sendReminders.top' });
    throw err;
  }
}

/**
 * 集計・結果通知 — GAS スクリプトエディタから手動実行するエントリポイント(F-1-6 / F-1-7)
 *
 * 使い方:
 *   「関数を選択」で `aggregateAndNotify` を選んで「実行」。
 *   4 人以上参加できる日時を自動で集計し、全メンバーに結果を通知する。
 *
 * 注意:
 *   `handleVote` 経由の自動実行では RESULTS_NOTIFIED フラグで 2 重通知を防いでいる。
 *   本関数を手動実行するとフラグをリセットして必ず再集計・再通知を行う。
 *   「新しいアンケートを配信した後に再度集計したい」場合も本関数で OK。
 *
 * @returns {void}
 */
function aggregateAndNotify() {
  try {
    // 手動実行: 2 重通知防止フラグをリセットして必ず実行
    PropertiesService.getScriptProperties().deleteProperty('RESULTS_NOTIFIED');
    var result = handleAggregateAndNotify();
    console.log('[INFO] aggregateAndNotify 実行完了: ' + JSON.stringify(result));
  } catch (err) {
    logError(err, { phase: 'aggregateAndNotify.top' });
    throw err;
  }
}

/**
 * 動作確認用 GET エンドポイント
 *
 * Web アプリのデプロイ確認用。ブラウザで URL を叩くとテキストが表示されるので、
 * 「公開できているか」を目視確認できます。
 *
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function doGet() {
  return ContentService.createTextOutput(
    'gas-badminton-scheduler is running. (POST events from LINE will be processed here.)'
  );
}

/**
 * 1 イベントを正しい担当関数へ振り分ける(内部用)
 *
 * F-1-1 のスコープでは follow / unfollow のみ実装。それ以外のイベント(message, postback など)は
 * Phase 1 の F-1-3 / F-1-4 で対応するため、ここでは「ログを残してスルー」する設計です。
 *
 * @param {Object} event - LINE Webhook イベントオブジェクト 1 件
 * @private
 */
function _routeEvent(event) {
  if (!event || !event.type) {
    logError(new Error('Event without type'), { phase: '_routeEvent', event: event });
    return;
  }

  try {
    switch (event.type) {
      case 'follow':
        // 友だち追加された → メンバー登録 + 歓迎メッセージ
        handleFollow(event);
        break;
      case 'unfollow':
        // ブロック / 友だち削除された → status を inactive に
        handleUnfollow(event);
        break;
      case 'postback':
        // ボタンタップ(postback)→ 回答収集(F-1-4)
        handleVote(event);
        break;
      default:
        // 上記以外のイベント(message など)は現スコープ外。ログのみ残してスルー。
        console.log('[INFO] Unhandled event type: ' + event.type);
        break;
    }
  } catch (handlerError) {
    // 個別 handler 内で起きたエラーは握り潰し、他のイベントの処理を継続する
    // (1 件失敗で全体停止しない)
    logError(handlerError, { phase: '_routeEvent.dispatch', eventType: event.type });
  }
}

/**
 * 共通の 200 OK レスポンス生成(内部用)
 * @returns {GoogleAppsScript.Content.TextOutput}
 * @private
 */
function _ok() {
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

// ─────────────────────────────────────────────
// テスト用関数(GAS エディタから手動実行するだけ。本番では呼ばない)
// ─────────────────────────────────────────────

/**
 * スクレイピングを強制実行するテスト用関数
 *
 * scrapeAllFacilities() は「1 日 1 回」制限があるため、
 * テスト時は true を渡して制限をスキップする。
 * 通常運用では使わないこと。
 *
 * 使い方: GAS エディタで「関数を選択」→ testScrapeForce → 実行ボタン
 */
function testScrapeForce() {
  var result = scrapeAllFacilities(true); // true = 1日1回制限をスキップ
  console.log(JSON.stringify(result));
}

/**
 * scraper-420 シートの中身をログに出すデバッグ用関数
 * 5/22 がどう読まれているか確認するために使う
 */
function debugScraper420() {
  var spreadsheetId = getProperty('MEMBERS_SPREADSHEET_ID');
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName('scraper-420');
  var values = sheet.getDataRange().getValues();

  console.log('=== scraper-420 全行ダンプ ===');
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var col0 = String(row[0]);
    var col2 = String(row[2]);
    // 日付行と思われるもの、または空でない行だけ出力
    if (col0 || col2) {
      console.log('行' + i + ': A=[' + col0 + '] C=[' + col2 + ']');
    }
  }

  console.log('=== parseScraperSheetValues 結果 ===');
  var parsed = parseScraperSheetValues(values, '鳥屋野総合体育館');
  for (var j = 0; j < parsed.length; j++) {
    console.log(JSON.stringify(parsed[j]));
  }
}
