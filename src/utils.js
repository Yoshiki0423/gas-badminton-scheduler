/**
 * @fileoverview 共通ユーティリティ
 *
 * 全レイヤーから使われる小さな道具箱です。
 *
 * 提供する関数・定数:
 *   - DEFAULT_MAX_ATTEMPTS           : リトライの既定最大試行回数(定数)
 *   - getProperty(key)               : スクリプトプロパティから値を取得
 *   - withRetry(fn, options)         : 関数を最大 N 回・指数バックオフでリトライ
 *   - logError(error, context)       : エラーを構造化して GAS ログに記録
 */

/**
 * リトライの既定最大試行回数
 *
 * 用語補足:
 *   - マジックナンバー = コード中に直接書かれた、意味のわかりにくい数字のこと。
 *     たとえば `for (var i = 0; i < 3; i++)` の `3` のように、
 *     「何の 3 なのか」が読み手にわからない数字を指します。
 *     名前付きの定数(本定数のような形)に置き換えると、
 *     読み手が「これはリトライ回数の上限なんだな」とすぐ理解できるようになります。
 *
 * 設計値の根拠:
 *   - REQUIREMENTS.md §4-2(エラー時の挙動)で「最大 3 回・指数バックオフ」と定めている
 *   - 指数バックオフ:1 秒 → 2 秒 → 4 秒(待機時間合計 7 秒)
 *   - LINE Messaging API / スプレッドシート操作 で共通利用
 *
 * 変更が必要になった場合は、本定数を 1 か所変えるだけで全リトライ箇所に反映されます。
 *
 * @constant {number}
 */
var DEFAULT_MAX_ATTEMPTS = 3;

/**
 * スクリプトプロパティから値を取得する
 *
 * 用語補足:
 *   - スクリプトプロパティ = GAS の「秘密の設定置き場」。
 *     コードに直接書かずに API キーなどを保存できる仕組み。
 *
 * @param {string} key - プロパティキー
 *   例: 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'MEMBERS_SPREADSHEET_ID',
 *       'WEBHOOK_URL_TOKEN'
 * @returns {string} 値(未設定なら空文字列)
 */
function getProperty(key) {
  if (!key) {
    return '';
  }
  var value = PropertiesService.getScriptProperties().getProperty(key);
  return value || '';
}

/**
 * 関数を最大 N 回・指数バックオフでリトライする
 *
 * REQUIREMENTS.md §4-2 の方針:
 *   - 最大 DEFAULT_MAX_ATTEMPTS 回(初回 + リトライ 2 回 = 合計 3 回試行)
 *   - 指数バックオフ:1 秒 → 2 秒 → 4 秒
 *   - LINE / スプレッドシート操作で共通利用
 *
 * @param {Function} fn - リトライ対象の関数(引数なし・戻り値あり)
 * @param {{maxAttempts?: number, baseDelayMs?: number, label?: string}} [options]
 *   - maxAttempts: 最大試行回数(既定 DEFAULT_MAX_ATTEMPTS = 3)
 *   - baseDelayMs: 1 回目のリトライ前の待機ミリ秒(既定 1000)
 *   - label: ログ識別用ラベル(既定 'withRetry')
 * @returns {*} fn の戻り値
 * @throws {Error} 最終試行も失敗したときの最後の例外
 */
function withRetry(fn, options) {
  var opts = options || {};
  var maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  var baseDelayMs = opts.baseDelayMs || 1000;
  var label = opts.label || 'withRetry';

  var lastError = null;

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        var base = baseDelayMs * Math.pow(2, attempt - 1); // 1000, 2000, 4000...
        var jitter = Math.floor(Math.random() * base * 0.3); // 最大 30% のランダムなズレ
        var waitMs = base + jitter;
        console.log('[RETRY] ' + label + ' attempt ' + attempt + '/' + maxAttempts +
                    ' failed: ' + (err && err.message ? err.message : err) +
                    ' — waiting ' + waitMs + 'ms');
        Utilities.sleep(waitMs);
      }
    }
  }

  // すべて失敗
  throw new Error('[' + label + '] all ' + maxAttempts + ' attempts failed. Last error: ' +
                  (lastError && lastError.message ? lastError.message : lastError));
}

/**
 * エラーを構造化して GAS ログに記録する
 *
 * 設計意図:
 *   - GAS の標準ログは行が長くなると読みづらいため、JSON 文字列化して 1 行に押し込める
 *   - 個人情報(userId 等)は呼び出し側でマスク済みのものだけ context に入れる前提
 *
 * @param {Error|string} error - エラーオブジェクト or 文字列
 * @param {Object} [context] - 追加情報(phase 等)
 * @returns {void}
 */
function logError(error, context) {
  var entry = {
    level: 'ERROR',
    timestamp: Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    message: '',
    stack: '',
    context: context || {}
  };

  if (error instanceof Error) {
    entry.message = error.message;
    entry.stack = error.stack || '';
  } else {
    entry.message = String(error);
  }

  // console.error は GAS の Stackdriver Logging に「エラー」レベルで送られる
  console.error(JSON.stringify(entry));
}

/**
 * 文字列を時間の長さで判断されない方法で比較する(セキュリティ対策)
 *
 * 通常の === 比較は「最初の 1 文字が違えばすぐ false を返す」仕組みのため、
 * 攻撃者が何度も試して「どこまで合っているか」を時間で推測できてしまう。
 * この関数は全文字を必ず最後まで比較するため、その推測が難しくなる。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  var result = 0;
  for (var i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
