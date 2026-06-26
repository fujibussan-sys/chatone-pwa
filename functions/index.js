/* ================================================================
 *  functions/index.js
 *  Firebase Cloud Functions — kintone CORS プロキシ
 *
 *  役割:
 *    GitHub Pages (github.io) はブラウザの CORS ポリシーにより
 *    cybozu.com へ直接 fetch できないため、Firebase Functions を
 *    サーバーサイドのプロキシとして中継する。
 *
 *  エンドポイント:
 *    POST https://<region>-<project>.cloudfunctions.net/kintoneProxy
 *
 *  リクエストボディ (JSON):
 *    {
 *      subdomain : string,          // xxx.cybozu.com の xxx 部分
 *      path      : string,          // /k/v1/records.json など
 *      method    : 'GET'|'POST'|'PUT', // 省略時 GET
 *      auth      : string,          // X-Cybozu-Authorization ヘッダ値
 *      params    : object,          // GETクエリパラメータ (任意)
 *      body      : object,          // POST/PUTボディ (任意)
 *    }
 *
 *  レスポンス:
 *    kintone からのレスポンスをそのまま返す。
 *    エラー時は { error: string, status: number } を返す。
 *
 *  ⚠️ セキュリティ注意:
 *    - kintone 認証情報はブラウザ→Functions→kintone の経路でのみ流れ、
 *      Firebase Realtime Database や Functions ログには保存しない。
 *    - allowedOrigins に GitHub Pages の URL を必ず設定すること。
 *    - 本番運用では Firebase App Check の導入を推奨。
 * ================================================================ */

const { onRequest } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const fetch = require('node-fetch');

// ── 許可するオリジン（GitHub Pages の URL を追記してください） ──────────
const ALLOWED_ORIGINS = [
  'https://fujibussan-sys.github.io',  // ← あなたの GitHub Pages URL
  'http://localhost:3000',              // ローカル開発用
  'http://127.0.0.1:5500',             // VS Code Live Server 用
];

// ── CORS ヘッダーをセットするヘルパー ──────────────────────────────────
const setCorsHeaders = (req, res) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '3600');
};

// ── メインプロキシ関数 ────────────────────────────────────────────────
exports.kintoneProxy = onRequest(
  {
    region: 'asia-northeast1', // 東京リージョン（日本のkintoneに近い）
    timeoutSeconds: 30,
    memory: '128MiB',
  },
  async (req, res) => {
    setCorsHeaders(req, res);

    // プリフライトリクエスト (OPTIONS) への応答
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    // POST のみ受け付ける
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    const { subdomain, path, method = 'GET', auth, params, body } = req.body || {};

    // 必須パラメータのバリデーション
    if (!subdomain || !path || !auth) {
      res.status(400).json({ error: 'subdomain, path, auth は必須です' });
      return;
    }

    // subdomain のサニタイズ（英数字とハイフンのみ許可）
    if (!/^[a-zA-Z0-9-]+$/.test(subdomain)) {
      res.status(400).json({ error: 'subdomain に不正な文字が含まれています' });
      return;
    }

    // kintone の許可パスのホワイトリスト
    const ALLOWED_PATHS = [
      '/k/v1/apps.json',
      '/k/v1/records.json',
      '/k/v1/record.json',
      '/k/v1/file.json',
      '/v1/users.json',
      '/v1/user.json',
    ];
    const isAllowed = ALLOWED_PATHS.some(p => path.startsWith(p));
    if (!isAllowed) {
      res.status(403).json({ error: `許可されていないパス: ${path}` });
      return;
    }

    // kintone への URL を組み立て
    let targetUrl = `https://${subdomain}.cybozu.com${path}`;
    if (method === 'GET' && params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (Array.isArray(v)) v.forEach(i => qs.append(k, i));
        else if (v != null) qs.set(k, String(v));
      });
      targetUrl += '?' + qs.toString();
    }

    // kintone へのリクエストヘッダー
    const headers = {
      'X-Cybozu-Authorization': auth,
      'Content-Type': 'application/json',
    };

    // kintone にリクエストを中継
    let kintoneRes;
    try {
      kintoneRes = await fetch(targetUrl, {
        method,
        headers,
        body: (method !== 'GET' && body) ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      console.error('[kintoneProxy] fetch error:', e.message);
      res.status(502).json({ error: 'kintone への接続に失敗しました', detail: e.message });
      return;
    }

    // kintone のレスポンスをそのまま返す
    const responseBody = await kintoneRes.text();
    res
      .status(kintoneRes.status)
      .set('Content-Type', 'application/json')
      .send(responseBody);
  }
);

/* ================================================================
 *  ファイルアップロード専用エンドポイント
 *  kintone の /k/v1/file.json (multipart/form-data) を中継する
 * ================================================================ */
const Busboy = require('@fastify/busboy');
const { Readable } = require('stream');
const FormData = require('form-data');

exports.kintoneFileProxy = onRequest(
  {
    region: 'asia-northeast1',
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (req, res) => {
    setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST')    { res.status(405).json({ error: 'Method Not Allowed' }); return; }

    const auth      = req.headers['x-cybozu-authorization'];
    const subdomain = req.headers['x-kintone-subdomain'];

    if (!auth || !subdomain) {
      res.status(400).json({ error: 'x-cybozu-authorization と x-kintone-subdomain ヘッダが必要です' });
      return;
    }
    if (!/^[a-zA-Z0-9-]+$/.test(subdomain)) {
      res.status(400).json({ error: 'subdomain に不正な文字が含まれています' });
      return;
    }

    // busboy でアップロードされたファイルを受け取る
    const busboy = Busboy({ headers: req.headers });
    const form   = new FormData();

    await new Promise((resolve, reject) => {
      busboy.on('file', (fieldname, file, info) => {
        const { filename, mimeType } = info;
        form.append(fieldname, file, { filename, contentType: mimeType });
      });
      busboy.on('finish', resolve);
      busboy.on('error', reject);
      if (req.rawBody) {
        Readable.from(req.rawBody).pipe(busboy);
      } else {
        req.pipe(busboy);
      }
    });

    let kintoneRes;
    try {
      kintoneRes = await fetch(
        `https://${subdomain}.cybozu.com/k/v1/file.json`,
        {
          method: 'POST',
          headers: {
            'X-Cybozu-Authorization': auth,
            ...form.getHeaders(),
          },
          body: form,
        }
      );
    } catch (e) {
      console.error('[kintoneFileProxy] fetch error:', e.message);
      res.status(502).json({ error: 'kintone へのファイルアップロードに失敗しました' });
      return;
    }

    const responseBody = await kintoneRes.text();
    res.status(kintoneRes.status).set('Content-Type', 'application/json').send(responseBody);
  }
);
