/**
 * @fileoverview gas-badminton-scheduler — Webhook エントリポイント / LIFF ルーター
 *
 * このファイルは LINE サーバーから来る Webhook リクエストの「受付窓口」と、
 * LIFF(LINE アプリ内ブラウザ)から来るページリクエストのルーターを担当します。
 * 役割は次の 4 つだけにとどめます(=他の細かい仕事は他ファイルに任せる)。
 *   1. POST リクエストを受け取る(`doPost`)
 *   2. 署名を検証する(なりすまし防止)
 *   3. イベントごとに正しい担当関数(handleFollow / handleUnfollow 等)へ振り分ける
 *   4. GET リクエストを受け取り、LIFF ページ(HTML)を返す(`doGet` / F-3)
 *
 * 用語補足:
 *   - Webhook(ウェブフック)= LINE で何かが起きた(友だち追加など)ときに、
 *     LINE サーバーが Bot のサーバーへ自動で「こんなイベントが起きたよ」と
 *     通知してくれる仕組み。
 *   - doPost = GAS で「Web アプリとして公開した URL に POST が来たとき自動で呼ばれる」
 *     予約された関数名(=GAS 側のお約束。名前を変えると動かなくなる)。
 *   - doGet = GAS で「Web アプリの URL に GET が来たとき自動で呼ばれる」
 *     予約された関数名。LIFF ページ配信に使う。
 *   - LIFF(リフ) = LINE Internal Front-end Framework の略。
 *     LINE アプリ内で Web ページを開く仕組み。
 *     このプロジェクトでは回答フォームと回答状況確認ページを LIFF で提供する。
 *
 * 関連ファイル:
 *   - handlers.js  — follow / unfollow / LIFF ハンドラーの中身の処理
 *   - lineApi.js   — 署名検証・Reply API・プロフィール取得・ID Token 検証
 *   - sheets.js    — メンバーシートの読み書き
 *   - utils.js     — リトライ・ログ・スクリプトプロパティ
 *   - liff.html    — LIFF 回答フォーム(F-3-4)
 *   - liffResults.html — LIFF 回答状況確認ページ(F-3-5)
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
    var requestBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    var signatureFromQuery = (e && e.parameter && e.parameter.signature) ? e.parameter.signature : '';

    // (1) シークレット URL トークン検証(必須・第一防衛線)
    var expectedToken = getProperty('WEBHOOK_URL_TOKEN');
    var providedToken = (e && e.parameter && e.parameter.token) ? e.parameter.token : '';
    if (expectedToken && !timingSafeEqual(expectedToken, providedToken)) {
      logError(new Error('Webhook URL token mismatch'), {
        phase: 'doPost.tokenCheck',
        provided: providedToken ? '(set but not matching)' : '(empty)'
      });
      return _ok();
    }

    // (2) 署名検証(任意・第二防衛線・GAS 制約上の補強)
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
    }

    // (3) JSON パース
    if (!requestBody) {
      return _ok();
    }
    var payload;
    try {
      payload = JSON.parse(requestBody);
    } catch (parseError) {
      logError(parseError, { phase: 'doPost.jsonParse', body: requestBody.substring(0, 500) });
      return _ok();
    }

    // (4) events 配列を取り出して 1 件ずつ振り分け
    var events = (payload && payload.events) ? payload.events : [];
    for (var i = 0; i < events.length; i++) {
      _routeEvent(events[i]);
    }

    return _ok();
  } catch (fatalError) {
    logError(fatalError, { phase: 'doPost.fatal' });
    return _ok();
  }
}

/**
 * LIFF ページ配信エントリポイント / 動作確認用 GET エンドポイント(F-3)
 *
 * URL パラメータ `page` の値によって配信するページを切り替えます:
 *   ?page=form    → liff.html(LIFF 回答フォーム・F-3-4)
 *   ?page=results → liffResults.html(LIFF 回答状況確認・F-3-5)
 *   それ以外      → ヘルスチェック用テキスト(後方互換)
 *
 * 用語補足:
 *   XFrameOptionsMode.ALLOWALL = iframe の中で表示することを許可する設定。
 *   LINE アプリが LIFF ページを表示する際は iframe を使うため、この設定が必須です。
 *
 * @param {GoogleAppsScript.Events.DoGet} e - GAS が自動で渡してくる GET 情報
 * @returns {GoogleAppsScript.HTML.HtmlOutput | GoogleAppsScript.Content.TextOutput}
 */
