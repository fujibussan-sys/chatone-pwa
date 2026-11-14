/**
 * Chatone PWA — Firebase Cloud Functions v6 対応版
 * firebase-functions v6 では functions.region() が廃止され
 * onRequest / onValueCreated などを直接インポートして使う
 */
const { onRequest } = require('firebase-functions/v2/https');
const { onValueCreated } = require('firebase-functions/v2/database');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const https = require('https');
const { MetricServiceClient } = require('@google-cloud/monitoring');

const KINTONE_VERIFY_API_TOKEN = defineSecret('KINTONE_VERIFY_API_TOKEN');
const KINTONE_VERIFY_APP_ID = 286;

// 管理画面(/admin.html)を使えるログイン名（小文字で比較）。
// 増やす場合はここに追記する。
const ADMIN_LOGIN_NAMES = new Set(['tsumura@fujibussan.co.jp', 'tsumura']);

admin.initializeApp();

// デフォルトリージョンを東京に設定
setGlobalOptions({ region: 'asia-northeast1' });

// このプロキシが任意のcybozu.comテナントへの踏み台にされないよう、
// 対象サブドメインを固定する。
const ALLOWED_SUBDOMAIN = 'fujibussan';
const checkSubdomain = (subdomain, res) => {
  if (subdomain !== ALLOWED_SUBDOMAIN) {
    res.status(403).json({ error: '許可されていないサブドメインです' });
    return false;
  }
  return true;
};

/* ============================================================
 *  kintone への HTTPS リクエスト共通関数
 * ============================================================ */
const kintoneRequestWithHeaders = (subdomain, fullPath, method, extraHeaders, body) =>
  new Promise((resolve, reject) => {
    const bodyStr = (method !== 'GET' && body) ? JSON.stringify(body) : null;
    const options = {
      hostname: `${subdomain}.cybozu.com`,
      path: fullPath,
      method,
      headers: {
        ...extraHeaders,
        // ボディが無いGETにまで Content-Type: application/json を付けると、
        // kintoneが空ボディをJSONとして解析しようとして CB_IL02(不正なリクエスト)
        // になるため、ボディがある時だけ付与する。
        ...(bodyStr ? { 'Content-Type': 'application/json' } : {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });

const kintoneRequest = (subdomain, fullPath, method, authHeader, body) =>
  kintoneRequestWithHeaders(subdomain, fullPath, method, { 'X-Cybozu-Authorization': authHeader }, body);

const kintoneApiTokenRequest = (subdomain, fullPath, method, apiToken, body) =>
  kintoneRequestWithHeaders(subdomain, fullPath, method, { 'X-Cybozu-API-Token': apiToken }, body);

/* ============================================================
 *  kintone API プロキシ（GET / POST / PUT）
 * ============================================================ */
exports.kintoneProxy = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST')   { res.status(405).send('Method Not Allowed'); return; }

  const { subdomain, auth, path, method = 'GET', params = {}, body } = req.body || {};
  if (!subdomain || !auth || !path) {
    res.status(400).json({ error: 'subdomain, auth, path は必須です' }); return;
  }
  if (!checkSubdomain(subdomain, res)) return;

  // params をクエリストリングに変換
  // URLSearchParams はスペースを "+" にエンコードするが、kintoneのquery構文は
  // "+" を正しく空白として解釈せず CB_IL02(不正なリクエスト) になることがあるため
  // "%20" エンコードになるよう変換する。
  let fullPath = path;
  if (method === 'GET' && Object.keys(params).length > 0) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (Array.isArray(v)) v.forEach(i => qs.append(k, i));
      else if (v != null) qs.append(k, String(v));
    });
    fullPath = `${path}?${qs.toString().replace(/\+/g, '%20')}`;
  }

  try {
    const { status, body: kb } = await kintoneRequest(
      subdomain, fullPath, method, auth, method !== 'GET' ? body : null
    );
    // kintone エラーレスポンスをそのまま返す（クライアント側で message フィールドを使用）
    if (status >= 400 && typeof kb === 'object' && !kb.message) {
      kb.message = kb.error || kb.errors || `kintone error ${status}`;
    }
    if (status >= 400) {
      console.warn('[kintoneProxy] kintone rejected request', { subdomain, fullPath, method, status, kb });
    }
    res.status(status).json(kb);
  } catch (err) {
    res.status(500).json({ error: err.message, message: err.message });
  }
});

