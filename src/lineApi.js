/**
 * @fileoverview LINE Messaging API ラッパー
 *
 * LINE の API を呼ぶための薄いラッパー関数群です。
 * 上位の handlers.js は LINE の生エンドポイント URL や認証ヘッダーを意識せず、
 * 関数を呼ぶだけで済むように設計しています。
 *
 * 提供する関数:
 *   - replyText(replyToken, text)             : Reply API で平文を返信
 *   - pushFlexMessage(userId, altText, flex)  : Push API で Flex Message を 1 件送信(F-1-3)
 *   - getLineProfile(userId)                  : プロフィール API で displayName を取得
 *   - computeLineSignature(secret, body)      : HMAC-SHA256 + Base64 で署名を計算
 *
 * すべての API 呼び出しは UrlFetchApp.fetch を使い、`muteHttpExceptions: true` を付けて
 * HTTP エラーでも例外で死なずに、レスポンスコードで判定する設計にしています(=リトライ制御を明示化)。
 */

/** LINE Messaging API のエンドポイント定数(変更されない・トップレベルに置く) */
var LINE_API_REPLY_URL          = 'https://api.line.me/v2/bot/message/reply';
var LINE_API_PUSH_URL           = 'https://api.line.me/v2/bot/message/push';
var LINE_API_PROFILE_URL_PREFIX = 'https://api.line.me/v2/bot/profile/';

/**
 * Reply API で平文メッセージを 1 件返信する
 *
 * @param {string} replyToken - LINE が follow イベント等で渡してくる 1 回限りの返信トークン
 *   (約 1 分で期限切れ)
 * @param {string} text - 送信する平文(改行は \n)
 * @returns {{statusCode: number, body: string}} レスポンス情報
 * @throws {Error} HTTP 200 系以外のとき(=呼び出し元の withRetry でリトライさせる)
 */
function replyText(replyToken, text) {
  if (!replyToken) {
    throw new Error('replyText: replyToken is required');
  }
  if (!text) {
    throw new Error('replyText: text is required');
  }

  var token = getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    throw new Error('replyText: LINE_CHANNEL_ACCESS_TOKEN is not set in Script Properties');
  }

  var payload = {
    replyToken: replyToken,
    messages: [{ type: 'text', text: text }]
  };

  var response = UrlFetchApp.fetch(LINE_API_REPLY_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var statusCode = response.getResponseCode();
  var body = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    // HTTP エラーは Error にして throw し、withRetry にリトライさせる
    throw new Error('replyText failed: status=' + statusCode + ' body=' + body);
  }

  return { statusCode: statusCode, body: body };
}

/**
 * Push API で userId 宛に Flex Message を 1 件送信する(F-1-3 質問配信用)
 *
 * Reply API(replyText)との違い:
 *   - Reply API は Webhook イベントを受け取ったときの「返信」専用で、replyToken が必要
 *   - Push API はトークン不要で任意のタイミングに任意のユーザーへ送れる
 *     (=管理者が手動実行 or 定期実行で質問を配信する F-1-3 では Push API が必要)
 *
 * Flex Message:
 *   LINE の「リッチな見た目のメッセージ」形式。ボタンや画像などを自由に配置できる。
 *   通常のテキストと異なり、JSON で見た目を細かく指定する。
 *
 * @param {string} userId - 送信先 LINE ユーザー ID
 * @param {string} altText - Flex Message 非対応端末向けの代替テキスト(必須)
 * @param {Object} flexContents - Flex Message の中身(bubble or carousel オブジェクト)
 * @returns {{statusCode: number, body: string}} レスポンス情報
 * @throws {Error} HTTP 200 系以外のとき(=呼び出し元の withRetry でリトライさせる)
 */
function pushFlexMessage(userId, altText, flexContents) {
  if (!userId) {
    throw new Error('pushFlexMessage: userId is required');
  }
  if (!altText) {
    throw new Error('pushFlexMessage: altText is required');
  }
  if (!flexContents) {
    throw new Error('pushFlexMessage: flexContents is required');
  }

  var token = getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    throw new Error('pushFlexMessage: LINE_CHANNEL_ACCESS_TOKEN is not set in Script Properties');
  }

  var payload = {
    to: userId,
    messages: [{
      type: 'flex',
      altText: altText,
      contents: flexContents
    }]
  };

  var response = UrlFetchApp.fetch(LINE_API_PUSH_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var statusCode = response.getResponseCode();
  var body = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('pushFlexMessage failed: status=' + statusCode + ' body=' + body);
  }

  return { statusCode: statusCode, body: body };
}

/**
 * プロフィール API で userId からプロフィール情報を取得する
 *
 * @param {string} userId
 * @returns {{userId: string, displayName: string, pictureUrl?: string, statusMessage?: string}}
 * @throws {Error} HTTP 200 系以外のとき
 */
function getLineProfile(userId) {
  if (!userId) {
    throw new Error('getLineProfile: userId is required');
  }

  var token = getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    throw new Error('getLineProfile: LINE_CHANNEL_ACCESS_TOKEN is not set in Script Properties');
  }

  var url = LINE_API_PROFILE_URL_PREFIX + encodeURIComponent(userId);
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token
    },
    muteHttpExceptions: true
  });

  var statusCode = response.getResponseCode();
  var body = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('getLineProfile failed: status=' + statusCode + ' body=' + body);
  }

  try {
    return JSON.parse(body);
  } catch (parseError) {
    throw new Error('getLineProfile: failed to parse JSON: ' + body);
  }
}

/**
 * Push API で userId 宛に平文テキストを 1 件送信する
 *
 * pushFlexMessage との違い: メッセージ形式が plain text のみ。
 * F-1-5(リマインド)/ F-1-7(結果通知)で使用する。
 *
 * @param {string} userId - 送信先 LINE ユーザー ID
 * @param {string} text - 送信するテキスト(\n で改行可)
 * @returns {{statusCode: number, body: string}}
 * @throws {Error} HTTP 200 系以外のとき
 */
function pushText(userId, text) {
  if (!userId) {
    throw new Error('pushText: userId is required');
  }
  if (!text) {
    throw new Error('pushText: text is required');
  }

  var token = getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    throw new Error('pushText: LINE_CHANNEL_ACCESS_TOKEN is not set in Script Properties');
  }

  var payload = {
    to: userId,
    messages: [{ type: 'text', text: text }]
  };

  var response = UrlFetchApp.fetch(LINE_API_PUSH_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var statusCode = response.getResponseCode();
  var body = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('pushText failed: status=' + statusCode + ' body=' + body);
  }

  return { statusCode: statusCode, body: body };
}

/**
 * LINE 署名検証用の HMAC-SHA256 + Base64 を計算する
 *
 * LINE 公式仕様:
 *   - 署名対象は「リクエストボディ全体(JSON 文字列のまま)」
 *   - シークレットは Channel Secret(LINE Developers コンソールで発行)
 *   - 計算結果を Base64 エンコードした文字列が、X-Line-Signature ヘッダー値と一致する
 *
 * 参考: https://developers.line.biz/ja/reference/messaging-api/#signature-validation
 *
 * @param {string} secret - Channel Secret
 * @param {string} body - リクエストボディ(JSON 文字列・byte 単位で一致する必要あり)
 * @returns {string} Base64 エンコードされた署名
 */
function computeLineSignature(secret, body) {
  if (!secret) {
    throw new Error('computeLineSignature: secret is required');
  }
  if (body === undefined || body === null) {
    throw new Error('computeLineSignature: body is required');
  }

  var hmacBytes = Utilities.computeHmacSha256Signature(body, secret);
  return Utilities.base64Encode(hmacBytes);
}