function doGet(e) {
  // GitHub Pages の LIFF ページから呼ばれる JSON API(F-3-4 / F-3-5)
  var liffAction = (e && e.parameter && e.parameter.liff) ? e.parameter.liff : '';
  if (liffAction) {
    return _handleLiffApi(e, liffAction);
  }

  var page = (e && e.parameter && e.parameter.page) ? e.parameter.page : '';

  if (page === 'form') {
    return _serveLiffFormPage();
  }

  if (page === 'results') {
    return _serveLiffResultsPage();
  }

  // それ以外 → ヘルスチェックテキスト(後方互換)
  return ContentService.createTextOutput(
    'gas-badminton-scheduler is running. (POST events from LINE will be processed here.)'
  );
}

/**
 * LIFF 回答フォームページを配信する(内部用)
 *
 * liff.html を HtmlService のテンプレートとして読み込み、
 * スクリプトプロパティ LIFF_FORM_ID を埋め込んで返す。
 *
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 * @private
 */
function _serveLiffFormPage() {
  var template = HtmlService.createTemplateFromFile('src/liff');
  template.liffId = getProperty('LIFF_FORM_ID') || '';
  return template.evaluate()
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setTitle('日程回答フォーム');
}

/**
 * LIFF 回答状況確認ページを配信する(内部用)
 *
 * liffResults.html を HtmlService のテンプレートとして読み込み、
 * スクリプトプロパティ LIFF_RESULTS_ID を埋め込んで返す。
 *
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 * @private
 */
function _serveLiffResultsPage() {
  var template = HtmlService.createTemplateFromFile('src/liffResults');
  template.liffId = getProperty('LIFF_RESULTS_ID') || '';
  return template.evaluate()
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setTitle('回答状況確認');
}

// ─────────────────────────────────────────────
// F-3: google.script.run 用サーバー関数
// ─────────────────────────────────────────────
// LIFF の HTML ページ(liff.html / liffResults.html)から
// google.script.run.関数名() という形で呼び出せる関数群。
//
// 用語補足:
//   google.script.run = GAS が自分でホストした HTML ページから
//   GAS サーバー側の関数を呼び出す仕組み。
//   ページに「google.script.run.liffGetSchedulesAndResponses(idToken)」と書くと、
//   このファイルの liffGetSchedulesAndResponses 関数がサーバー側で実行される。
//
// セキュリティ設計:
//   - すべての関数で verifyLineIdToken(idToken) を最初に呼ぶ
//   - 検証失敗(null 返却)なら null を返してクライアントにエラー処理させる
//   - handlers.js の実装関数に処理を委譲し、Code.js はルーティングのみ担当
// ─────────────────────────────────────────────

/**
 * LIFF 回答フォーム用: スケジュール一覧 + このユーザーの前回答を返す(F-3-4 / F-4)
 *
 * liff.html から google.script.run.liffGetSchedulesAndResponses(idToken) で呼ばれる。
 *
 * @param {string} idToken - liff.getIDToken() で取得した ID Token
 * @returns {{ dates: Array, userAnswers: Object } | null}
 *   検証失敗時は null(HTML 側でエラーメッセージを表示する)
 */
function liffGetSchedulesAndResponses(idToken) {
  try {
    var identity = verifyLineIdToken(idToken);
    if (!identity) {
      console.warn('[WARN] liffGetSchedulesAndResponses: ID Token verification failed');
      return null;
    }
    return handleLiffGetData(identity.userId);
  } catch (err) {
    logError(err, { phase: 'liffGetSchedulesAndResponses' });
    return null;
  }
}