/* ============================================================
 *  ファイルアップロード プロキシ
 * ============================================================ */
exports.kintoneFileUpload = onRequest(
  { cors: true, memory: '512MiB', timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const { subdomain, auth, filename, mimeType, dataBase64 } = req.body;
    if (!subdomain || !auth || !filename || !dataBase64) {
      res.status(400).json({ error: 'subdomain, auth, filename, dataBase64 は必須です' }); return;
    }
    if (!checkSubdomain(subdomain, res)) return;

    const fileBuffer = Buffer.from(dataBase64, 'base64');
    const boundary   = `----FormBoundary${Date.now().toString(16)}`;
    const header     = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;
    const footer     = `\r\n--${boundary}--\r\n`;
    const bodyBuf    = Buffer.concat([Buffer.from(header), fileBuffer, Buffer.from(footer)]);

    const options = {
      hostname: `${subdomain}.cybozu.com`,
      path: '/k/v1/file.json',
      method: 'POST',
      headers: {
        'X-Cybozu-Authorization': auth,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuf.length,
      },
    };

    try {
      await new Promise((resolve, reject) => {
        const kreq = https.request(options, kres => {
          const chunks = [];
          kres.on('data', c => chunks.push(c));
          kres.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try { res.status(kres.statusCode).json(JSON.parse(raw)); }
            catch { res.status(kres.statusCode).send(raw); }
            resolve();
          });
        });
        kreq.on('error', reject);
        kreq.write(bodyBuf);
        kreq.end();
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ============================================================
 *  ファイルダウンロード プロキシ
 * ============================================================ */
exports.kintoneFileDownload = onRequest(
  { cors: true, memory: '512MiB', timeoutSeconds: 120 },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const { subdomain, auth, fileKey } = req.body;
    if (!subdomain || !auth || !fileKey) {
      res.status(400).json({ error: 'subdomain, auth, fileKey は必須です' }); return;
    }
    if (!checkSubdomain(subdomain, res)) return;

    const options = {
      hostname: `${subdomain}.cybozu.com`,
      path: `/k/v1/file.json?fileKey=${encodeURIComponent(fileKey)}`,
      method: 'GET',
      headers: { 'X-Cybozu-Authorization': auth, 'X-Requested-With': 'XMLHttpRequest' },
    };

    try {
      await new Promise((resolve, reject) => {
        const kreq = https.request(options, kres => {
          const chunks = [];
          kres.on('data', c => chunks.push(c));
          kres.on('end', () => {
            const buf = Buffer.concat(chunks);
            res.set('Content-Type', kres.headers['content-type'] || 'application/octet-stream');
            res.set('Content-Disposition', kres.headers['content-disposition'] || '');
            res.status(kres.statusCode).send(buf);
            resolve();
          });
        });
        kreq.on('error', reject);
        kreq.end();
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* ============================================================
 *  kintone認証 → Firebaseカスタムトークン発行
 *  RTDBへの匿名フルアクセスを防ぐため、kintoneログインを検証できた
 *  ユーザーにだけ Firebase Authentication のカスタムトークンを発行する。
 * ============================================================ */
exports.kintoneAuth = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST')   { res.status(405).send('Method Not Allowed'); return; }

  const { subdomain, auth } = req.body || {};
  if (!subdomain || !auth) {
    res.status(400).json({ error: 'subdomain, auth は必須です' }); return;
  }
  if (!checkSubdomain(subdomain, res)) return;

  let loginName;
  try {
    loginName = Buffer.from(auth, 'base64').toString('utf8').split(':')[0];
  } catch {
    loginName = '';
  }
  if (!loginName) {
    res.status(400).json({ error: '認証情報の形式が不正です' }); return;
  }

  try {
    const { status, body: kb } = await kintoneRequest(subdomain, '/k/v1/apps.json?limit=1', 'GET', auth, null);
    if (status === 401 || status === 520) {
      res.status(401).json({ error: 'ログイン名またはパスワードが正しくありません' }); return;
    }
    if (status >= 400) {
      res.status(status).json({ error: kb?.message || kb?.error || `kintone error ${status}` }); return;
    }
    const uid = 'kintone:' + loginName;
    const claims = { subdomain, loginName };
    if (ADMIN_LOGIN_NAMES.has(loginName.toLowerCase())) claims.admin = true;
    const token = await admin.auth().createCustomToken(uid, claims);
    res.status(200).json({ token });
  } catch (err) {
    console.error('[kintoneAuth] error', err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
 *  kintone内カスタマイズJS(widget)用の認証
 *  パスワードを持たないため、kintoneが記録する「作成者」（サーバー側で
 *  付与され、クライアントJSからは偽装できない）を本人確認の証拠として使う。
 *  widget側は事前に検証用kintoneアプリ(286)へnonceを書き込んでおき、
 *  ここで専用APIトークンを使って独立に読み取り・照合する。
 * ============================================================ */
const NONCE_MAX_AGE_MS = 120 * 1000;

exports.kintoneWidgetAuth = onRequest(
  { cors: true, secrets: [KINTONE_VERIFY_API_TOKEN] },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST')   { res.status(405).send('Method Not Allowed'); return; }

    const { code, nonce } = req.body || {};
    if (!code || !nonce || !/^[A-Za-z0-9]+$/.test(nonce)) {
      res.status(400).json({ error: 'code, nonce は必須です' }); return;
    }

    try {
      const apiToken = KINTONE_VERIFY_API_TOKEN.value();
      const query = `nonce = "${nonce}" limit 1`;
      const { status, body: kb } = await kintoneApiTokenRequest(
        ALLOWED_SUBDOMAIN,
        `/k/v1/records.json?app=${KINTONE_VERIFY_APP_ID}&query=${encodeURIComponent(query)}`,
        'GET', apiToken, null
      );
      if (status >= 400) {
        console.error('[kintoneWidgetAuth] verify lookup failed', status, kb);
        res.status(500).json({ error: '検証に失敗しました' }); return;
      }
      const record = kb?.records?.[0];
      if (!record) {
        res.status(401).json({ error: '検証情報が見つかりません' }); return;
      }
      const creatorCode = record['作成者']?.value?.code;
      const createdAt = new Date(record['作成日時']?.value || 0).getTime();
      console.log('[kintoneWidgetAuth] verify check', {
        claimedCode: code, creatorCode, rawCreatedAt: record['作成日時']?.value,
        createdAt, now: Date.now(), ageMs: Date.now() - createdAt,
      });
      if (creatorCode !== code) {
        res.status(401).json({ error: 'ユーザーが一致しません' }); return;
      }
      if (!createdAt || Date.now() - createdAt > NONCE_MAX_AGE_MS) {
        res.status(401).json({ error: '検証情報の有効期限が切れています' }); return;
      }

      // 使い捨てにするため検証レコードを削除する
      const recordId = record['$id']?.value;
      if (recordId) {
        await kintoneApiTokenRequest(
          ALLOWED_SUBDOMAIN, '/k/v1/records.json', 'DELETE', apiToken,
          { app: KINTONE_VERIFY_APP_ID, ids: [Number(recordId)] }
        );
      }

      const uid = 'kintone:' + code;
      const token = await admin.auth().createCustomToken(uid, { subdomain: ALLOWED_SUBDOMAIN, loginName: code, via: 'widget' });
      res.status(200).json({ token });
    } catch (err) {
      console.error('[kintoneWidgetAuth] error', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/* ============================================================
 *  FCM プッシュ通知（新着メッセージ → 全メンバーに送信）
 * ============================================================ */
exports.onNewMessage = onValueCreated(
  {
    ref: '/messages/{roomId}/{messageId}',
    instance: process.env.FIREBASE_DATABASE_INSTANCE,
    // Realtime DatabaseインスタンスがAsia-southeast1にあるため、
    // トリガーもそれに合わせて同一リージョンに固定する（他のHTTP関数はasia-northeast1のまま）。
    region: 'asia-southeast1',
  },
  async (event) => {
    const msg    = event.data.val();
    const roomId = event.params.roomId;
    if (!msg || ['system', 'deleted'].includes(msg.msg_type)) return null;

    // 管理画面用の利用統計をメッセージ送信時に集計しておく（書き込み時集計）。
    // 管理画面を開くたびに全メッセージを読み直すと転送量が嵩むため、
    // 既に動いているこのトリガーに相乗りしてO(1)の小さな書き込みで済ませる。
    const dateKey = jstDateKey(msg.sent_at || Date.now());
    const statsPromise = Promise.all([
      admin.database().ref(`/stats/rooms/${roomId}/message_count`).transaction(cur => (cur || 0) + 1),
      admin.database().ref(`/stats/daily/${dateKey}/users/${encodeUserCode(msg.sender)}`).set(true),
    ]).catch(err => console.error('[onNewMessage] stats update failed', err));

    const roomSnap = await admin.database().ref(`/rooms/${roomId}`).get();
    const room     = roomSnap.val();
    await statsPromise;
    if (!room?.members) return null;

    const senderEncoded = encodeUserCode(msg.sender);
    const memberKeys    = Object.keys(room.members).filter(k => k !== senderEncoded);
    const tokenSnaps    = await Promise.all(
      memberKeys.map(k => admin.database().ref(`/fcm_tokens/${k}`).get())
    );
    // hotfixがトークンをデバイス毎のサブキーに保存するため(/fcm_tokens/{user}/{tokenKey})、
    // 単一token直下だけでなく複数デバイス分もまとめて拾う。
    const tokens = [...new Set(tokenSnaps.flatMap(s => {
      const val = s.val();
      if (!val) return [];
      if (val.token) return [val.token];
      return Object.values(val).map(v => v && v.token).filter(Boolean);
    }))];
    if (!tokens.length) return null;

    const roomName = room.room_name || 'Chatone';
    const senderName = msg.sender_name || msg.sender || 'Chatone';
    // 1対1ルームはルーム名と送信者名が同一人物になるため、重複させず表示名のみにする。
    const title = room.is_dm || roomName === senderName ? senderName : `${roomName}  ${senderName}`;
    const body = msg.body
      ? (msg.body.length > 80 ? msg.body.slice(0, 80) + '…' : msg.body)
      : msg.msg_type === 'stamp' ? '(スタンプ)' : '(ファイル)';

    await admin.messaging().sendEachForMulticast({
      tokens,
      // notificationフィールドを付けるとブラウザが自動表示してしまい、
      // アプリ側のonBackgroundMessage(バッジ更新処理を含む)が実行されないため
      // データのみのメッセージにして表示を完全にクライアント側に委ねる。
      data: {
        title,
        body,
        roomId,
      },
      webpush: {
        fcmOptions: { link: `https://fujibussan-sys.github.io/chatone-pwa/?room=${roomId}` },
      },
      android: { notification: { sound: 'default', channelId: 'chatone' } },
      apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
    });
    return null;
  }
);

function encodeUserCode(code) {
  if (!code) return code;
  return String(code)
    .replace(/_/g,'_us_').replace(/@/g,'_at_').replace(/\./g,'_dot_')
    .replace(/#/g,'_hash_').replace(/\$/g,'_dollar_').replace(/\//g,'_slash_')
    .replace(/\[/g,'_lb_').replace(/\]/g,'_rb_');
}

// JST基準の日付キー(YYYY-MM-DD)。タイムゾーンDB参照なしで済むよう+9hシフトのみで計算。
function jstDateKey(ms) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ============================================================
 *  管理画面用: Realtime Databaseの転送量をCloud Monitoring APIから取得
 *  （要: Cloud Functionsのランタイムサービスアカウントに roles/monitoring.viewer）
 * ============================================================ */
const metricsClient = new MetricServiceClient();

async function fetchRtdbUsage(days = 30) {
  const projectId = await metricsClient.getProjectId();
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - days * 86400;

  const [timeSeries] = await metricsClient.listTimeSeries({
    name: metricsClient.projectPath(projectId),
    filter: 'metric.type="firebasedatabase.googleapis.com/network/sent_payload_bytes_count"',
    interval: { startTime: { seconds: startTime }, endTime: { seconds: now } },
    aggregation: {
      alignmentPeriod: { seconds: 86400 },
      perSeriesAligner: 'ALIGN_SUM',
      crossSeriesReducer: 'REDUCE_SUM',
    },
    view: 'FULL',
  });

  const points = (timeSeries?.[0]?.points || [])
    .map(p => ({
      date: new Date(Number(p.interval.endTime.seconds) * 1000).toISOString().slice(0, 10),
      bytes: Number(p.value?.int64Value ?? p.value?.doubleValue ?? 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { days, points };
}

/* ============================================================
 *  管理画面用の集計データ取得
 *  tsumura@fujibussan.co.jp のみ閲覧可（kintoneAuthで付与したadminクレームを検証）
 * ============================================================ */
exports.adminStats = onRequest({ cors: true }, async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const authHeader = req.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) { res.status(401).json({ error: '認証情報がありません' }); return; }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    res.status(401).json({ error: 'トークンが無効です' }); return;
  }
  if (decoded.admin !== true) {
    res.status(403).json({ error: 'アクセス権がありません' }); return;
  }

  try {
    const db = admin.database();
    const [roomsSnap, statsRoomsSnap, dailySnap, userDirSnap] = await Promise.all([
      db.ref('/rooms').get(),
      db.ref('/stats/rooms').get(),
      db.ref('/stats/daily').get(),
      db.ref('/user_directory').get(),
    ]);

    const rooms      = roomsSnap.val()    || {};
    const statsRooms = statsRoomsSnap.val() || {};
    const daily       = dailySnap.val()    || {};
    const userDir     = userDirSnap.val()  || {};

    const roomList = Object.entries(rooms).map(([id, room]) => ({
      id,
      name: room.room_name || (room.is_dm ? 'DM' : '(名称未設定)'),
      isDm: !!room.is_dm,
      memberCount: room.members ? Object.keys(room.members).length : 0,
      messageCount: statsRooms[id]?.message_count || 0,
      lastSentAt: room.last_sent_at || null,
    })).sort((a, b) => (b.lastSentAt || 0) - (a.lastSentAt || 0));

    const dailyActive = Object.entries(daily)
      .map(([date, v]) => ({ date, activeUsers: v?.users ? Object.keys(v.users).length : 0 }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30);

    let usage = null;
    try {
      usage = await fetchRtdbUsage(30);
    } catch (err) {
      console.error('[adminStats] usage fetch failed', err);
    }

    res.status(200).json({
      totalUsers: Object.keys(userDir).length,
      roomCount: roomList.length,
      rooms: roomList,
      dailyActive,
      usage,
    });
  } catch (err) {
    console.error('[adminStats] error', err);
    res.status(500).json({ error: err.message });
  }
});

