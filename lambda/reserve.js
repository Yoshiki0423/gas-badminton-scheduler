'use strict';

/**
 * @fileoverview バド卓ねっと(niigata-kaikou.jp)施設予約 Lambda 関数
 *
 * GAS からのリクエストを受け取り、axios + cheerio を使って
 * バド卓ねっとの予約フォームを 3 ステップで自動送信する。
 *
 * ── アクション一覧 ──
 *
 * warmup リクエスト（EventBridge から）:
 *   { "action": "warmup" }
 *   → スケジュールページに HEAD リクエストを送ってコンテナを温める
 *
 * scan リクエスト（GAS から）:
 *   {
 *     "action": "scan",
 *     "date": "2026-05-19",           // 対象日（YYYY-MM-DD）
 *     "startTime": "15:00",           // 希望開始時刻（"9:00"〜"19:00"）
 *     "courseGroupIds": [14881, 14882] // コースグループID（A室=14881 / B室=14882）
 *   }
 *   → 指定日・時間帯の空きコート一覧を返す
 *   レスポンス: { "success": true, "courts": [{ "courtName": "バドミントン 1", "courseTimeId": 407563, "courseGroupId": 14881 }] }
 *
 * reserve リクエスト（GAS から）:
 *   {
 *     "courseTimeId": 407752,
 *     "name":  "山田太郎",
 *     "tel":   "09000000000",
 *     "email": "example@example.com"
 *   }
 *   → 3 ステップで予約フォームを送信する
 *
 * 環境変数:
 *   RESERVE_API_TOKEN : GAS との共有トークン（認証用）
 *
 * コースグループ ID:
 *   14881 = 大体育室 A（バドミントン 1〜6）
 *   14882 = 中体育室 B（バドミントン 1〜3）
 *   ページ番号（/1, /2 …）= 日付ページ（1ページ = 1日）
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const http    = require('http');
const https   = require('https');

// モジュールレベルで 1 度だけ生成し、Lambda コンテナ再利用時に TCP 接続を使い回す
const _httpAgent  = new http.Agent({ keepAlive: true });
const _httpsAgent = new https.Agent({ keepAlive: true });

const BASE_URL          = 'https://niigata-kaikou.jp';
const RESERVE_FORM_BASE = BASE_URL + '/schedule/reserve/';
const POST_URL          = BASE_URL + '/schedule/post';
const WARMUP_URL        = BASE_URL + '/schedule';
const COURSE_BASE       = BASE_URL + '/schedule/course/';

// startTime 文字列 → テーブルヘッダー列名
const TIME_LABEL_MAP = {
  '9:00': '9-11時', '09:00': '9-11時',
  '11:00': '11-13時',
  '13:00': '13-15時',
  '15:00': '15-17時',
  '17:00': '17-19時',
  '19:00': '19-21時'
};

exports.handler = async function(event, context) {

  // ── EventBridge warmup（毎日 6:59 JST） ──
  // 注意: このブロックは意図的に API 認証チェック（X-Api-Token）の前に置いている。
  // EventBridge は Lambda を直接呼び出すため HTTP ヘッダーが存在せず、
  // 認証後に置くと warmup が常に 401 になる。EventBridge は AWS IAM で保護済み。
  if (event.action === 'warmup') {
    try {
      await axios.head(WARMUP_URL, { timeout: 10000, httpsAgent: _httpsAgent });
      console.log('[INFO] warmup: コンテナ準備完了');
      return _res(200, { success: true, message: 'warmup完了' });
    } catch (e) {
      console.warn('[WARN] warmup: HEAD リクエスト失敗（続行）', e.message);
      return _res(200, { success: true, message: 'warmup完了（HEAD失敗だが続行）' });
    }
  }

  // ── API 認証（X-Api-Token ヘッダー検証） ──
  const expectedToken = process.env.RESERVE_API_TOKEN;
  const receivedToken = event.headers &&
    (event.headers['X-Api-Token'] || event.headers['x-api-token']);
  if (!expectedToken || receivedToken !== expectedToken) {
    console.warn('[WARN] 認証失敗。X-Api-Token が一致しません。');
    return _res(401, { success: false, message: 'Unauthorized' });
  }

  let body;
  try {
    body = typeof event.body === 'string'
      ? JSON.parse(event.body)
      : (event.body || event);
  } catch (e) {
    return _res(400, { success: false, message: 'JSON解析失敗: ' + e.message });
  }

  if (body.action === 'scan') {
    return await _handleScan(body);
  }

  if (body.action === 'getImages') {
    return await _handleGetImages(body);
  }

  // ── 予約処理（reserve アクション） ──
  const courseTimeId = body.courseTimeId;
  const name         = body.name;
  const tel          = body.tel;
  const email        = body.email;

  if (!courseTimeId || !name || !tel || !email) {
    return _res(400, {
      success: false,
      message: 'courseTimeId / name / tel / email はすべて必須です'
    });
  }

  const client = axios.create({
    timeout: 25000,
    httpAgent:  _httpAgent,
    httpsAgent: _httpsAgent,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BadmintonBot/1.0)' },
    maxRedirects: 5
  });

  try {
    // ── Step 1: 予約フォームページを GET ──
    // maxAttempts=2: GET は冪等のためリトライ可。予約時間制約があるため試行回数は 2 回に抑える
    const formUrl = RESERVE_FORM_BASE + courseTimeId;
    const formRes = await _withRetry(function() {
      return client.get(formUrl);
    }, 2);
    let cookie = _extractCookies(formRes);

    const $form       = cheerio.load(formRes.data);
    const hiddenStep1 = _collectHidden($form);

    if (!hiddenStep1['_token']) {
      return _res(500, {
        success: false,
        message: '予約フォームから _token を取得できませんでした。courseTimeId が正しいか確認してください。'
      });
    }
    console.log('[INFO] Step1完了: hidden ' + Object.keys(hiddenStep1).length +
                '件 _token取得済み courseTimeId=' + courseTimeId);

    // ── Step 2: POST mode=confirm → 確認ページ ──
    const confirmData = Object.assign({}, hiddenStep1, {
      name:  name,
      tel:   tel,
      email: email,
      mode:  'confirm'
    });

    const confirmRes = await _withRetry(function() {
      return client.post(POST_URL, new URLSearchParams(confirmData).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookie
        }
      });
    }, 3);
    cookie = _mergeCookies(cookie, confirmRes);

    const $confirm      = cheerio.load(confirmRes.data);
    const confirmErrEl  = $confirm('.alert-danger, .error-message, [role="alert"]');
    if (confirmErrEl.length > 0) {
      const confirmErrText = confirmErrEl.first().text().trim();
      console.warn('[WARN] 確認ページでエラー検出:', confirmErrText);
      return _res(200, { success: false, message: '入力エラー: ' + (confirmErrText || '詳細不明') });
    }

    const hiddenStep2 = _collectHidden($confirm);
    if (!hiddenStep2['cancel_key']) {
      console.warn('[WARN] 確認ページから cancel_key を取得できませんでした。' +
                  'このスロットは既に予約済みの可能性があります。courseTimeId=' + courseTimeId);
      return _res(500, {
        success: false,
        message: '確認ページから cancel_key を取得できませんでした。このコート・時間は既に予約済みの可能性があります。'
      });
    }
    console.log('[INFO] Step2完了: cancel_key 取得済み');

    // ── Step 3: POST mode=send → 予約完了 ──
    const sendData = Object.assign({}, hiddenStep2, { mode: 'send' });

    const sendRes = await _withRetry(function() {
      return client.post(POST_URL, new URLSearchParams(sendData).toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookie
        }
      });
    }, 3);

    // ── 成功判定 ──
    const $send       = cheerio.load(sendRes.data);
    const stepCurrent = $send('.p-contact-form-step .is-current').text();
    const isStep3     = stepCurrent.includes('3') || stepCurrent.includes('送信完了');
    const stillNotDone = $send('body').text().includes('まだ予約は完了しておりません');

    if (isStep3 && !stillNotDone) {
      console.log('[INFO] 予約成功 courseTimeId=' + courseTimeId);
      return _res(200, { success: true, message: '予約が完了しました' });
    }

    const errEl = $send('.error-message, .alert-danger, [role="alert"], .errorMessage');
    if (errEl.length > 0) {
      const errText = errEl.first().text().trim();
      console.warn('[WARN] 送信後エラー検出 courseTimeId=' + courseTimeId + ' error=' + errText);
      return _res(200, { success: false, message: errText || 'フォームがエラーを返しました' });
    }

    // isStep3 も errEl も一致しない場合：成否を判定できなかった
    console.warn('[WARN] 成否判定不能 courseTimeId=' + courseTimeId +
                ' stepCurrent="' + stepCurrent + '"');
    return _res(200, {
      success: false,
      message: '予約結果を判定できませんでした。バド卓ねっとで直接ご確認ください。',
      uncertain: true
    });

  } catch (unexpectedErr) {
    console.error('[ERROR] 未処理例外:', unexpectedErr);
    return _res(500, { success: false, message: '予期しないエラー: ' + unexpectedErr.message });
  }
};

// ─────────────────────────────────────────────
// scan ハンドラ
// ─────────────────────────────────────────────

/**
 * 指定日・時間帯の空きコートをすべてのコースグループから収集して返す
 *
 * 注意: courseGroupIds の件数が増えると逐次ページ取得の総時間が増加する。
 * タイムアウト 15秒 / ページ平均 500ms の前提では最大 2〜3 グループが目安。
 */