/**
 * LIFF 回答フォーム用: 回答を一括送信する(F-3-4 / F-4)
 *
 * liff.html から google.script.run.liffSubmitResponses(idToken, answers) で呼ばれる。
 *
 * @param {string} idToken - liff.getIDToken() で取得した ID Token
 * @param {Object} answers - { 'YYYY-MM-DD|HH:mm': 'can' | 'undecided' } のオブジェクト
 * @returns {{ deleted: number, inserted: number } | null}
 *   検証失敗時は null
 */
function liffSubmitResponses(idToken, answers) {
  try {
    var identity = verifyLineIdToken(idToken);
    if (!identity) {
      console.warn('[WARN] liffSubmitResponses: ID Token verification failed');
      return null;
    }
    var result = handleLiffSubmitFast(identity.userId, answers);
    // F-5: 回答送信後に「4人以上即通知」チェックを実行する
    _checkAndNotifyViableSlots();
    return result;
  } catch (err) {
    logError(err, { phase: 'liffSubmitResponses' });
    return null;
  }
}

/**
 * LIFF 回答状況確認ページ用: 全員の回答状況を返す(F-3-5 / F-4)
 *
 * liffResults.html から google.script.run.liffGetAllResponses(idToken) で呼ばれる。
 *
 * @param {string} idToken - liff.getIDToken() で取得した ID Token
 * @returns {{ dates: Array, responses: Object } | null}
 *   検証失敗時は null
 */
function liffGetAllResponses(idToken) {
  try {
    var identity = verifyLineIdToken(idToken);
    if (!identity) {
      console.warn('[WARN] liffGetAllResponses: ID Token verification failed');
      return null;
    }
    // handleLiffGetAllResponses はユーザー固有のデータを使わないが、
    // 認証チェックのためにログインを要求する(未認証ユーザーに全員の回答を見せない)
    return handleLiffGetAllResponses();
  } catch (err) {
    logError(err, { phase: 'liffGetAllResponses' });
    return null;
  }
}

// ─────────────────────────────────────────────
// GAS スクリプトエディタから手動実行するエントリポイント群
// ─────────────────────────────────────────────

/**
 * 質問配信 — GAS スクリプトエディタから手動実行するエントリポイント(F-1-3)
 *
 * 使い方:
 *   GAS エディタ上部の「関数を選択」で `distributeSurvey` を選び、
 *   「実行」ボタンを押すとグループトークに Flex Message が送信される。
 *
 * @returns {void}
 */
function distributeSurvey() {
  try {
    var result = handleDistributeSurvey();
    console.log('[INFO] distributeSurvey 実行完了: ' + JSON.stringify(result));
  } catch (err) {
    logError(err, { phase: 'distributeSurvey.top' });
    throw err;
  }
}

/**
 * リマインド送信 — GAS スクリプトエディタから手動実行するエントリポイント(F-1-5)
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
 * @returns {void}
 */
function aggregateAndNotify() {
  try {
    PropertiesService.getScriptProperties().deleteProperty('RESULTS_NOTIFIED');
    var result = handleAggregateAndNotify();
    console.log('[INFO] aggregateAndNotify 実行完了: ' + JSON.stringify(result));
  } catch (err) {
    logError(err, { phase: 'aggregateAndNotify.top' });
    throw err;
  }
}

/**
 * responses シートを F-4 新データモデルにリセットする(手動実行用)
 *
 * F-4 移行時に GAS エディタから 1 回だけ実行してください。
 * 既存の responses シートのデータ(旧形式・テスト用)をすべて削除し、
 * 新しい列構造(responseId / userId / date / slotStart / answer / createdAt / updatedAt)で
 * シートを作り直します。
 *
 * 注意: 実行すると responses シートの中身がすべて消えます。
 *
 * @returns {void}
 */
