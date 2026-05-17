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
 *   - handlers.js  — follow / unfollow / LIFF / postback ハンドラーの中身の処理
 *   - lineApi.js   — 署名検証・Reply API・プロフィール取得・ID Token 検証
 *   - sheets.js    — メンバーシート / reserve-queue シートの読み書き
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

    // JSON を先にパース（LIFF POST と LINE Webhook を識別するため）
    var payload = null;
    if (requestBody) {
      try { payload = JSON.parse(requestBody); } catch (_) {}
    }

    // (1-a) LIFF POST API: WEBHOOK_URL_TOKEN チェックより前に分岐
    //        LIFF リクエストは ID Token で認証するため URL トークン不要
    if (payload && payload.liff) {
      var liffPostResponse = _handleLiffPostApi(payload);
      if (liffPostResponse) return liffPostResponse;
    }

    // (1) シークレット URL トークン検証(LINE Webhook 専用・第一防衛線)
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

    // (3) JSON パース済み。空ボディまたはパース失敗なら終了
    if (!requestBody || !payload) {
      return _ok();
    }

    // (4) events 配列を取り出して 1 件ずつ振り分け(LINE Webhook)
    var events = payload.events || [];
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

  if (page === 'reserve') {
    return _serveLiffReservePage();
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

/**
 * LIFF 予約ページを配信する(内部用・F-6 LIFF方式)
 *
 * liff/reserve.html を HtmlService のテンプレートとして読み込み、
 * スクリプトプロパティ LIFF_RESERVE_ID と GAS_WEB_APP_URL を埋め込んで返す。
 *
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 * @private
 */
function _serveLiffReservePage() {
  var template = HtmlService.createTemplateFromFile('liff/reserve');
  template.liffId    = getProperty('LIFF_RESERVE_ID')  || '';
  template.gasApiUrl = getProperty('GAS_WEB_APP_URL')  || '';
  return template.evaluate()
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setTitle('コート予約');
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
 * responses シートを F-4 新データモデルにリセットする(手動実行用・F-4 移行時に実施済み)
 *
 * F-4 移行時に 1 回だけ実行した関数です。現在は通常使いません。
 * もし responses シートを初期状態に戻したい場合のみ GAS エディタから実行してください。
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
 * F-6 変更点: postback は LIFF方式移行により handlePostback がスタブ化されている。
 *   実際の予約フローは LIFF ページ経由の handleLiffReserve* 関数群で完結する。
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
      case 'postback':
        // F-6: 「予約する」ボタンなどの postback アクションを処理する
        handlePostback(event);
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
 * LIFF API リクエストを処理する(内部用)
 *
 * GET パラメータ:
 *   liff=getSchedules      → スケジュール一覧 + このユーザーの前回答を返す(F-4 グリッド形式)
 *   liff=getAllResponses    → 全員の回答状況を返す(F-4 形式)
 *   liff=submit            → answers パラメータの回答を保存する
 *   liff=reserveGetData    → 予約LIFF用: 初期データ取得(slotKey 必須・F-6 LIFF方式)
 *   liff=reserveScanCourts → 予約LIFF用: コートスキャン(slotKey + courseGroupId 必須・F-6 LIFF方式)
 *   idToken                → LIFF の ID Token(全アクションで必須)
 *   slotKey                → 'YYYY-MM-DD|HH:mm' 形式(reserveGetData / reserveScanCourts で必須)
 *   courseGroupId          → スキャン対象(reserveScanCourts のみ)
 *   answers                → JSON 文字列 { 'YYYY-MM-DD|HH:mm': 'can'|'undecided' }(submit のみ)
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

    // ── F-6 LIFF方式: 予約用 GET API ──

    if (action === 'reserveGetData') {
      // slotKey は URL パラメータで渡す(LIFF ページが開いた時点で呼ぶ)
      // userId は検証済み identity から取得する(§14-11 IDOR対策)
      var rdSlotKey = (e && e.parameter && e.parameter.slotKey) ? e.parameter.slotKey : '';
      var rdResult = handleLiffReserveGetData(rdSlotKey, identity.userId);
      return _jsonResponse({ ok: rdResult.success !== false, data: rdResult });
    }

    if (action === 'reserveScanCourts') {
      var scSlotKey      = (e && e.parameter && e.parameter.slotKey)      ? e.parameter.slotKey      : '';
      var scCourseGroupId = (e && e.parameter && e.parameter.courseGroupId) ? e.parameter.courseGroupId : '';
      var scResult = handleLiffReserveScanCourts(scSlotKey, scCourseGroupId);
      return _jsonResponse({ ok: scResult.success !== false, data: scResult });
    }

    return _jsonResponse({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    logError(err, { phase: '_handleLiffApi', action: action });
    return _jsonResponse({ ok: false, error: 'server error' });
  }
}

/**
 * LIFF 予約ページからの POST リクエストを処理する(内部用・F-6 LIFF方式)
 *
 * LIFF ページが GAS Web App に対して doPost で送るリクエストを処理する。
 * JSON body に liff フィールドが含まれている場合に呼ばれる。
 *
 * liff=reserveSubmit      → 即時予約実行
 * liff=reserveQueueSubmit → キュー予約登録
 *
 * @param {Object} payload - JSON.parse 済みの doPost body
 * @returns {GoogleAppsScript.Content.TextOutput | null} JSON レスポンス or null(処理しない場合)
 */
function _handleLiffPostApi(payload) {
  var action = (payload && payload.liff) ? payload.liff : '';
  if (!action) return null;

  // ── ID Token 検証（CWE-306 対策）──
  // doGet 側の _handleLiffApi と同様に verifyLineIdToken で必ず認証する。
  // curl 等から任意の slotKey + reserverIndex を POST されても弾けるようにする。
  var idToken = (payload && payload.idToken) ? payload.idToken : '';
  if (!idToken) {
    console.warn('[WARN] _handleLiffPostApi: idToken が指定されていません。action=' + action);
    return _jsonResponse({ ok: false, error: 'idToken is required' });
  }
  var identity = verifyLineIdToken(idToken);
  if (!identity) {
    console.warn('[WARN] _handleLiffPostApi: ID Token verification failed. action=' + action);
    return _jsonResponse({ ok: false, error: 'auth_failed' });
  }
  // ── ここまで ID Token 検証 ──

  try {
    if (action === 'reserveSubmit') {
      // identity.userId を渡して handlers.js 側で lineUserId 照合する(§14-11 IDOR対策)
      var submitResult = handleLiffReserveSubmit(payload, identity.userId);
      return _jsonResponse({ ok: submitResult.success !== false, data: submitResult });
    }

    if (action === 'reserveQueueSubmit') {
      // identity.userId を渡して handlers.js 側で lineUserId 照合する(§14-11 IDOR対策)
      var queueResult = handleLiffReserveQueueSubmit(payload, identity.userId);
      return _jsonResponse({ ok: queueResult.success !== false, data: queueResult });
    }

    return _jsonResponse({ ok: false, error: 'unknown liff POST action: ' + action });
  } catch (err) {
    logError(err, { phase: '_handleLiffPostApi', action: action });
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
// F-6: 予約待ちキュー処理 / トリガー登録
// ─────────────────────────────────────────────

/**
 * 予約待ちキューを処理する — 毎分起動・7:00〜7:10 の窓のみ実処理(F-6 / F-6-9)
 *
 * reserve-queue シートの pending エントリのうち、
 * reservableDate が「今日以前」のものを処理する。
 *
 * F-6-9-1 速度最適化:
 *   setupQueueTrigger() で everyMinutes(1) トリガーを設定しているため、
 *   この関数は毎分呼ばれる。7:00〜7:10 の窓の外なら即 return することで、
 *   余分な処理を最小限に抑える。7:00 ちょうどに起動できれば体育館予約争奪戦で有利になる。
 *   （atHour(7) は 7:00〜8:00 のどこかで起動するため精度が足りなかった）
 *
 * 処理フロー:
 *   1. RESERVE_ENABLED チェック（機能が有効でなければスキップ）
 *   2. 時刻チェック（7:00〜7:10 の窓の外なら即 return）
 *   3. reserve-queue の pending エントリを取得
 *   4. reservableDate <= 今日 のエントリを対象として絞り込む
 *   5. 各エントリで _callScanLambda() を呼んで空きコートを検索
 *   6. 空きコートの courseTimeId を使って _callReserveLambda() で予約実行
 *   7. 成功 → status を 'reserved' に更新 + グループ通知
 *      （楽観的ロックは _callReserveLambda 内で設定される）
 *   8. 失敗 → status を 'failed' に更新 + グループ通知
 *
 * @returns {{ processed: number, succeeded: number, failed: number, skipped: number, reason?: string }}
 */
function processReserveQueue() {
  // RESERVE_ENABLED フラグが 'true' でなければ処理しない
  if (getProperty('RESERVE_ENABLED') !== 'true') {
    console.log('[INFO] processReserveQueue: RESERVE_ENABLED が true でないためスキップします');
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  // F-6-9-1: 7:00〜7:10 の窓の外なら即終了（毎分トリガーのオーバーヘッドを最小化）
  // GAS のタイムゾーンは「スクリプトプロパティ」→「タイムゾーン」で Asia/Tokyo に設定済みの前提。
  // getHours() / getMinutes() はスクリプトのタイムゾーン（Asia/Tokyo）の時刻を返す。
  var now = new Date();
  var jstHour = now.getHours();
  var jstMinute = now.getMinutes();
  if (jstHour !== 7 || jstMinute > 10) {
    console.log('[INFO] processReserveQueue: 処理時間外（' + jstHour + ':' + ('0' + jstMinute).slice(-2) + '）スキップ');
    return { processed: 0, skipped: 0, reason: '処理時間外' };
  }

  var todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var groupId = getProperty('LINE_GROUP_ID');

  var entries = getReserveQueueEntries('pending');
  if (entries.length === 0) {
    console.log('[INFO] processReserveQueue: pending エントリが 0 件です。スキップします。');
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  var processed = 0;
  var succeeded = 0;
  var failed = 0;
  var skipped = 0;

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];

    // reservableDate が今日以前のエントリのみ処理する
    if (entry.reservableDate > todayStr) {
      console.log('[INFO] processReserveQueue: reservableDate 未到来のためスキップ。' +
                  ' id=' + entry.reservationQueueId + ' reservableDate=' + entry.reservableDate);
      skipped++;
      continue;
    }

    processed++;

    // 二重予約防止チェック
    var reservedFlagKey = 'RESERVED_SLOT_' + entry.slotKey;
    var alreadyReserved = getProperty(reservedFlagKey);
    if (alreadyReserved === 'true') {
      console.log('[INFO] processReserveQueue: すでに予約済みフラグあり。status を reserved に更新。' +
                  ' slotKey=' + entry.slotKey);
      updateReserveQueueStatus(entry.reservationQueueId, 'reserved');
      succeeded++;
      continue;
    }

    // スロット情報を分解
    var pipeIdx = entry.slotKey.indexOf('|');
    var useDate   = pipeIdx >= 0 ? entry.slotKey.substring(0, pipeIdx) : entry.slotKey;
    var slotStart = pipeIdx >= 0 ? entry.slotKey.substring(pipeIdx + 1) : '';
    var SLOT_ENDS = {
      '09:00': '11:00', '11:00': '13:00', '13:00': '15:00',
      '15:00': '17:00', '17:00': '19:00', '19:00': '21:00'
    };
    var slotEnd = SLOT_ENDS[slotStart] || '?';

    var weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    var d = new Date(useDate + 'T00:00:00+09:00');
    var m = d.getMonth() + 1;
    var day = d.getDate();
    var w = weekdays[d.getDay()];
    var dateLabel = m + '月' + day + '日(' + w + ')';

    try {
      // ── Step 1: courseGroupId を決定 ──
      // LIFF方式では entry.courseGroupId が直接指定されている場合はそれを使う。
      // 未指定の場合は facilityId から ScriptProperties を参照してフォールバックする。
      var facilityIdStr = String(entry.facilityId);

      var courseGroupIds = [];
      if (entry.courseGroupId && entry.courseGroupId > 0) {
        // LIFF方式: キュー登録時に courseGroupId が指定されている
        courseGroupIds = [entry.courseGroupId];
      } else {
        // 旧方式フォールバック: facilityId から ScriptProperties を参照
        var idPropKey;
        if (facilityIdStr === '420') {
          idPropKey = 'TOYA_COURSE_GROUP_IDS';
        } else if (facilityIdStr === '413') {
          idPropKey = 'HIGASHI_COURSE_GROUP_IDS';
        } else if (facilityIdStr === '429') {
          idPropKey = 'KAMEDA_COURSE_GROUP_IDS';
        } else {
          console.warn('[WARN] processReserveQueue: 未知の facilityId=' + facilityIdStr +
                       ' のためスキップ。id=' + entry.reservationQueueId);
          skipped++;
          processed--;
          continue;
        }
        var idPropVal = getProperty(idPropKey) || '';
        courseGroupIds = idPropVal
          ? idPropVal.split(',').map(function (s) { return parseInt(s.trim(), 10); })
                               .filter(function (n) { return !isNaN(n); })
          : [];
      }

      if (courseGroupIds.length === 0) {
        // ScriptProperties に courseGroupIds が設定されていない → スキップして手動対応を促す
        // pending 状態を維持する（設定後に次回の processReserveQueue 実行で自動リトライされる）
        console.warn('[WARN] processReserveQueue: ' + idPropKey + ' が未設定のためこのエントリはスキップ。' +
                     ' pending 状態を維持します（次回の processReserveQueue 実行時に再試行されます）。' +
                     ' id=' + entry.reservationQueueId);
        if (groupId) {
          try {
            pushText(groupId,
              '⚠️ 自動予約の設定が未完了です。\n' +
              dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
              entry.facilityName + '\n' +
              '管理者: ' + idPropKey + ' を ScriptProperties に設定してください。'
            );
          } catch (pushErr) {
            logError(pushErr, { phase: 'processReserveQueue.push.noGroupIds', slotKey: entry.slotKey });
          }
        }
        // failed にはせず skipped 扱い（設定後に再処理できるよう status は pending のまま）
        skipped++;
        processed--;
        continue;
      }

      // ── Step 2: スキャンして空きコートの courseTimeId を取得 ──
      var scanResult = _callScanLambda(useDate, slotStart, courseGroupIds);

      if (!scanResult || !scanResult.courts || scanResult.courts.length === 0) {
        // 空きコートが見つからなかった
        console.warn('[WARN] processReserveQueue: 空きコートなし。' +
                     ' id=' + entry.reservationQueueId + ' slotKey=' + entry.slotKey);
        updateReserveQueueStatus(entry.reservationQueueId, 'failed');
        failed++;

        if (groupId) {
          try {
            pushText(groupId,
              '❌ 空きコートが見つかりませんでした。（自動予約）\n' +
              dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
              entry.facilityName + '\n' +
              '手動で予約をお試しください。'
            );
          } catch (pushErr) {
            logError(pushErr, { phase: 'processReserveQueue.push.noCourts', slotKey: entry.slotKey });
          }
        }
        continue;
      }

      // ── Step 3: courseTimeId をコート優先順位に基づいて決定 ──
      // LIFF方式では entry.courtPriority1〜3 に優先コート名（文字列）が指定されている。
      // 優先順位に沿って空きコートを選ぶ。全優先コートが埋まっていれば
      // §14-6-3 の仕様通り「全コートが埋まるまで順次試行」を実施する。
      var courts = scanResult.courts;
      var courseTimeId = 0;

      // コート名マップ: courtName → courseTimeId の対応表を作成
      // （courtPriority はコート名文字列で統一。修正4対応）
      var courtNameToTimeId = {};
      for (var cIdx = 0; cIdx < courts.length; cIdx++) {
        courtNameToTimeId[courts[cIdx].courtName] = courts[cIdx].courseTimeId;
      }

      // 優先順位コートを順番に試す（コート名で突合）
      var priorities = [entry.courtPriority1, entry.courtPriority2, entry.courtPriority3];
      var triedCourseTimeIds = {};
      for (var pi = 0; pi < priorities.length; pi++) {
        var pName = String(priorities[pi] || '');
        if (pName && courtNameToTimeId[pName]) {
          courseTimeId = courtNameToTimeId[pName];
          triedCourseTimeIds[String(courseTimeId)] = true;
          break;
        }
      }

      // §14-6-3: 優先コートが全滅でも空きコートが残っている場合は全コートを順次試行する
      // （とにかくコートを確保することを優先する）
      if (!courseTimeId && courts.length > 0) {
        for (var fci = 0; fci < courts.length; fci++) {
          var fcId = String(courts[fci].courseTimeId);
          if (!triedCourseTimeIds[fcId]) {
            courseTimeId = courts[fci].courseTimeId;
            break;
          }
        }
      }

      console.log('[INFO] processReserveQueue: スキャン成功。courseTimeId=' + courseTimeId +
                  ' 空きコート数=' + courts.length +
                  ' id=' + entry.reservationQueueId);

      // ── Step 4: reserver-master から予約者情報を取得 ──
      var reserverInfo = null;
      if (entry.reserverIndex !== null && entry.reserverIndex !== undefined) {
        try {
          var masterEntries = getReserverMasterEntries();
          for (var mi = 0; mi < masterEntries.length; mi++) {
            if (masterEntries[mi].index === entry.reserverIndex) {
              reserverInfo = {
                name:  masterEntries[mi].name,
                tel:   masterEntries[mi].tel,
                email: masterEntries[mi].email
              };
              break;
            }
          }
        } catch (masterErr) {
          console.warn('[WARN] processReserveQueue: reserver-master 取得エラー: ' + masterErr.message);
        }
      }

      // ── Step 5: Lambda 経由で予約実行 ──
      // _callReserveLambda は内部で楽観的ロック（RESERVED_SLOT_* フラグを呼び出し前に 'true' にセット）
      // を設定する。失敗時はフラグを 'false' に戻す。
      var lambdaResult = _callReserveLambda(entry.slotKey, entry.facilityId, courseTimeId, reserverInfo);

      if (lambdaResult && lambdaResult.success) {
        // 予約成功
        updateReserveQueueStatus(entry.reservationQueueId, 'reserved');
        succeeded++;

        if (groupId) {
          try {
            var successMsg = '✅ 予約が完了しました！（自動予約）\n' +
              dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
              entry.facilityName;
            if (reserverInfo && reserverInfo.name) {
              successMsg += '\n予約者: ' + reserverInfo.name;
            }
            pushText(groupId, successMsg);
          } catch (pushErr) {
            logError(pushErr, { phase: 'processReserveQueue.push.success', slotKey: entry.slotKey });
          }
        }
        console.log('[INFO] processReserveQueue: 予約成功 id=' + entry.reservationQueueId +
                    ' slotKey=' + entry.slotKey + ' courseTimeId=' + courseTimeId);

      } else {
        // Lambda が success=false を返した
        var errMsg = (lambdaResult && lambdaResult.message) ? lambdaResult.message : '不明なエラー';
        updateReserveQueueStatus(entry.reservationQueueId, 'failed');
        failed++;

        if (groupId) {
          try {
            pushText(groupId,
              '❌ 自動予約に失敗しました。\n' +
              dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
              entry.facilityName + '\n' +
              '理由: ' + errMsg + '\n' +
              '手動で予約をお試しください。'
            );
          } catch (pushErr) {
            logError(pushErr, { phase: 'processReserveQueue.push.failed', slotKey: entry.slotKey });
          }
        }
        console.warn('[WARN] processReserveQueue: Lambda 失敗 id=' + entry.reservationQueueId +
                     ' message=' + errMsg);
      }

    } catch (err) {
      logError(err, { phase: 'processReserveQueue.lambda', id: entry.reservationQueueId });
      updateReserveQueueStatus(entry.reservationQueueId, 'failed');
      failed++;

      if (groupId) {
        try {
          pushText(groupId,
            '❌ 自動予約中にエラーが発生しました。\n' +
            dateLabel + ' ' + slotStart + '〜' + slotEnd + '\n' +
            entry.facilityName + '\n' +
            '手動で予約をお試しください。'
          );
        } catch (pushErr) {
          logError(pushErr, { phase: 'processReserveQueue.push.error', slotKey: entry.slotKey });
        }
      }
    }
  }

  console.log('[INFO] processReserveQueue 完了: processed=' + processed +
              ' succeeded=' + succeeded + ' failed=' + failed + ' skipped=' + skipped);
  return { processed: processed, succeeded: succeeded, failed: failed, skipped: skipped };
}

/**
 * processReserveQueue を毎分実行するトリガーを設定する(F-6 / F-6-9)
 *
 * F-6-9-1 速度最適化:
 *   従来の atHour(7) トリガーは 7:00〜8:00 のどこかで起動するため精度が足りない。
 *   everyMinutes(1) に変更することで最悪でも 7:01:xx には起動できる。
 *   processReserveQueue() 内の時刻チェック（7:00〜7:10 の窓）で不要な実行を即排除する。
 *
 * 使い方:
 *   GAS エディタの「関数を選択」で setupQueueTrigger を選び「実行」ボタンを押す。
 *   既存の atHour(7) トリガーがある場合は先にトリガー管理画面から手動削除してください。
 *
 * 注意:
 *   everyMinutes(1) トリガーは GAS の実行回数制限を消費する。
 *   processReserveQueue() 内で 7:00〜7:10 以外は即 return するため、
 *   1日あたりの無駄な実行は最大 24×60-10=1430回だが、GAS の無料枠（1日90分）は
 *   各実行がほぼ瞬時に終わるため問題ない（1回あたり数ms程度）。
 *
 * @returns {void}
 */
function setupQueueTrigger() {
  var QUEUE_TRIGGER_FUNCTION = 'processReserveQueue';

  var triggers = ScriptApp.getProjectTriggers();

  // 既存の processReserveQueue トリガーをすべて削除してから再作成する
  // （atHour → everyMinutes への変更を確実に反映するため）
  var existingFound = false;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === QUEUE_TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(triggers[i]);
      existingFound = true;
      console.log('[INFO] setupQueueTrigger: 既存トリガーを削除しました。');
    }
  }

  // everyMinutes(1) で新規作成（F-6-9-1: GASトリガーの精密化）
  ScriptApp.newTrigger(QUEUE_TRIGGER_FUNCTION)
    .timeBased()
    .everyMinutes(1)
    .create();

  console.log('[INFO] setupQueueTrigger: processReserveQueue のトリガーを毎分実行に設定しました。' +
              '（F-6-9-1 速度最適化・7:00〜7:10 の窓のみ実処理）' +
              (existingFound ? ' 既存トリガーを置き換えました。' : ''));
}