async function _handleScan(body) {
  const date           = body.date;           // "2026-05-19"
  const startTime      = body.startTime;      // "15:00"
  const courseGroupIds = body.courseGroupIds; // [14881, 14882]

  if (!date || !startTime || !Array.isArray(courseGroupIds) || courseGroupIds.length === 0) {
    return _res(400, {
      success: false,
      message: 'date / startTime / courseGroupIds（配列）はすべて必須です'
    });
  }

  const timeLabel = TIME_LABEL_MAP[startTime];
  if (!timeLabel) {
    return _res(400, {
      success: false,
      message: '無効な startTime: ' + startTime + ' (例: "9:00", "13:00", "15:00")'
    });
  }

  const client = axios.create({
    timeout: 15000,
    httpAgent:  _httpAgent,
    httpsAgent: _httpsAgent,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BadmintonBot/1.0)' },
    maxRedirects: 5
  });

  try {
    let allCourts = [];
    for (let i = 0; i < courseGroupIds.length; i++) {
      const courts = await _scanCourseGroup(date, timeLabel, courseGroupIds[i], client);
      allCourts = allCourts.concat(courts);
    }
    console.log('[INFO] scan完了: date=' + date + ' startTime=' + startTime +
                ' 空きコート数=' + allCourts.length + ' ' + JSON.stringify(allCourts));
    return _res(200, { success: true, courts: allCourts });
  } catch (e) {
    console.error('[ERROR] scan失敗:', e);
    return _res(500, { success: false, message: 'スキャン中にエラーが発生しました: ' + e.message });
  }
}