function resetResponsesSheetForF4() {
  resetResponsesSheet();
  console.log('[INFO] responses シートをリセットしました（F-4 移行）');
}

/**
 * 1 イベントを正しい担当関数へ振り分ける(内部用)
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
        handleFollow(event);
        break;
      case 'unfollow':
        handleUnfollow(event);
        break;
      case 'message':
        handleTextMessage(event);
        break;
      case 'join':
        // F-5: Bot がグループに招待されたときにグループ ID を保存する
        handleJoin(event);
        break;
      case 'memberJoined':
        // F-5: グループに新メンバーが参加したときに自動登録する
        handleMemberJoined(event);
        break;
      default:
        console.log('[INFO] Unhandled event type: ' + event.type);
        break;
    }
  } catch (handlerError) {
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
// F-3: GitHub Pages LIFF 用 JSON API
// ─────────────────────────────────────────────

/**
 * GitHub Pages からの LIFF API リクエストを処理する(内部用)
 *
 * GET パラメータ:
 *   liff=getSchedules   → スケジュール一覧 + このユーザーの前回答を返す(F-4 グリッド形式)
 *   liff=getAllResponses → 全員の回答状況を返す(F-4 形式)
 *   liff=submit         → answers パラメータの回答を保存する
 *   idToken             → LIFF の ID Token(全アクションで必須)
 *   answers             → JSON 文字列 { 'YYYY-MM-DD|HH:mm': 'can'|'undecided' }(submit のみ)
 *
 * @param {Object} e - doGet のイベントオブジェクト
 * @param {string} action - liff パラメータの値
 * @returns {GoogleAppsScript.Content.TextOutput} JSON レスポンス
 */
function _handleLiffApi(e, action) {
  try {
    var idToken = (e && e.parameter && e.parameter.idToken) ? e.parameter.idToken : '';
    if (!idToken) {
      return _jsonResponse({ ok: false, error: 'idToken is required' });
    }

    var identity = verifyLineIdToken(idToken);
    if (!identity) {
      console.warn('[WARN] _handleLiffApi: ID Token verification failed. action=' + action);
      return _jsonResponse({ ok: false, error: 'auth_failed' });
    }

    if (action === 'getSchedules') {
      var scheduleData = handleLiffGetData(identity.userId);
      return _jsonResponse({ ok: true, data: scheduleData });
    }

    if (action === 'getAllResponses') {
      var allResponseData = handleLiffGetAllResponses();
      return _jsonResponse({ ok: true, data: allResponseData });
    }

    if (action === 'submit') {
      var answersParam = (e && e.parameter && e.parameter.answers) ? e.parameter.answers : '{}';
      var answers;
      try {
        answers = JSON.parse(answersParam);
      } catch (parseErr) {
        return _jsonResponse({ ok: false, error: 'invalid answers JSON' });
      }
      var result = handleLiffSubmitFast(identity.userId, answers);
      // F-5: 回答送信後に「4人以上即通知」チェックを実行する
      _checkAndNotifyViableSlots();
      return _jsonResponse({ ok: true, data: result });
    }

    return _jsonResponse({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    logError(err, { phase: '_handleLiffApi', action: action });
    return _jsonResponse({ ok: false, error: 'server error' });
  }
}

/**
 * JSON レスポンスを生成する(内部用)
 * GitHub Pages からの fetch() は CORS なしで GAS JSON を受け取れる。
 *
 * @param {Object} obj
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function _jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────
// テスト用関数(GAS エディタから手動実行するだけ。本番では呼ばない)
// ─────────────────────────────────────────────

/**
 * スクレイピングを強制実行するテスト用関数
 */
function testScrapeForce() {
  var result = scrapeAllFacilities(true);
  console.log(JSON.stringify(result));
}

/**
 * scraper-420 シートの中身をログに出すデバッグ用関数
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