/**
 * 1つのコースグループについて、対象日のページを探してコート一覧を返す
 * ページは日付順になっているので、目的の日付を超えたら打ち切る
 * 日付が読み取れないページが2ページ連続したら、それ以上予定がないとみなして打ち切る
 */
async function _scanCourseGroup(date, timeLabel, courseGroupId, client) {
  let nullCount = 0;
  for (let page = 1; page <= 14; page++) {
    const url = COURSE_BASE + courseGroupId + '/' + page;
    let res;
    try {
      res = await client.get(url);
    } catch (e) {
      if (e.response && e.response.status === 404) break;
      throw e;
    }

    const $ = cheerio.load(res.data);

    let riiyoubiText = '';
    $('table.c-table02 tr').each(function() {
      if ($(this).find('th').text().trim() === '利用日') {
        riiyoubiText = $(this).find('td').text().trim();
      }
    });

    const pageDate = _parseDateString(riiyoubiText);
    console.log('[INFO] scan: courseGroupId=' + courseGroupId + ' page=' + page +
                ' pageDate=' + pageDate + ' target=' + date);

    if (!pageDate) {
      nullCount++;
      if (nullCount >= 2) {
        console.log('[INFO] scan: 日付不明ページが続くため終了 courseGroupId=' + courseGroupId);
        break;
      }
      continue;
    }
    nullCount = 0;

    if (pageDate === date) {
      let facilityNameText = '';
      $('table.c-table02 tr').each(function() {
        if ($(this).find('th').text().trim() === '施設名') {
          facilityNameText = $(this).find('td').text().trim();
        }
      });
      return _parseAvailableCourts($, timeLabel, courseGroupId, facilityNameText);
    }
    if (pageDate > date) break; // 日付を過ぎた
  }

  return [];
}

/**
 * コース一覧テーブルから、指定した時間帯列の空きコートを取り出す
 * 〇 予約リンクがあるセルのみ対象（満・× は除外）
 *
 * @param {Object} $            - cheerio インスタンス
 * @param {string} timeLabel    - 時間帯列名（例: '15-17時'）
 * @param {number} courseGroupId
 * @param {string} facilityName - 施設名（c-table02 の「施設名」行から取得・空文字可）
 * @returns {Array<{courtName, courseTimeId, courseGroupId, patternName, facilityName}>}
 */
function _parseAvailableCourts($, timeLabel, courseGroupId, facilityName) {
  const results = [];

  const headers = [];
  $('table.c-table01 thead tr th').each(function() {
    headers.push($(this).text().trim());
  });

  const colIndex = headers.indexOf(timeLabel);
  if (colIndex < 0) {
    console.warn('[WARN] 時間帯列が見つかりません timeLabel=' + timeLabel +
                ' headers=' + JSON.stringify(headers));
    return results;
  }

  // 「種目/コート・台指定」行のテキストから patternName を抽出する
  // 例: "大体育室　A" → "大体育室 A"
  // 例: "9-13時 B / 13-15時 C / 15-21時 A" のような時間帯別パターン → timeLabel に対応する部分だけ抽出
  const patternName = _extractPatternName($, timeLabel);
  const simpleLabel = _simpleLabelFromPattern(patternName);
  const imageUrl    = _extractPatternImageUrl($, simpleLabel);

  const normalizedFacilityName = (facilityName || '').trim();

  $('table.c-table01 tbody tr').each(function() {
    const cells     = $(this).find('td');
    const courtName = $(cells.get(0)).text().trim();
    const link      = $(cells.get(colIndex)).find('a[href*="/schedule/reserve/"]');
    if (link.length > 0) {
      const match = link.attr('href').match(/\/schedule\/reserve\/(\d+)/);
      if (match) {
        results.push({
          courtName:     courtName,
          courseTimeId:  parseInt(match[1], 10),
          courseGroupId: courseGroupId,
          patternName:   patternName,
          imageUrl:      imageUrl,
          facilityName:  normalizedFacilityName
        });
      }
    }
  });

  return results;
}

/**
 * c-table02 の「種目/コート・台指定」行から patternName を抽出する
 *
 * - 「大体育室　A」のような固定パターン → 全角スペースを半角に正規化してそのまま返す
 * - 「9-13時 B / 13-15時 C / 15-21時 A」のような時間帯別パターン
 *   → timeLabel（例: '15-17時'）の開始時刻と照合して対応パターンを取り出す
 * - 取得できない場合は '' を返す（エラーにしない）
 *
 * @param {Object} $         - cheerio インスタンス
 * @param {string} timeLabel - 例: '15-17時'
 * @returns {string}
 */
function _extractPatternName($, timeLabel) {
  // timeLabel から開始時刻（数値）を取り出す: '15-17時' → 15
  const startHourMatch = timeLabel.match(/^(\d+)-/);
  const startHour = startHourMatch ? parseInt(startHourMatch[1], 10) : -1;

  // 実際のページ構造: パターン情報は「備考」行に入っている
  // 例: 固定 → "大体育室　A" / 混在 → "9-13大体育室A\n13-21中体育室B"
  // 「種目」行は "バドミントン" が入るだけで使えない
  let rawPattern = '';
  $('table.c-table02 tr').each(function() {
    const thText = $(this).find('th').text().trim();
    if (thText.indexOf('備考') >= 0 || thText.indexOf('コート') >= 0 || thText.indexOf('台指定') >= 0) {
      rawPattern = $(this).find('td').text().trim();
    }
  });

  if (!rawPattern) return '';

  // 全角スペース・改行前後の空白を正規化
  const normalized = rawPattern.replace(/　/g, ' ').trim();

  // 改行区切り形式（3施設で確認済みの書式に対応）
  // 書式1 鳥屋野: "9-13大体育室A\n13-21中体育室B"     ← 開始-終了+部屋名
  // 書式2 東総合: "9-13時 B\n13-15時 C\n15-21時 A"   ← 開始-終了時+文字
  // 書式3 亀田:   "9時～Aパターン\n11時～Bパターン"   ← 開始時のみ（終了は次行の開始）
  if (normalized.indexOf('\n') >= 0 && startHour >= 0) {
    const lines = normalized.split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
    const segs = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 書式1/2: 開始と終了の両方あり（"9-13大体育室A" / "9-17時 A"）
      const m2 = line.match(/^(\d+)[^\d]+(\d+)(.*)/);
      if (m2 && parseInt(m2[2], 10) > parseInt(m2[1], 10)) {
        segs.push({ s: parseInt(m2[1], 10), e: parseInt(m2[2], 10), p: m2[3].trim() });
        continue;
      }
      // 書式3: 開始のみ（"9時～Aパターン"）→ 終了は次行の開始で補完
      const m1 = line.match(/^(\d+)時[^A-Za-z　-鿿]*(.*)/);
      if (m1) {
        segs.push({ s: parseInt(m1[1], 10), e: -1, p: m1[2].trim() });
      }
    }

    // e=-1 のセグメントに終了時刻を補完する（次セグメントの開始 or 24時）
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].e === -1) {
        segs[i].e = (i + 1 < segs.length) ? segs[i + 1].s : 24;
      }
    }

    for (let i = 0; i < segs.length; i++) {
      if (startHour >= segs[i].s && startHour < segs[i].e) {
        return segs[i].p;
      }
    }

    // 照合できなかった場合は最終行を返す（近似値）
    return lines[lines.length - 1];
  }

  // スラッシュ区切り形式: "9-13時 B / 13-21時 A"（将来の書式変更に備え残す）
  if (normalized.indexOf('/') >= 0 && startHour >= 0) {
    const segments = normalized.split('/');
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i].trim();
      const segMatch = seg.match(/^(\d+)-(\d+)時\s+(.+)$/);
      if (segMatch) {
        const segStart = parseInt(segMatch[1], 10);
        const segEnd   = parseInt(segMatch[2], 10);
        if (startHour >= segStart && startHour < segEnd) {
          return segMatch[3].trim();
        }
      }
    }
    return normalized;
  }

  // 固定パターン（例: "大体育室　A" や "A"）はそのまま返す
  return normalized;
}

/**
 * patternName からシンプルラベル（A/B/C）を抽出する
 * 例: "大体育室 A" → "A", "B" → "B", "Aパターン サブアリーナ" → "A"
 * @param {string} patternName
 * @returns {string} "A" / "B" / "C" または ""
 */
function _simpleLabelFromPattern(patternName) {
  if (!patternName) return '';
  const m = patternName.match(/[A-Za-z]/);
  return m ? m[0].toUpperCase() : '';
}

/**
 * ページHTMLから、指定したパターンに対応する割り振り図画像URLを抽出する
 *
 * HPでは全パターンの画像が常にアルファベット順（A=0番目, B=1番目, C=2番目）で
 * 並んで表示される。備考欄の時間帯順とは一致しない場合があるため、
 * simpleLabel のアルファベット順インデックスで画像を選ぶ。
 *
 * @param {Object} $           - cheerio インスタンス
 * @param {string} simpleLabel - "A" / "B" / "C"
 * @returns {string} 絶対URL または ''
 */
function _extractPatternImageUrl($, simpleLabel) {
  const imgs = [];
  $('img').each(function() {
    const src = $(this).attr('src') || '';
    if (src.indexOf('/storage/schedule/') >= 0 &&
        (src.endsWith('.jpg') || src.endsWith('.png') || src.endsWith('.jpeg'))) {
      const absUrl = src.startsWith('http') ? src : (BASE_URL + src);
      if (imgs.indexOf(absUrl) < 0) imgs.push(absUrl);
    }
  });

  if (imgs.length === 0) return '';
  if (imgs.length === 1) return imgs[0];

  // 画像はアルファベット順: A=imgs[0], B=imgs[1], C=imgs[2]
  if (simpleLabel) {
    const idx = simpleLabel.toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < imgs.length) return imgs[idx];
  }
  return imgs[0];
}

// ─────────────────────────────────────────────
// getImages ハンドラ（F-6 LIFF方式・TBD-24 解消）
// ─────────────────────────────────────────────

/**
 * 指定した courseGroupId のページから割り振り図画像 URL を取得する
 *
 * リクエスト: { "action": "getImages", "courseGroupId": 14881 }
 * レスポンス: { "success": true, "imageUrl": "https://niigata-kaikou.jp/storage/schedule/202605/xxx.jpg" }
 *
 * GET https://niigata-kaikou.jp/schedule/course/{courseGroupId}
 * → HTML の img タグから .jpg / .png を探して最初の 1 件を返す。
 * → 見つからない場合は imageUrl = "" を返す（エラーにしない）。
 *
 * GAS の processReserveQueue / handleLiffReserveGetData が毎朝呼んで
 * ScriptProperties（PATTERN_IMG_{facilityId}_{pattern}）にキャッシュする想定。
 *
 * @param {Object} body - リクエストボディ({ courseGroupId })
 */
async function _handleGetImages(body) {
  const courseGroupId = body.courseGroupId;
  const simpleLabel   = (body.simpleLabel || '').toUpperCase();
  if (!courseGroupId) {
    return _res(400, { success: false, message: 'courseGroupId は必須です' });
  }

  const client = axios.create({
    timeout: 15000,
    httpAgent:  _httpAgent,
    httpsAgent: _httpsAgent,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BadmintonBot/1.0)' },
    maxRedirects: 5
  });

  try {
    // /schedule/course/{courseGroupId} にアクセスしてページ1を取得
    const url = COURSE_BASE + courseGroupId + '/1';
    let res;
    try {
      res = await _withRetry(function() { return client.get(url); }, 2);
    } catch (e) {
      if (e.response && e.response.status === 404) {
        console.warn('[WARN] getImages: 404 courseGroupId=' + courseGroupId);
        return _res(200, { success: true, imageUrl: '' });
      }
      throw e;
    }

    const $ = cheerio.load(res.data);
    const imageUrl = _extractPatternImageUrl($, simpleLabel);

    console.log('[INFO] getImages: courseGroupId=' + courseGroupId + ' simpleLabel=' + simpleLabel + ' imageUrl=' + imageUrl);
    return _res(200, { success: true, imageUrl: imageUrl });

  } catch (e) {
    console.error('[ERROR] getImages 失敗:', e);
    return _res(500, { success: false, message: '画像取得中にエラーが発生しました: ' + e.message });
  }
}

// ─────────────────────────────────────────────
// 内部ユーティリティ
// ─────────────────────────────────────────────

/** "2026年05月19日（火）" → "2026-05-19" */
function _parseDateString(str) {
  const m = str.match(/(\d{4})年(\d{2})月(\d{2})日/);
  if (!m) return null;
  return m[1] + '-' + m[2] + '-' + m[3];
}

/** フォーム内の hidden フィールドをすべて収集して {name: value} で返す */
function _collectHidden($) {
  const fields = {};
  $('form input[type="hidden"]').each(function() {
    const n = $(this).attr('name');
    const v = $(this).val() || '';
    if (n) fields[n] = v;
  });
  return fields;
}

/** レスポンスの Set-Cookie ヘッダーを "name=value" 形式の文字列に変換する */
function _extractCookies(response) {
  const setCookies = response.headers['set-cookie'] || [];
  return setCookies.map(function(c) { return c.split(';')[0]; }).join('; ');
}

/** 既存 Cookie 文字列と新レスポンスの Set-Cookie をマージする（同名は新値で上書き） */
function _mergeCookies(existing, response) {
  const newHeaders = response.headers['set-cookie'] || [];
  if (newHeaders.length === 0) return existing;
  const map = {};
  existing.split('; ').filter(Boolean).forEach(function(p) {
    const eq = p.indexOf('=');
    if (eq > 0) map[p.substring(0, eq)] = p.substring(eq + 1);
  });
  newHeaders.forEach(function(c) {
    const p  = c.split(';')[0].trim();
    const eq = p.indexOf('=');
    if (eq > 0) map[p.substring(0, eq)] = p.substring(eq + 1);
  });
  return Object.keys(map).map(function(k) { return k + '=' + map[k]; }).join('; ');
}

/** API Gateway プロキシ統合用レスポンスを生成する */
function _res(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

/**
 * 指数バックオフ + ジッター付きリトライ
 * 4xx（クライアントエラー）はリトライしない
 */
async function _withRetry(fn, maxAttempts) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.response && err.response.status >= 400 && err.response.status < 500) throw err;
      if (attempt < maxAttempts) {
        const waitMs = Math.pow(2, attempt - 1) * 1000 + Math.random() * 500;
        console.log('[INFO] _withRetry: attempt=' + attempt + ' ' +
                    waitMs.toFixed(0) + 'ms 後にリトライ error=' + err.message);
        await new Promise(function(r) { return setTimeout(r, waitMs); });
      }
    }
  }
  throw lastErr;
}
