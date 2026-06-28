/* =====================================================
 *  Chatone PWA v1.0  —  chatone-pwa.js
 *
 *  kintoneウィジェット版をスタンドアロンPWAへ移植
 *  認証  : kintone X-Cybozu-Authorization（IndexedDB保存）
 *  通知  : Firebase Cloud Messaging (FCM)
 *  DB    : Firebase Realtime Database（既存データそのまま利用）
 *  添付  : kintone添付アプリ or Dropbox（設定に従う）
 *  キャッシュ: IndexedDB（アバター・スタンプ 24h TTL）
 * ===================================================== */
'use strict';

/* ============================================================
 *  CONFIG — ★ここを環境に合わせて書き換えてください★
 * ============================================================ */
const CONFIG = {
  KINTONE_SUBDOMAIN: 'fujibussan', // xxx.cybozu.com の xxx 部分

  // ★ Firebase Cloud Functions プロキシ URL（デプロイ後に設定）
  // Firebase コンソール > Functions で確認できる URL の「ベース部分」
  // 例: 'https://asia-northeast1-my-project-id.cloudfunctions.net'
  PROXY_ENDPOINTS: {
    kintoneProxy:        'https://kintoneproxy-63pf5chkva-an.a.run.app',
    kintoneFileUpload:   'https://kintonefileupload-63pf5chkva-an.a.run.app',
    kintoneFileDownload: 'https://kintonefiledownload-63pf5chkva-an.a.run.app',
  },

  FIREBASE: {
    apiKey:            'AIzaSyBlTJjF_fOYLpEQTsxt_X18s-A_4FGV-9U',
    authDomain:        'chatone-fujibussan.firebaseapp.com',
    databaseURL:       'https://chatone-fujibussan-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId:         'chatone-fujibussan',
    storageBucket:     'chatone-fujibussan.firebasestorage.app',
    messagingSenderId: '1077755971352',
    appId:             '1:1077755971352:web:4267f0b620e79b0af5c06d',
  },

  // Firebase Console → プロジェクト設定 → Cloud Messaging → ウェブプッシュ証明書
  FCM_VAPID_KEY: 'BPnVCRYS-Z_N2dhRpouOGcQkNoU4rhgBBYSWRefymrrRtAZZCRpa0d4CcDnMb5K_ZMaPde1QieORrEv-_IEvaNI',

  APP_ID_STAMPS:         273,
  APP_ID_AVATARS:        276,
  APP_ID_ATTACHMENTS:    277,
  ATTACHMENT_FIELD_CODE: 'attachment_file',
  ATTACHMENT_STORAGE:    'kintone', // 'kintone' | 'dropbox'

  DROPBOX: { ACCESS_TOKEN: '', UPLOAD_FOLDER: '/Chatone' },

  EXCLUDED_USER_CODES: [],
  MESSAGES_PER_PAGE:   50,
  NIGHT_MODE_START:    23,
  NIGHT_MODE_END:       6,
  AVATAR_CACHE_TTL:    24 * 60 * 60 * 1000, // 24h
};

/* ============================================================
 *  IndexedDB ヘルパー
 * ============================================================ */
const idb = (() => {
  let _db = null;
  const open = () => {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open('chatone-pwa', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        ['settings', 'cache'].forEach(s => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        });
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = () => rej(req.error);
    });
  };
  const tx = async (store, mode, fn) => {
    await open();
    return new Promise((res, rej) => {
      const req = _db.transaction(store, mode).objectStore(store);
      const r = fn(req);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  };
  return {
    open,
    get:   (s, k)    => tx(s, 'readonly',  o => o.get(k)),
    set:   (s, k, v) => tx(s, 'readwrite', o => o.put(v, k)),
    del:   (s, k)    => tx(s, 'readwrite', o => o.delete(k)),
    keys:  (s)       => tx(s, 'readonly',  o => o.getAllKeys()),
  };
})();

/* ============================================================
 *  認証ストア（IndexedDB に base64 難読化して保存）
 * ============================================================ */
const authStore = {
  _KEY: 'creds',
  _cache: null,
  async load() {
    try {
      const raw = await idb.get('settings', this._KEY);
      if (!raw) return null;
      this._cache = JSON.parse(atob(raw));
      return this._cache;
    } catch { return null; }
  },
  async save(c) { this._cache = c; await idb.set('settings', this._KEY, btoa(JSON.stringify(c))); },
  async clear() { this._cache = null; await idb.del('settings', this._KEY); },
  get()       { return this._cache; },
  header()    {
    const c = this._cache;
    return c ? { 'X-Cybozu-Authorization': btoa(`${c.loginName}:${c.password}`) } : {};
  },
  base()      { return `https://${(this._cache?.subdomain || CONFIG.KINTONE_SUBDOMAIN)}.cybozu.com`; },
  proxyUrl(name = 'kintoneProxy') { return CONFIG.PROXY_ENDPOINTS[name]; },
  subdomain() { return this._cache?.subdomain || CONFIG.KINTONE_SUBDOMAIN; },
};

/* ============================================================
 *  kintone REST API ラッパー（kintone.api() の代替）
 * ============================================================ */
const api = {
  _userCache: null, _userCacheTs: 0,

  // ── プロキシ共通リクエスト ──────────────────────────────────────────
  // Firebase Cloud Functions の kintoneProxy を経由して cybozu.com に中継する。
  // これにより GitHub Pages からの CORS ブロックを回避する。
  async _proxy(path, method = 'GET', params = {}, body = null) {
    const auth = authStore.header()['X-Cybozu-Authorization'];
    const subdomain = authStore.subdomain();
    const proxyUrl = authStore.proxyUrl('kintoneProxy');
    const r = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subdomain, path, method, auth, params, body }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.message || e.error || `kintone ${r.status}`);
    }
    return r.json();
  },

  _h() { return { ...authStore.header(), 'Content-Type': 'application/json' }; },

  async _get(path, params = {}) {
    return this._proxy(path, 'GET', params);
  },

  async _post(path, body) {
    return this._proxy(path, 'POST', {}, body);
  },

  async _put(path, body) {
    return this._proxy(path, 'PUT', {}, body);
  },

  getLoginUser() { return authStore.get(); },

  getRecords(appId, query='', limit=100) { const q = [query, `limit ${limit}`].filter(Boolean).join(' '); return this._get('/k/v1/records.json', { app:appId, query:q }); },
  addRecord(appId, record)    { return this._post('/k/v1/record.json', { app:appId, record }); },
  updateRecord(appId, id, record) { return this._put('/k/v1/record.json', { app:appId, id, record }); },

  async uploadFile(file) {
    // ファイルアップロードは multipart/form-data のため専用エンドポイントを使用
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const r = await fetch(authStore.proxyUrl('kintoneFileUpload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subdomain: authStore.subdomain(),
        auth: authStore.header()['X-Cybozu-Authorization'],
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
      }),
    });
    if (!r.ok) throw new Error(`kintone file upload ${r.status}`);
    return (await r.json()).fileKey;
  },

  async fetchFile(fileKey) {
    const r = await fetch(authStore.proxyUrl('kintoneFileDownload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subdomain: authStore.subdomain(),
        auth: authStore.header()['X-Cybozu-Authorization'],
        fileKey,
      }),
    });
    if (!r.ok) throw new Error(`kintone file download ${r.status}`);
    return r.blob();
  },

  async searchUsers(keyword) {
    const now = Date.now();
    if (!this._userCache || now - this._userCacheTs > CONFIG.AVATAR_CACHE_TTL) {
      this._userCache = null;
      // Firebase の /user_directory を先に試みる（ウィジェット側が書き込んだ共有キャッシュ）
      try {
        const snap = await _db.ref('/user_directory').get();
        if (snap.exists()) { this._userCache = Object.values(snap.val()||{}); this._userCacheTs = now; }
      } catch {}
      if (!this._userCache) {
        try {
          let all = []; let offset = 0;
          while (true) {
            const d = await this._get('/v1/users.json', { offset, size:100 });
            all = all.concat(d.users||[]);
            if ((d.users||[]).length < 100) break;
            offset += 100;
          }
          this._userCache = all.filter(u => u.valid !== false).map(u => ({ code:u.code, name:u.name }));
          this._userCacheTs = now;
          // Firebase に書き戻す（kintoneウィジェットと共有）
          const dir = {};
          this._userCache.forEach(u => { dir[userKey(u.code)] = u; });
          _db?.ref('/user_directory').set(dir).catch(()=>{});
        } catch(e) { console.warn('[api] ユーザー一覧取得失敗:', e.message); this._userCache = await usersFromRoomMembers(); this._userCacheTs = now; }
      }
    }
    const myCode = authStore.get()?.code;
    const base = (this._userCache||[]).filter(u => !CONFIG.EXCLUDED_USER_CODES.includes(u.code) && u.code !== myCode);
    if (!keyword) return base;
    const kw = keyword.toLowerCase();
    return base.filter(u => u.name.toLowerCase().includes(kw) || u.code.toLowerCase().includes(kw));
  },
};

/* ============================================================
 *  kintone 添付ファイル
 * ============================================================ */
const kintoneAttachment = {
  async upload(file) {
    const fileKey = await api.uploadFile(file);
    const rec = {}; rec[CONFIG.ATTACHMENT_FIELD_CODE] = { value:[{ fileKey }] };
    const res = await api.addRecord(CONFIG.APP_ID_ATTACHMENTS, rec);
    return { name:file.name, size:file.size, type:file.type, kintone_record_id:res.id };
  },
  async fetchBlobUrl(recordId) {
    const res = await api.getRecords(CONFIG.APP_ID_ATTACHMENTS, `$id = "${recordId}"`);
    const f = res.records?.[0]?.[CONFIG.ATTACHMENT_FIELD_CODE]?.value?.[0];
    if (!f?.fileKey) throw new Error('添付ファイルが見つかりません');
    const blob = await api.fetchFile(f.fileKey);
    return URL.createObjectURL(blob);
  },
};

/* ============================================================
 *  Dropbox ヘルパー
 * ============================================================ */
const dropbox = {
  async upload(file) {
    const path = `${CONFIG.DROPBOX.UPLOAD_FOLDER}/${Date.now()}_${file.name.replace(/[^\w.\-]/g,'_')}`;
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${CONFIG.DROPBOX.ACCESS_TOKEN}`, 'Dropbox-API-Arg':JSON.stringify({path,mode:'add',autorename:true}), 'Content-Type':'application/octet-stream' },
      body:file,
    });
    if (!r.ok) throw new Error(await r.text());
    const meta = await r.json();
    const lr = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
      method:'POST', headers:{ 'Authorization':`Bearer ${CONFIG.DROPBOX.ACCESS_TOKEN}`, 'Content-Type':'application/json' },
      body:JSON.stringify({ path:meta.path_lower }),
    });
    let url = '';
    if (lr.ok) { const ld = await lr.json(); url = (ld.url||'').replace('?dl=0','?raw=1'); }
    return { name:file.name, size:file.size, type:file.type, url, dropbox_path:path };
  },
};

/* ============================================================
 *  Firebase グローバル
 * ============================================================ */
let _db = null, _auth = null, _fbFn = {};

const initFirebase = async () => {
  if (!firebase.apps.length) firebase.initializeApp(CONFIG.FIREBASE);
  _db   = firebase.database();
  _auth = firebase.auth();
  _fbFn = {
    ref:          p      => _db.ref(p),
    push:         (r,d)  => r.push(d),
    set:          (r,d)  => r.set(d),
    update:       (r,d)  => r.update(d),
    get:          r      => r.once('value'),
    onValue:      (r,cb) => { r.on('value',cb); return ()=>r.off('value',cb); },
    onChildAdded: (r,cb) => { r.on('child_added',cb); return ()=>r.off('child_added',cb); },
    serverTimestamp: () => firebase.database.ServerValue.TIMESTAMP,
  };
  if (!_auth.currentUser) await _auth.signInAnonymously();
};

/* ============================================================
 *  Firebase ヘルパー（ウィジェット版と同一構造）
 * ============================================================ */
const fb = {
  roomsRef:    ()         => _fbFn.ref('rooms'),
  roomRef:     id         => _fbFn.ref(`rooms/${id}`),
  messagesRef: id         => _fbFn.ref(`messages/${id}`),
  messageRef:  (rid,mid)  => _fbFn.ref(`messages/${rid}/${mid}`),

  async getRooms(userCode) {
    const snap = await _fbFn.get(fb.roomsRef());
    const val  = snap.val() || {};
    return Object.entries(val)
      .filter(([,r]) => hasMember(r.members, userCode))
      .map(([id,r]) => ({ id, ...r }))
      .sort((a,b) => (b.last_sent_at||0) - (a.last_sent_at||0));
  },

  async getMessages(roomId) {
    const snap = await _fbFn.get(
      _fbFn.ref(`messages/${roomId}`).orderByChild('sent_at').limitToLast(CONFIG.MESSAGES_PER_PAGE)
    );
    const val = snap.val() || {};
    return Object.entries(val).map(([id,m])=>({id,...m})).sort((a,b)=>a.sent_at-b.sent_at);
  },
};

const usersFromRoomMembers = async () => {
  try {
    if (!_fbFn) await initFirebase();
    const safeDecode = c => {
      if (!c) return c;
      return String(c)
        .replace(/_rb_/g,']').replace(/_lb_/g,'[').replace(/_slash_/g,'/')
        .replace(/_dollar_/g,'$').replace(/_hash_/g,'#').replace(/_dot_/g,'.')
        .replace(/_at_/g,'@').replace(/_us_/g,'_');
    };
    const [roomsSnap, dirSnap] = await Promise.all([
      _fbFn.get(fb.roomsRef()),
      _fbFn.get(_fbFn.ref('user_directory')).catch(() => null),
    ]);
    const val = roomsSnap.val() || {};
    const dir = dirSnap?.val?.() || {};
    const byCode = {};
    Object.values(dir).forEach(u => {
      if (u?.code) byCode[String(u.code).toLowerCase()] = u;
    });
    const codes = new Set();
    Object.values(val).forEach(room => {
      Object.keys(room?.members || {}).forEach(k => codes.add(safeDecode(k)));
    });
    return [...codes].sort().map(code => {
      const u = byCode[String(code).toLowerCase()];
      return { code, name: u?.name || code, email: u?.email || '' };
    });
  } catch {
    return [];
  }
};

const loginCandidates = loginName => {
  const raw = String(loginName || '').trim();
  const lower = raw.toLowerCase();
  const list = [raw, lower];
  if (raw && !raw.includes('@')) list.push(`${lower}@fujibussan.co.jp`);
  return [...new Set(list.filter(Boolean))];
};

const resolveUserFromRooms = async loginName => {
  const users = await usersFromRoomMembers();
  const candidates = loginCandidates(loginName).map(v => v.toLowerCase());
  const exact = users.find(u => candidates.includes(String(u.code).toLowerCase()));
  if (exact) return exact;
  const prefix = String(loginName || '').trim().toLowerCase();
  if (prefix && !prefix.includes('@')) {
    const byMailPrefix = users.find(u => String(u.code).toLowerCase().startsWith(`${prefix}@`));
    if (byMailPrefix) return byMailPrefix;
  }
  return null;
};

/* ============================================================
 *  FCM プッシュ通知
 * ============================================================ */
let _swReg = null;

const registerSW = async () => {
  if (!('serviceWorker' in navigator)) return;
  try {
    // FCM バックグラウンド SW と アプリ SW を両方登録
    // GitHub Pages サブディレクトリ対応: ルート絶対パスではなく baseURI 相対パスを使用
    const swBase = new URL('./', document.baseURI).pathname;
    _swReg = await navigator.serviceWorker.register(swBase + 'firebase-messaging-sw.js', { scope: swBase });
    await navigator.serviceWorker.register(swBase + 'sw.js', { scope: swBase });
    // SW からの open-room メッセージを受信
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'open-room' && e.data.roomId) {
        const room = state.rooms[e.data.roomId];
        if (room) selectRoom(room);
      }
    });
  } catch(e) { console.error('[SW]', e); }
};

const setupFCM = async () => {
  if (!('Notification' in window) || !_swReg) return;
  if (Notification.permission === 'denied') return;
  try {
    const messaging = firebase.messaging();
    const token = await messaging.getToken({
      vapidKey: CONFIG.FCM_VAPID_KEY,
      serviceWorkerRegistration: _swReg,
    });
    if (token && state.currentUser) {
      await _db.ref(`/fcm_tokens/${userKey(state.currentUser.code)}`).set({
        token, updatedAt: Date.now(), platform: 'web-pwa',
      });
    }
    // フォアグラウンド受信（今見ているルームは無視）
    messaging.onMessage(payload => {
      const roomId = payload.data?.roomId;
      if (roomId && roomId === state.currentRoom?.id) return;
      const title = payload.notification?.title || 'Chatone';
      const body  = payload.notification?.body  || '';
      showToast(`🔔 ${title}：${body}`, 'info');
    });
  } catch(e) { console.error('[FCM]', e); }
};

const removeFCMToken = async () => {
  if (!state.currentUser) return;
  try {
    const messaging = firebase.messaging();
    const token = await messaging.getToken({ vapidKey:CONFIG.FCM_VAPID_KEY, serviceWorkerRegistration:_swReg });
    if (token) await messaging.deleteToken(token);
    await _db.ref(`/fcm_tokens/${userKey(state.currentUser.code)}`).remove();
  } catch {}
};

/* ============================================================
 *  アバター IndexedDB キャッシュ
 * ============================================================ */
const avatarIdb = {
  async get(key) {
    try {
      const item = await idb.get('cache', `av:${key}`);
      if (!item || Date.now()-item.ts > CONFIG.AVATAR_CACHE_TTL) return null;
      return item.dataUrl;
    } catch { return null; }
  },
  async set(key, dataUrl) {
    try { await idb.set('cache', `av:${key}`, { dataUrl, ts:Date.now() }); } catch {}
  },
  async clearAll() {
    try {
      const keys = await idb.keys('cache');
      await Promise.all(keys.filter(k=>k.startsWith('av:')).map(k=>idb.del('cache',k)));
    } catch {}
  },
};

/* ============================================================
 *  状態管理
 * ============================================================ */
const state = {
  currentUser:       null,
  currentRoom:       null,
  rooms:             {},
  messages:          [],
  isMobile:          window.innerWidth < 768,
  isComposing:       false,
  totalUnread:       0,
  selectedUsers:     [],
  pendingFiles:      [],
  avatarCache:       {},
  pendingMsgKeys:    new Set(),
  _roomsListener:    null,
  _messagesListener: null,
  _prevRooms:        {},
};

const isNightMode = () => {
  const h=new Date().getHours(), s=CONFIG.NIGHT_MODE_START, e=CONFIG.NIGHT_MODE_END;
  return s>e ? (h>=s||h<e) : (h>=s&&h<e);
};

/* ============================================================
 *  ログイン画面
 * ============================================================ */
const showLoginScreen = () => {
  hideSplash();
  document.getElementById('app-root').innerHTML = `
    <div class="co-login-screen">
      <div class="co-login-card">
        <div class="co-login-logo">
          <span class="co-login-logo-icon">💬</span>
          <span class="co-login-logo-text">Chatone</span>
        </div>
        <p class="co-login-desc">kintoneのログイン情報でサインイン</p>

        <form id="l-form" onsubmit="return false;" autocomplete="on">
          <label class="co-login-label">kintoneドメイン</label>
          <div class="co-login-domain-row">
            <input id="l-domain" class="co-login-input" type="text" value="${CONFIG.KINTONE_SUBDOMAIN}"
              autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="your-domain"
              autocomplete="username" />
            <span class="co-login-domain-suffix">.cybozu.com</span>
          </div>

          <label class="co-login-label">ログイン名</label>
          <input id="l-name" class="co-login-input" type="text" autocorrect="off" autocapitalize="off"
            spellcheck="false" placeholder="例: tsumura" autocomplete="username" />

          <label class="co-login-label">パスワード</label>
          <input id="l-pass" class="co-login-input" type="password" placeholder="••••••••"
            autocomplete="current-password" />

          <button class="co-login-btn" id="l-btn" type="button">ログイン</button>
          <div class="co-login-error hidden" id="l-err"></div>
        </form>

        <p class="co-login-note">
          ログイン情報はこの端末のブラウザ内にのみ保存され、<br>
          外部サーバーへは送信されません。
        </p>
      </div>
    </div>`;

  const btn = document.getElementById('l-btn');
  const err = document.getElementById('l-err');

  const doLogin = async () => {
    const subdomain  = document.getElementById('l-domain').value.trim();
    const loginName  = document.getElementById('l-name').value.trim();
    const password   = document.getElementById('l-pass').value;
    err.classList.add('hidden');
    if (!subdomain||!loginName||!password) {
      err.textContent='すべての項目を入力してください'; err.classList.remove('hidden'); return;
    }
    btn.disabled=true; btn.textContent='確認中…';
    try {
      // Firebase Functions プロキシ経由で kintone へ接続確認
      // /k/v1/records.json にlimit=1でアクセス（一般ユーザーが確実に使えるAPI）
      const auth = btoa(`${loginName}:${password}`);
      const proxyUrl = CONFIG.PROXY_ENDPOINTS.kintoneProxy;

      let verifyRes;
      try {
        verifyRes = await fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subdomain,
            path: '/k/v1/apps.json',
            method: 'GET',
            auth,
            params: { limit: '1' },
          }),
        });
      } catch (networkErr) {
        throw new Error('プロキシサーバーへの接続に失敗しました。PROXY_ENDPOINTS の設定を確認してください。');
      }
      // 401/520=認証失敗、200/400/403=認証成功（権限エラーも認証は通っている）
      if (verifyRes.status === 401 || verifyRes.status === 520) {
        throw new Error('ログイン名またはパスワードが正しくありません');
      }
      if (verifyRes.status >= 502) {
        throw new Error(`プロキシサーバーエラー (${verifyRes.status})`);
      }

      // ユーザー情報をFirebase /user_directoryから取得
      let code = loginName, name = loginName;
      try {
        if (_db) {
          const encKey = encodeUserCode(loginName);
          const snap = await _db.ref(`/user_directory/${encKey}`).get();
          if (snap.exists()) {
            const u = snap.val();
            code = u.code || loginName;
            name = u.name || loginName;
          } else {
            const allSnap = await _db.ref('/user_directory').get();
            if (allSnap.exists()) {
              const users = Object.values(allSnap.val() || {});
              const found = users.find(u =>
                u.code === loginName ||
                u.loginName === loginName ||
                (u.code && u.code.toLowerCase() === loginName.toLowerCase())
              );
              if (found) { code = found.code || loginName; name = found.name || loginName; }
            }
          }
        }
      } catch {}

      const resolved = await resolveUserFromRooms(loginName);
      if (resolved && resolved.code) {
        code = resolved.code;
        if (name === loginName) name = resolved.name || resolved.code;
      }

      await authStore.save({ subdomain, loginName, password, code, name });
      await startApp();
    } catch(e) {
      err.textContent=e.message||'ログインに失敗しました'; err.classList.remove('hidden');
      btn.disabled=false; btn.textContent='ログイン';
    }
  };

  btn.addEventListener('click', doLogin);
  ['l-domain','l-name','l-pass'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
  });
  document.getElementById('l-name')?.focus();
};

/* ============================================================
 *  スプラッシュ制御
 * ============================================================ */
const setSplashStatus = msg => { const el=document.getElementById('splash-status'); if(el) el.textContent=msg; };
const hideSplash = () => { const el=document.getElementById('splash'); if(el) el.style.display='none'; };

/* ============================================================
 *  ログアウト
 * ============================================================ */
const logout = async () => {
  if (!await showConfirm('ログアウトしますか？\nこの端末のログイン情報が削除されます。')) return;
  await removeFCMToken();
  state._roomsListener?.();    state._roomsListener    = null;
  state._messagesListener?.(); state._messagesListener = null;
  await authStore.clear();
  state.currentUser = null; state.currentRoom = null; state.rooms = {};
  showLoginScreen();
};

/* ============================================================
 *  アプリ起動
 * ============================================================ */
const startApp = async () => {
  setSplashStatus('接続中…');
  try {
    await initFirebase();

    const root = document.getElementById('app-root');
    root.innerHTML = '';
    const container = document.createElement('div');
    container.id = 'chatone-app';
    root.appendChild(container);

    buildUI();
    bindEvents();
    loadBgColorPref();
    hideSplash();

    state.currentUser = authStore.get();

    // サイドバーにユーザー表示
    const uEl = document.getElementById('sidebar-user');
    if (uEl) {
      uEl.innerHTML = `
        <div class="user-avatar co-avatar-clickable" id="sidebar-my-avatar" title="アイコンを変更">${getInitial(state.currentUser.name)}</div>
        <span class="user-name">${escapeHTML(state.currentUser.name)}</span>`;
      document.getElementById('sidebar-my-avatar')?.addEventListener('click', openMyAvatarPicker);
    }

    // 通知ボタン初期化
    initNotifyButton();

    // ルーム＋ユーザー一覧を並行取得
    const [,rooms] = await Promise.all([
      api.searchUsers('').catch(e => console.warn('ユーザー一覧先読み失敗:', e)),
      fb.getRooms(state.currentUser.code),
    ]);
    let effectiveRooms = rooms;
    if (!effectiveRooms.length) {
      const resolved = await resolveUserFromRooms(state.currentUser.loginName || state.currentUser.code);
      if (resolved && resolved.code && resolved.code !== state.currentUser.code) {
        state.currentUser = { ...state.currentUser, code: resolved.code, name: resolved.name || state.currentUser.name };
        await authStore.save(state.currentUser);
        effectiveRooms = await fb.getRooms(state.currentUser.code);
      }
    }
    state.rooms = {};
    effectiveRooms.forEach(r => { state.rooms[r.id] = r; });
    updateTitleBadge();
    renderRoomList(state.rooms);
    attachRoomsListener();

    if (CONFIG.APP_ID_AVATARS) loadAllAvatars().catch(e => console.error('アバターロード失敗:', e));

    // URLパラメータ ?room=xxx で直接ルームを開く（通知タップ時）
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (urlRoom && state.rooms[urlRoom]) selectRoom(state.rooms[urlRoom]);

    // ?new=1 で新規トークモーダルを開く（ショートカット対応）
    if (new URLSearchParams(location.search).get('new') === '1') {
      openModal('modal-new-room');
      history.replaceState(null,'','/');
    }

  } catch(e) {
    console.error('[Chatone PWA] 起動エラー:', e);
    setSplashStatus('エラー: ' + e.message);
  }
};

/* ============================================================
 *  通知ボタン
 * ============================================================ */
const initNotifyButton = () => {
  const btn = document.getElementById('btn-notify');
  if (!btn) return;
  const update = () => {
    if (Notification.permission === 'granted') {
      btn.textContent = '🔔'; btn.title = '通知ON'; btn.classList.add('granted');
    } else {
      btn.textContent = '🔕'; btn.title = '通知をONにする'; btn.classList.remove('granted');
    }
  };
  update();
  btn.addEventListener('click', async () => {
    if (Notification.permission === 'granted') return;
    const r = await Notification.requestPermission();
    if (r === 'granted') { await setupFCM(); showToast('通知を有効にしました', 'success'); }
    update();
  });
  if (Notification.permission === 'granted') setupFCM();
};

/* ============================================================
 *  UI 構築（FABなし・常に全画面表示）
 * ============================================================ */
const buildUI = () => {
  document.getElementById('chatone-app').innerHTML = `
  <div class="co-pwa-root" id="co-pwa-root">

    <!-- サイドバー（ルーム一覧） -->
    <aside class="chatone-sidebar" id="chatone-sidebar">
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <span class="logo-icon">💬</span>
          <span class="logo-text">Chatone</span>
        </div>
        <div class="sidebar-user" id="sidebar-user"></div>
        <button class="btn-notify-icon" id="btn-notify" title="通知をONにする">🔕</button>
        <button class="btn-new-room-icon" id="btn-new-room" title="新しいトーク">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <div class="search-wrap">
        <input class="room-search" id="room-search" type="search" placeholder="トークを検索…" />
      </div>
      <ul class="room-list" id="room-list">
        <li class="room-loading">読み込み中…</li>
      </ul>
      <button class="btn-logout" id="btn-logout">⏻ ログアウト</button>
    </aside>

    <!-- チャットエリア -->
    <main class="chatone-main" id="chatone-main">
      <div class="chat-empty" id="chat-empty">
        <div class="empty-icon">💬</div>
        <div class="empty-title">Chatone</div>
        <div class="empty-sub">トークを選んでメッセージを始めよう</div>
      </div>

      <div class="chat-area hidden" id="chat-area">
        <div class="chat-header" id="chat-header">
          <button class="btn-back" id="btn-back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div class="chat-header-info">
            <div class="chat-header-name" id="chat-header-name">—</div>
            <div class="chat-header-members" id="chat-header-members"></div>
          </div>
          <div class="chat-header-actions">
            <button class="btn-bg-color" id="btn-bg-color" title="背景色を変更">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.78 1.5-1.5 0-.4-.16-.76-.42-1.03-.25-.26-.41-.62-.41-1.02 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8z"/></svg>
            </button>
            <button class="btn-members" id="btn-members" title="メンバー">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </button>
          </div>
        </div>

        <div class="message-list" id="message-list">
          <div class="msg-loading" id="msg-loading">読み込み中…</div>
        </div>

        <div class="input-area">
          <label class="btn-attach" title="ファイル添付">
            <input type="file" id="file-input" multiple style="display:none" />
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </label>
          ${CONFIG.APP_ID_STAMPS ? `<button class="btn-stamp" id="btn-stamp" title="スタンプ">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none"/><path d="M8.5 14.5 Q12 17.5 15.5 14.5" fill="none"/></svg>
          </button>` : ''}
          <div class="input-wrap">
            <div class="msg-input" id="msg-input" contenteditable="true" data-placeholder="メッセージを入力…"></div>
            <div class="attach-preview" id="attach-preview"></div>
          </div>
          <button class="btn-send" id="btn-send">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>
    </main>

    <!-- 新規ルーム作成モーダル -->
    <div class="modal-overlay hidden" id="modal-new-room">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">新しいトークを作成</span>
          <button class="modal-close" id="modal-close">✕</button>
        </div>
        <div class="modal-body">
          <label class="form-label">メンバーを追加（名前で検索）</label>
          <div class="user-search-wrap">
            <input class="form-input" type="text" id="user-search-input" placeholder="名前を入力して検索…" autocomplete="off" />
            <ul class="user-search-dropdown hidden" id="user-search-dropdown"></ul>
          </div>
          <div class="selected-users" id="selected-users"></div>
          <div id="room-name-wrap" class="hidden">
            <label class="form-label" style="margin-top:14px">トーク名（任意）</label>
            <input class="form-input" type="text" id="new-room-name" placeholder="例: 営業チーム（未入力で自動設定）" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" id="btn-cancel-room">キャンセル</button>
          <button class="btn-create" id="btn-create-room" disabled>トークを開始</button>
        </div>
      </div>
    </div>

    <!-- メンバー管理モーダル -->
    <div class="modal-overlay hidden" id="modal-members">
      <div class="modal modal-members-panel">
        <div class="modal-header">
          <span class="modal-title" id="members-modal-title">メンバー管理</span>
          <button class="modal-close" id="members-modal-close">✕</button>
        </div>
        <div class="modal-body">
          <div id="members-list"></div>
          <div id="members-add-wrap" class="members-add-wrap hidden">
            <div class="members-section-label">メンバーを追加</div>
            <div class="user-search-wrap" style="margin-bottom:0">
              <input class="form-input" type="text" id="members-add-input" placeholder="名前を入力して検索…" autocomplete="off" />
              <ul class="user-search-dropdown hidden" id="members-add-dropdown"></ul>
            </div>
          </div>
        </div>
        <div class="modal-footer" id="members-modal-footer">
          <button class="btn-leave-room hidden" id="btn-leave-room">退出する</button>
          <button class="btn-delete-room hidden" id="btn-delete-room">トークを削除</button>
        </div>
      </div>
    </div>

    <!-- 確認モーダル -->
    <div class="modal-overlay hidden" id="modal-confirm">
      <div class="modal co-confirm-modal">
        <div class="modal-body co-confirm-body">
          <p class="co-confirm-msg" id="co-confirm-msg"></p>
        </div>
        <div class="modal-footer co-confirm-footer">
          <button class="btn-cancel" id="co-confirm-cancel">いいえ</button>
          <button class="btn-create co-confirm-ok" id="co-confirm-ok">はい</button>
        </div>
      </div>
    </div>

    <div class="toast-container" id="toast-container"></div>
  </div>`;
};

/* ============================================================
 *  ルーム表示名
 * ============================================================ */
const getRoomDisplayName = (room, myCode) => {
  if (room.is_dm) {
    const other = getMemberCodes(room.members).find(c => c !== myCode);
    if (other && api._userCache) { const u = api._userCache.find(u=>u.code===other); if(u) return u.name; }
    const n = room.room_name || '';
    return n.startsWith('@') ? n.slice(1) : (other || n);
  }
  return room.room_name || getMemberCodes(room.members).filter(c=>c!==myCode).join('、');
};

/* ============================================================
 *  ルーム一覧レンダリング
 * ============================================================ */
const renderRoomList = (roomsObj, filter='') => {
  const list = document.getElementById('room-list');
  if (!list) return;
  const user  = state.currentUser;
  const rooms = Object.entries(roomsObj||{})
    .filter(([,r]) => hasMember(r.members, user.code))
    .map(([id,r]) => ({ id, ...r }))
    .sort((a,b) => (b.last_sent_at||0) - (a.last_sent_at||0));
  const filtered = filter
    ? rooms.filter(r => getRoomDisplayName(r,user.code).toLowerCase().includes(filter.toLowerCase()))
    : rooms;

  if (filtered.length===0) { list.innerHTML='<li class="room-empty">トークがありません</li>'; return; }

  list.innerHTML = filtered.map(room => {
    const unread = unreadCount(room, user.code);
    const isActive = state.currentRoom?.id === room.id;
    const dn = getRoomDisplayName(room, user.code);
    return `
      <li class="room-item ${isActive?'active':''}" data-room-id="${room.id}">
        <div class="room-avatar">${getRoomInitial(dn)}</div>
        <div class="room-info">
          <div class="room-top">
            <span class="room-name">${escapeHTML(dn)}</span>
            <span class="room-time">${formatTime(room.last_sent_at)}</span>
          </div>
          <div class="room-bottom">
            <span class="room-last-msg">${escapeHTML(room.last_message||'メッセージなし')}</span>
            ${unread>0 ? `<span class="unread-badge">${unread>99?'99+':unread}</span>` : ''}
          </div>
        </div>
      </li>`;
  }).join('');

  list.querySelectorAll('.room-item').forEach(el => {
    el.addEventListener('click', () => {
      const room = state.rooms[el.dataset.roomId];
      if (room) selectRoom({ id:el.dataset.roomId, ...room });
    });
  });
  if (CONFIG.APP_ID_AVATARS) refreshAllAvatarElements();
};

/* ============================================================
 *  メッセージレンダリング（ウィジェット版をほぼそのまま移植）
 * ============================================================ */
const renderMessages = (messages) => {
  const list = document.getElementById('message-list');
  if (!list) return;
  const user = state.currentUser;
  document.getElementById('msg-loading')?.remove();
  const existingIds = new Set(Array.from(list.querySelectorAll('[data-msg-id]')).map(el=>el.dataset.msgId));
  const scrolledToBottom = list.scrollHeight - list.clientHeight - list.scrollTop < 120;

  messages.forEach(msg => {
    if (existingIds.has(msg.id)) return;
    const isMine  = msg.sender === user.code;
    const isStamp = msg.msg_type === 'stamp';
    const readByOthers = Object.keys(msg.read_by||{}).map(decodeUserCode).filter(c=>c!==msg.sender);
    const isRead  = readByOthers.length > 0;
    const readNames = readByOthers.map(code => {
      const u = api._userCache?.find(u=>u.code===code);
      return u?.name || code;
    });

    if (msg.msg_type === 'system') {
      list.insertAdjacentHTML('beforeend', `<div class="msg-system" data-msg-id="${msg.id}">${escapeHTML(msg.body)}</div>`);
      return;
    }
    if (msg.msg_type === 'deleted') {
      if (isMine) return;
      const el = document.createElement('div');
      el.className = 'msg-bubble-wrap theirs'; el.dataset.msgId = msg.id;
      el.innerHTML = `
        <div class="msg-avatar-col">
          <div class="msg-avatar" data-sender="${escapeHTML(msg.sender)}" data-initial="${escapeHTML(getInitial(msg.sender_name||msg.sender))}">${getInitial(msg.sender_name||msg.sender)}</div>
          <div class="msg-sender-name">${escapeHTML(msg.sender_name||msg.sender)}</div>
        </div>
        <div class="msg-content">
          <div class="msg-bubble-row"><div class="msg-bubble"><div class="msg-text msg-deleted">このメッセージは削除されました</div></div></div>
          <div class="msg-meta"><span class="msg-time">${formatDateTime(msg.sent_at)}</span></div>
        </div>`;
      list.appendChild(el); return;
    }

    const bodyHTML = msg.body ? linkify(escapeHTML(msg.body)) : '';
    const att = msg.attachment;
    let attachHTML = '';
    if (att?.kintone_record_id) {
      const isImg = /^image\//i.test(att.type||'')||/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(att.name||'');
      attachHTML = `<div class="msg-attach-chip" data-att-record-id="${escapeHTML(String(att.kintone_record_id))}" data-att-name="${escapeHTML(att.name||'file')}" data-att-image="${isImg?'1':'0'}">
        <span class="msg-attach-icon">${isImg?'🖼️':'📎'}</span>
        <span class="msg-attach-info"><span class="msg-attach-name">${escapeHTML(att.name||'file')}</span>
        <span class="msg-attach-sub">${escapeHTML(formatFileSize(att.size))}${att.size?' ・ ':''}クリックして${isImg?'表示':'ダウンロード'}</span></span></div>`;
    } else if (att?.url) {
      const isImg = /^image\//i.test(att.type||'')||/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(att.name||'');
      attachHTML = isImg
        ? `<div class="msg-image-wrap"><img class="msg-image" src="${escapeHTML(att.url)}" alt="${escapeHTML(att.name||'')}" data-lightbox-url="${escapeHTML(att.url)}" data-lightbox-name="${escapeHTML(att.name||'')}" style="cursor:zoom-in"/></div>`
        : `<div class="msg-file"><a class="msg-file-btn" href="${escapeHTML(att.url)}" target="_blank" rel="noopener noreferrer" download="${escapeHTML(att.name||'file')}">📎 ${escapeHTML(att.name||'file')}</a></div>`;
    }

    const el = document.createElement('div');
    el.className = `msg-bubble-wrap ${isMine?'mine':'theirs'}${isStamp?' stamp-msg':''}`;
    el.dataset.msgId = msg.id;

    if (isStamp) {
      el.innerHTML = `
        ${!isMine?`<div class="msg-avatar-col"><div class="msg-avatar" data-sender="${escapeHTML(msg.sender)}" data-initial="${escapeHTML(getInitial(msg.sender_name||msg.sender))}">${getInitial(msg.sender_name||msg.sender)}</div><div class="msg-sender-name">${escapeHTML(msg.sender_name||msg.sender)}</div></div>`:''}
        <div class="msg-content">
          <div class="msg-bubble-row"><div class="msg-bubble"><div class="msg-stamp-wrap"><span class="msg-stamp-loading">⏳</span></div></div></div>
          <div class="msg-meta">${isMine?`<span class="msg-read">${isRead?'既読':''}</span>`:''}<span class="msg-time">${formatDateTime(msg.sent_at)}</span></div>
        </div>`;
      list.appendChild(el);
      if (isMine) bindReadReceiptPopover(el, readNames);
      (async () => {
        const wrap = el.querySelector('.msg-stamp-wrap'); if (!wrap) return;
        await loadStamps();
        const stamp = _stampCache?.find(s=>(s.stamp_id?.value||s.$id?.value)===msg.body);
        if (stamp?._objectUrl) {
          const img = document.createElement('img'); img.className='msg-stamp'; img.alt='';
          img.onload = () => { list.scrollTop = list.scrollHeight; };
          img.src = stamp._objectUrl; wrap.innerHTML=''; wrap.appendChild(img);
        } else { wrap.innerHTML='<span class="msg-stamp-fallback">🎭</span>'; }
      })();
      return;
    }

    el.innerHTML = `
      ${!isMine?`<div class="msg-avatar-col"><div class="msg-avatar" data-sender="${escapeHTML(msg.sender)}" data-initial="${escapeHTML(getInitial(msg.sender_name||msg.sender))}">${getInitial(msg.sender_name||msg.sender)}</div><div class="msg-sender-name">${escapeHTML(msg.sender_name||msg.sender)}</div></div>`:''}
      <div class="msg-content">
        <div class="msg-bubble-row">
          <div class="btn-delete-msg-placeholder"></div>
          <div class="msg-bubble">${bodyHTML?`<div class="msg-text">${bodyHTML}</div>`:''}${attachHTML}</div>
        </div>
        <div class="msg-meta">${isMine?`<span class="msg-read">${isRead?'既読':''}</span>`:''}<span class="msg-time">${formatDateTime(msg.sent_at)}</span></div>
      </div>`;
    list.appendChild(el);
    if (isMine) bindReadReceiptPopover(el, readNames);
    el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); showMsgContextMenu(e,msg,isMine,isRead); });
    el.addEventListener('touchstart', (() => { let t; return () => { t=setTimeout(()=>{ showMsgContextMenu({clientX:50,clientY:200},msg,isMine,isRead); },600); el.addEventListener('touchend',()=>clearTimeout(t),{once:true}); }; })(), {passive:true});
    el.querySelectorAll('[data-lightbox-url]').forEach(img => img.addEventListener('click', ()=>openImageLightbox(img.dataset.lightboxUrl,img.dataset.lightboxName)));
    el.querySelectorAll('.msg-attach-chip').forEach(chip => chip.addEventListener('click', ()=>handleAttachmentChipClick(chip)));
  });

  if (scrolledToBottom) list.scrollTop = list.scrollHeight;
};

/* ============================================================
 *  画像ライトボックス
 * ============================================================ */
const openImageLightbox = (url, name) => {
  const o = document.createElement('div'); o.className='co-image-lightbox';
  o.innerHTML = `<div class="co-lightbox-toolbar"><a class="co-lightbox-btn" href="${escapeHTML(url)}" download="${escapeHTML(name||'image')}" target="_blank" rel="noopener noreferrer">⬇ ダウンロード</a><button class="co-lightbox-btn co-lightbox-close-btn">✕ 閉じる</button></div><img src="${escapeHTML(url)}" alt="${escapeHTML(name||'')}"/>`;
  o.querySelector('.co-lightbox-toolbar')?.addEventListener('click', e=>e.stopPropagation());
  o.querySelector('.co-lightbox-close-btn')?.addEventListener('click', ()=>o.remove());
  o.addEventListener('click', ()=>o.remove());
  document.body.appendChild(o);
};

/* ============================================================
 *  添付チップクリック（kintone 遅延取得）
 * ============================================================ */
const handleAttachmentChipClick = async (chip) => {
  if (chip.dataset.loading==='1') return;
  const isImage = chip.dataset.attImage==='1';
  const name = chip.dataset.attName||'file';
  if (chip.dataset.objectUrl) { openOrDownload(chip.dataset.objectUrl, name, isImage); return; }
  const sub = chip.querySelector('.msg-attach-sub');
  const orig = sub?.textContent||'';
  chip.dataset.loading='1'; if(sub) sub.textContent='取得中…';
  try {
    const u = await kintoneAttachment.fetchBlobUrl(chip.dataset.attRecordId);
    chip.dataset.objectUrl = u; openOrDownload(u, name, isImage);
    if(sub) sub.textContent = isImage?'クリックして表示':'クリックしてダウンロード';
  } catch(e) { showToast('ファイルの取得に失敗しました','error'); if(sub) sub.textContent=orig; }
  finally { chip.dataset.loading='0'; }
};

const openOrDownload = (url, name, isImage) => {
  if (isImage) { openImageLightbox(url,name); return; }
  const a=document.createElement('a'); a.href=url; a.download=name||'file';
  document.body.appendChild(a); a.click(); a.remove();
};

/* ============================================================
 *  既読ポップオーバー
 * ============================================================ */
let _readPop = null;
const bindReadReceiptPopover = (el, readNames) => {
  const span = el.querySelector('.msg-read');
  if (!span||!readNames?.length) return;
  span.classList.add('has-names');
  let t;
  span.addEventListener('mouseenter', ()=>{ t=setTimeout(()=>showReadPop(span,readNames),220); });
  span.addEventListener('mouseleave', ()=>clearTimeout(t));
  span.addEventListener('click', e=>{ e.stopPropagation(); if(_readPop){hideReadPop();return;} showReadPop(span,readNames); });
};
const showReadPop = (anchor, names) => {
  hideReadPop();
  const p = document.createElement('div'); p.className='co-read-popover';
  p.innerHTML = `<div class="co-read-popover-title">既読 ${names.length}人</div>`+names.map(n=>`<div class="co-read-popover-name">${escapeHTML(n)}</div>`).join('');
  document.body.appendChild(p);
  const rect=anchor.getBoundingClientRect();
  let left=rect.right-p.offsetWidth, top=rect.top-p.offsetHeight-8;
  left=Math.max(8,Math.min(left,window.innerWidth-p.offsetWidth-8));
  if(top<8) top=rect.bottom+8;
  p.style.cssText=`position:fixed;left:${left}px;top:${top}px`;
  _readPop=p;
  setTimeout(()=>document.addEventListener('click',_readPopOut),0);
};
const hideReadPop = () => { _readPop?.remove(); _readPop=null; document.removeEventListener('click',_readPopOut); };
const _readPopOut = e => { if(_readPop&&!_readPop.contains(e.target)) hideReadPop(); };

/* ============================================================
 *  ルーム選択
 * ============================================================ */
const selectRoom = async (room) => {
  if (state._messagesListener) { state._messagesListener(); state._messagesListener=null; }
  state.currentRoom=room; state.messages=[];

  if (state.isMobile) {
    document.getElementById('chatone-sidebar')?.classList.add('hidden-mobile');
  }
  document.getElementById('chat-empty')?.classList.add('hidden');
  document.getElementById('chat-area')?.classList.remove('hidden');

  const dn = getRoomDisplayName(room, state.currentUser.code);
  document.getElementById('chat-header-name').textContent = dn;
  document.getElementById('chat-header-members').textContent = `メンバー ${getMemberCodes(room.members).length}人`;

  document.getElementById('message-list').innerHTML = '<div class="msg-loading" id="msg-loading">読み込み中…</div>';
  renderRoomList(state.rooms);
  await clearUnread(room);

  try {
    const msgs = await fb.getMessages(room.id);
    const list  = document.getElementById('message-list');
    if (msgs.length===0) { list.innerHTML='<div class="msg-no-content">メッセージはまだありません</div>'; }
    else {
      list.innerHTML='';
      renderMessages(msgs);
      list.scrollTop = list.scrollHeight;
      await markAsRead(msgs, room.id);
      if (CONFIG.APP_ID_AVATARS) refreshAllAvatarElements();
    }
  } catch(e) { showToast('メッセージの取得に失敗しました','error'); console.error(e); }

  // リアルタイムリスナー
  const startTime = Date.now();
  const ref = _fbFn.ref(`messages/${room.id}`).orderByChild('sent_at').startAt(startTime);
  const cb = snap => {
    const msg = snap.val(); if(!msg) return;
    const m = { id:snap.key, ...msg };
    if (state.pendingMsgKeys.has(snap.key)) { state.pendingMsgKeys.delete(snap.key); return; }
    renderMessages([m]);
    markAsRead([m], room.id);
    if (msg.sender!==state.currentUser.code && !isNightMode()) {
      const dn2=getRoomDisplayName(state.currentRoom,state.currentUser.code);
      showBrowserNotification(`${dn2} ${msg.sender_name||msg.sender}`, msg.body||(msg.msg_type==='stamp'?'(スタンプ)':'(ファイル)'), room.id);
    }
  };
  ref.on('child_added', cb);
  state._messagesListener = () => ref.off('child_added', cb);
};

/* ============================================================
 *  ルームリスナー
 * ============================================================ */
const attachRoomsListener = () => {
  state._roomsListener?.();
  const cb = snap => {
    const val = snap.val()||{};
    const user = state.currentUser;
    const prev = state._prevRooms||{};
    Object.entries(val).forEach(([id,room]) => {
      if (!hasMember(room.members,user.code)) return;
      const prevU = prev[id] ? unreadCount(prev[id],user.code) : 0;
      const nowU  = unreadCount(room,user.code);
      if (nowU>prevU && state.currentRoom?.id!==id) {
        showBrowserNotification(`${getRoomDisplayName({id,...room},user.code)} ${room.last_sender_name||''}`, room.last_message||'新しいメッセージ', id);
      }
    });
    state._prevRooms = JSON.parse(JSON.stringify(val));
    state.rooms = val;
    updateTitleBadge();
    renderRoomList(state.rooms, document.getElementById('room-search')?.value||'');
  };
  fb.roomsRef().on('value', cb);
  state._roomsListener = () => fb.roomsRef().off('value', cb);
};

/* ============================================================
 *  ブラウザ通知（フォアグラウンド用フォールバック）
 * ============================================================ */
const showBrowserNotification = (title, body, roomId) => {
  if (Notification.permission!=='granted') return;
  if (isNightMode()) return;
  try {
    const n = new Notification(title, {
      body, icon:'/icons/icon-192.png', tag:roomId||'chatone',
      renotify:true, data:{ roomId },
    });
    n.addEventListener('click', () => { window.focus(); if(roomId&&state.rooms[roomId]) selectRoom(state.rooms[roomId]); n.close(); });
  } catch {}
};

/* ============================================================
 *  メッセージ送信
 * ============================================================ */
const sendMessage = async () => {
  const input = document.getElementById('msg-input');
  const body  = input.innerText.trim();
  const files = state.pendingFiles.length>0 ? state.pendingFiles : [];
  if (!body&&files.length===0) return;
  if (!state.currentRoom) return;
  const roomId=state.currentRoom.id, user=state.currentUser;
  const btn = document.getElementById('btn-send');
  btn.disabled=true; btn.classList.add('sending');
  try {
    let attachment=null;
    if (files.length>0) {
      showToast('ファイルをアップロード中…','info');
      try {
        attachment = CONFIG.ATTACHMENT_STORAGE==='dropbox' ? await dropbox.upload(files[0]) : await kintoneAttachment.upload(files[0]);
      } catch(e) { showToast(`"${files[0].name}" のアップロードに失敗しました`,'error'); btn.disabled=false; btn.classList.remove('sending'); return; }
    }
    const now=Date.now(), ref=fb.messagesRef(roomId).push(), key=ref.key;
    state.pendingMsgKeys.add(key);
    const msgData = { sender:user.code, sender_name:user.name, body:body||'', msg_type:attachment?(/^image\//i.test(attachment.type||'')?'image':'file'):'text', sent_at:now, read_by:{ [userKey(user.code)]:true }, ...(attachment?{attachment}:{}) };
    renderMessages([{ id:key, ...msgData }]);
    document.getElementById('message-list').scrollTop = 99999;
    input.innerHTML=''; state.pendingFiles=[];
    document.getElementById('attach-preview').innerHTML='';
    document.getElementById('file-input').value='';
    await ref.set(msgData);
    const members=getMemberCodes(state.currentRoom.members);
    const uu={};
    members.forEach(c => { if(c!==user.code) uu[`unread/${userKey(c)}`]=(unreadCount(state.rooms[roomId],c)||0)+1; });
    await fb.roomRef(roomId).update({ last_message:body||(attachment?`📎 ${attachment.name}`:'(ファイル)'), last_sender_name:user.name, last_sent_at:now, ...uu });
  } catch(e) { showToast('送信に失敗しました','error'); console.error(e); }
  finally { btn.disabled=false; btn.classList.remove('sending'); }
};

/* ============================================================
 *  スタンプ送信
 * ============================================================ */
const sendStamp = async (stampId) => {
  if (!state.currentRoom) return;
  const roomId=state.currentRoom.id, user=state.currentUser, now=Date.now();
  const ref=fb.messagesRef(roomId).push(); state.pendingMsgKeys.add(ref.key);
  const msgData={ sender:user.code, sender_name:user.name, body:stampId, msg_type:'stamp', sent_at:now, read_by:{ [userKey(user.code)]:true } };
  renderMessages([{ id:ref.key, ...msgData }]);
  document.getElementById('message-list').scrollTop=99999;
  try {
    await ref.set(msgData);
    const uu={};
    getMemberCodes(state.currentRoom.members).forEach(c=>{ if(c!==user.code) uu[`unread/${userKey(c)}`]=(unreadCount(state.rooms[roomId],c)||0)+1; });
    await fb.roomRef(roomId).update({ last_message:'(スタンプ)', last_sender_name:user.name, last_sent_at:now, ...uu });
  } catch(e) { showToast('スタンプの送信に失敗しました','error'); }
};

/* ============================================================
 *  既読・未読
 * ============================================================ */
const markAsRead = async (messages, roomId) => {
  const user=state.currentUser, rid=roomId||state.currentRoom?.id;
  if (!rid) return;
  const updates={};
  messages.forEach(msg => { if(msg.sender===user.code||isReadBy(msg,user.code)) return; updates[`messages/${rid}/${msg.id}/read_by/${userKey(user.code)}`]=true; });
  if (!Object.keys(updates).length) return;
  _db.ref('/').update(updates).catch(e=>console.error('既読更新エラー:',e));
};

const clearUnread = async (room) => {
  if (unreadCount(room,state.currentUser.code)>0)
    await fb.roomRef(room.id).update({ [`unread/${userKey(state.currentUser.code)}`]:0 }).catch(()=>{});
};

const updateTitleBadge = () => {
  const user=state.currentUser; if(!user) return;
  state.totalUnread = Object.values(state.rooms).reduce((s,r)=>s+unreadCount(r,user.code),0);
  document.title = state.totalUnread>0 ? `(${state.totalUnread}) Chatone` : 'Chatone';
};

/* ============================================================
 *  ルーム作成（ウィジェット版と同一ロジック）
 * ============================================================ */
const createRoom = async () => {
  if (state.selectedUsers.length===0) { showToast('メンバーを選択してください','error'); return; }
  const user=state.currentUser, isDM=state.selectedUsers.length===1, other=state.selectedUsers[0];
  if (isDM) {
    const existing = Object.entries(state.rooms).find(([,r]) => {
      if (!r.is_dm) return false;
      const m=getMemberCodes(r.members);
      return m.length===2&&m.includes(user.code)&&m.includes(other.code);
    });
    if (existing) { await selectRoom({id:existing[0],...existing[1]}); closeModal('modal-new-room'); state.selectedUsers=[]; return; }
  }
  const groupName = document.getElementById('new-room-name')?.value.trim()||'';
  const allCodes  = [user.code, ...state.selectedUsers.map(u=>u.code)];
  const roomName  = isDM ? `@${other.code}` : (groupName||allCodes.join('、').slice(0,40));
  const membersMap={};
  allCodes.forEach(c=>{ membersMap[userKey(c)]=true; });
  try {
    const newRef=fb.roomsRef().push(), now=Date.now();
    await newRef.set({ room_name:roomName, members:membersMap, is_dm:isDM, created_at:now, last_sent_at:now, last_message:'', unread:{} });
    const newRoom={ id:newRef.key, room_name:roomName, members:membersMap, is_dm:isDM, created_at:now, last_sent_at:now };
    state.rooms[newRef.key]=newRoom;
    closeModal('modal-new-room'); state.selectedUsers=[];
    await selectRoom(newRoom);
  } catch(e) { showToast('トークの作成に失敗しました','error'); console.error(e); }
};

/* ============================================================
 *  メンバー管理（ウィジェット版と同一ロジック）
 * ============================================================ */
const addMember = async (code, name) => {
  const room=state.currentRoom; if(!room) return;
  if (hasMember(room.members,code)) { showToast(`${name} はすでにメンバーです`,'info'); return; }
  try {
    const upd={ [`members/${userKey(code)}`]:true };
    let newName=null;
    if (room.is_dm) {
      upd['is_dm']=false;
      const names=getMemberCodes(room.members).map(c=>{ const u=api._userCache?.find(u=>u.code===c); return u?.name||c; });
      newName=[...names,name].join('、'); upd['room_name']=newName;
    }
    await fb.roomRef(room.id).update(upd);
    await fb.messagesRef(room.id).push().set({ sender:'system',sender_name:'Chatone',body:`${name} がトークに追加されました`,msg_type:'system',sent_at:Date.now(),read_by:{} });
    room.members={ ...room.members, [userKey(code)]:true };
    if (newName) { room.is_dm=false; room.room_name=newName; document.getElementById('chat-header-name').textContent=newName; }
    openMembersPanel(); showToast(`${name} を追加しました`,'success');
  } catch(e) { showToast('メンバーの追加に失敗しました','error'); }
};

const removeMember = async (code, name) => {
  if (!await showConfirm(`${name} をトークから削除しますか？`)) return;
  const room=state.currentRoom;
  await fb.roomRef(room.id).update({ [`members/${userKey(code)}`]:null });
  await fb.messagesRef(room.id).push().set({ sender:'system',sender_name:'Chatone',body:`${name} がトークから削除されました`,msg_type:'system',sent_at:Date.now(),read_by:{} });
  const nm={...room.members}; delete nm[userKey(code)]; room.members=nm;
  openMembersPanel(); showToast(`${name} を削除しました`,'success');
};

const leaveRoom = async () => {
  if (!await showConfirm('このトークから退出しますか？')) return;
  const room=state.currentRoom, user=state.currentUser;
  await fb.roomRef(room.id).update({ [`members/${userKey(user.code)}`]:null });
  await fb.messagesRef(room.id).push().set({ sender:'system',sender_name:'Chatone',body:`${user.name} がトークから退出しました`,msg_type:'system',sent_at:Date.now(),read_by:{} });
  delete state.rooms[room.id]; state.currentRoom=null;
  closeModal('modal-members');
  document.getElementById('chatone-sidebar')?.classList.remove('hidden-mobile');
  document.getElementById('chat-area')?.classList.add('hidden');
  document.getElementById('chat-empty')?.classList.remove('hidden');
  renderRoomList(state.rooms); showToast('トークから退出しました','success');
};

const deleteRoom = async () => {
  if (!await showConfirm('このトークを削除しますか？\n（メッセージも全て削除されます）')) return;
  const room=state.currentRoom;
  await fb.roomRef(room.id).remove(); await fb.messagesRef(room.id).remove();
  delete state.rooms[room.id]; state.currentRoom=null;
  closeModal('modal-members');
  document.getElementById('chatone-sidebar')?.classList.remove('hidden-mobile');
  document.getElementById('chat-area')?.classList.add('hidden');
  document.getElementById('chat-empty')?.classList.remove('hidden');
  renderRoomList(state.rooms); showToast('トークを削除しました','success');
};

const renameRoom = async (newName) => {
  const room=state.currentRoom; if(!room) return;
  const t=(newName||'').trim();
  if (!t) { showToast('トーク名を入力してください','error'); return; }
  if (t===(room.room_name||'')) { openMembersPanel(); return; }
  await fb.roomRef(room.id).update({ room_name:t });
  await fb.messagesRef(room.id).push().set({ sender:'system',sender_name:'Chatone',body:`トーク名が「${t}」に変更されました`,msg_type:'system',sent_at:Date.now(),read_by:{} });
  room.room_name=t; if(state.rooms[room.id]) state.rooms[room.id]={...state.rooms[room.id],room_name:t};
  document.getElementById('chat-header-name').textContent=t;
  renderRoomList(state.rooms); openMembersPanel(); showToast('トーク名を変更しました','success');
};

/* ============================================================
 *  メンバーパネル（ウィジェット版と同一）
 * ============================================================ */
const openMembersPanel = () => {
  if (!state.currentRoom) return;
  const user=state.currentUser, room=state.currentRoom, isDM=room.is_dm;
  const members=getMemberCodes(room.members).map(code=>{ const u=api._userCache?.find(u=>u.code===code); return {code,name:u?.name||code}; });
  document.getElementById('members-modal-title').textContent = isDM?'メンバー':'メンバー管理';
  const list=document.getElementById('members-list');
  const dn=getRoomDisplayName(room,user.code);
  const roomHeaderSection = !isDM ? `
    <div class="members-room-header">
      ${CONFIG.APP_ID_AVATARS?`<div class="members-room-avatar co-avatar-clickable" id="members-room-avatar" data-room-id="${escapeHTML(room.id)}">${getRoomInitial(dn)}</div>`:''}
      <div class="members-room-header-info">
        <div class="members-room-name-row">
          <span class="members-room-name-display" id="members-room-name-display">${escapeHTML(dn)}</span>
          <button class="btn-edit-room-name" id="btn-edit-room-name" title="トーク名を変更">✏️</button>
        </div>
        ${CONFIG.APP_ID_AVATARS?`<span class="members-room-avatar-label">アイコンをクリックして変更</span>`:''}
      </div>
    </div>` : '';
  list.innerHTML = roomHeaderSection +
    `<div class="members-section-label">参加メンバー (${members.length}人)</div>` +
    members.map(m => {
      const isMe=m.code===user.code, canRemove=!isDM&&!isMe&&members.length>2;
      return `<div class="member-item" data-code="${escapeHTML(m.code)}">
        <div class="member-avatar" data-member-code="${escapeHTML(m.code)}" data-initial="${escapeHTML(getInitial(m.name))}">${getInitial(m.name)}</div>
        <div class="member-info"><span class="member-name">${escapeHTML(m.name)}</span>${isMe?'<span class="member-tag-me">自分</span>':''}</div>
        ${canRemove?`<button class="btn-remove-member" data-code="${escapeHTML(m.code)}" data-name="${escapeHTML(m.name)}" title="削除">✕</button>`:''}
      </div>`;
    }).join('');
  list.querySelectorAll('.btn-remove-member').forEach(btn=>btn.addEventListener('click',()=>removeMember(btn.dataset.code,btn.dataset.name)));
  document.getElementById('members-room-avatar')?.addEventListener('click',()=>openRoomAvatarPicker(room.id));
  document.getElementById('btn-edit-room-name')?.addEventListener('click',()=>{
    const display=document.getElementById('members-room-name-display');
    const row=display?.closest('.members-room-name-row'); if(!row) return;
    row.innerHTML=`<input class="form-input members-room-name-input" id="members-room-name-input" type="text" value="${escapeHTML(room.room_name||dn)}" maxlength="50"/><button class="btn-save-room-name" id="btn-save-room-name">✓</button>`;
    const inp=document.getElementById('members-room-name-input'); inp?.focus(); inp?.select();
    const save=()=>renameRoom(inp.value);
    document.getElementById('btn-save-room-name')?.addEventListener('click',save);
    inp?.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();save();} if(e.key==='Escape'){e.preventDefault();openMembersPanel();} });
  });
  const addWrap=document.getElementById('members-add-wrap');
  addWrap.classList.remove('hidden'); setupMembersAddSearch(members);
  const btnLeave=document.getElementById('btn-leave-room'), btnDelete=document.getElementById('btn-delete-room');
  (!isDM&&members.length>1)?btnLeave.classList.remove('hidden'):btnLeave.classList.add('hidden');
  btnDelete.classList.remove('hidden');
  openModal('modal-members');
  if (CONFIG.APP_ID_AVATARS) refreshAllAvatarElements();
};

/* ============================================================
 *  メンバー追加検索
 * ============================================================ */
let _maTimer=null, _maBound=false;
const setupMembersAddSearch = (currentMembers) => {
  const input=document.getElementById('members-add-input'); if(!input) return;
  input.value=''; document.getElementById('members-add-dropdown').classList.add('hidden');
  if (_maBound) return; _maBound=true;
  let isComp=false;
  input.addEventListener('compositionstart',()=>{ isComp=true; });
  input.addEventListener('compositionend',()=>{ isComp=false; doSearch(); });
  input.addEventListener('input',()=>{ if(!isComp) doSearch(); });
  function doSearch() {
    clearTimeout(_maTimer);
    const kw=input.value.trim();
    if (!kw) { document.getElementById('members-add-dropdown').classList.add('hidden'); return; }
    _maTimer=setTimeout(async()=>{
      const dd=document.getElementById('members-add-dropdown');
      dd.innerHTML='<li class="user-search-loading">検索中…</li>'; dd.classList.remove('hidden');
      const users=await api.searchUsers(kw);
      const exist=getMemberCodes(state.currentRoom?.members);
      const filtered=users.filter(u=>!exist.includes(u.code));
      if (!filtered.length) { dd.innerHTML='<li class="user-search-empty">見つかりません</li>'; return; }
      dd.innerHTML=filtered.map(u=>`<li class="user-search-item" data-code="${escapeHTML(u.code)}" data-name="${escapeHTML(u.name)}"><div class="user-search-avatar">${getInitial(u.name)}</div><div class="user-search-info"><span class="user-search-name">${escapeHTML(u.name)}</span></div></li>`).join('');
      dd.querySelectorAll('.user-search-item').forEach(el=>el.addEventListener('click',()=>{ addMember(el.dataset.code,el.dataset.name); input.value=''; dd.classList.add('hidden'); }));
    },250);
  }
};

/* ============================================================
 *  ユーザー検索・選択（新規ルーム作成）
 * ============================================================ */
const searchAndShowUsers = async (keyword) => {
  const dd=document.getElementById('user-search-dropdown');
  dd.innerHTML='<li class="user-search-loading">検索中…</li>'; dd.classList.remove('hidden');
  const users=await api.searchUsers(keyword);
  const filtered=users.filter(u=>!state.selectedUsers.find(s=>s.code===u.code));
  if (!filtered.length) { dd.innerHTML='<li class="user-search-empty">見つかりません</li>'; return; }
  dd.innerHTML=filtered.map(u=>`<li class="user-search-item" data-code="${escapeHTML(u.code)}" data-name="${escapeHTML(u.name)}"><div class="user-search-avatar">${getInitial(u.name)}</div><div class="user-search-info"><span class="user-search-name">${escapeHTML(u.name)}</span><span class="user-search-code">${escapeHTML(u.code)}</span></div></li>`).join('');
  dd.querySelectorAll('.user-search-item').forEach(el=>el.addEventListener('click',()=>{ addSelectedUser(el.dataset.code,el.dataset.name); document.getElementById('user-search-input').value=''; dd.classList.add('hidden'); }));
};

const addSelectedUser = (code, name) => {
  if (state.selectedUsers.find(u=>u.code===code)) return;
  state.selectedUsers.push({code,name}); renderSelectedUsers();
};
const removeSelectedUser = (code) => { state.selectedUsers=state.selectedUsers.filter(u=>u.code!==code); renderSelectedUsers(); };
const renderSelectedUsers = () => {
  const c=document.getElementById('selected-users');
  const rw=document.getElementById('room-name-wrap');
  const btn=document.getElementById('btn-create-room');
  c.innerHTML=state.selectedUsers.map(u=>`<span class="selected-user-chip" data-code="${escapeHTML(u.code)}"><span class="chip-avatar">${getInitial(u.name)}</span><span class="chip-name">${escapeHTML(u.name)}</span><button class="chip-remove" data-code="${escapeHTML(u.code)}">✕</button></span>`).join('');
  c.querySelectorAll('.chip-remove').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();removeSelectedUser(b.dataset.code);}));
  state.selectedUsers.length>=2?rw.classList.remove('hidden'):rw.classList.add('hidden');
  btn.disabled=state.selectedUsers.length===0;
};

/* ============================================================
 *  メッセージコンテキストメニュー
 * ============================================================ */
let _ctxMenu=null;
const showMsgContextMenu = (e, msg, isMine, isRead) => {
  _ctxMenu?.remove();
  const menu=document.createElement('div'); menu.className='co-ctx-menu';
  const items=[];
  if (isMine&&!isRead&&msg.msg_type!=='deleted') items.push({label:'🗑 削除',action:()=>deleteMsgFn(msg)});
  if (msg.body&&msg.msg_type==='text') items.push({label:'📋 コピー',action:()=>navigator.clipboard?.writeText(msg.body||'').catch(()=>{})});
  if (!items.length) return;
  menu.innerHTML=items.map(it=>`<button class="co-ctx-item">${escapeHTML(it.label)}</button>`).join('');
  menu.querySelectorAll('.co-ctx-item').forEach((btn,i)=>btn.addEventListener('click',()=>{ items[i].action(); _ctxMenu?.remove(); _ctxMenu=null; }));
  document.body.appendChild(menu);
  menu.style.cssText=`position:fixed;z-index:99999`;
  let x=e.clientX, y=e.clientY;
  if(x+menu.offsetWidth>window.innerWidth) x=window.innerWidth-menu.offsetWidth-8;
  if(y+menu.offsetHeight>window.innerHeight) y=window.innerHeight-menu.offsetHeight-8;
  menu.style.left=`${x}px`; menu.style.top=`${y}px`;
  _ctxMenu=menu;
  setTimeout(()=>document.addEventListener('click',()=>{ _ctxMenu?.remove(); _ctxMenu=null; },{once:true}),50);
};
const deleteMsgFn = async (msg) => {
  if (!await showConfirm('このメッセージを削除しますか？')) return;
  await fb.messageRef(state.currentRoom.id,msg.id).update({msg_type:'deleted',body:''});
  document.querySelector(`[data-msg-id="${msg.id}"]`)?.remove();
};

/* ============================================================
 *  スタンプ
 * ============================================================ */
let _stampCache=null, _stampPickerOpen=false, _stampLoadFailed=false;
const loadStamps = async () => {
  if (_stampCache||_stampLoadFailed||!CONFIG.APP_ID_STAMPS) return;
  try {
    const cached=await idb.get('cache','stamps');
    if (cached&&Date.now()-cached.ts<CONFIG.AVATAR_CACHE_TTL) {
      _stampCache=cached.stamps;
      _stampCache.forEach(s=>{
        if (s._dataUrl&&!s._objectUrl) {
          const b64=s._dataUrl.split(',')[1]; const ba=atob(b64); const arr=new Uint8Array(ba.length);
          for(let i=0;i<ba.length;i++) arr[i]=ba.charCodeAt(i);
          s._objectUrl=URL.createObjectURL(new Blob([arr],{type:'image/png'}));
        }
      });
      return;
    }
    const res=await api.getRecords(CONFIG.APP_ID_STAMPS,'',200);
    _stampCache=res.records||[];
    await Promise.all(_stampCache.map(async s=>{
      const f=s.stamp_file?.value?.[0]||s.stamp_image?.value?.[0]; if(!f?.fileKey) return;
      try {
        const blob=await api.fetchFile(f.fileKey);
        const dataUrl=await new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsDataURL(blob); });
        s._dataUrl=dataUrl; s._objectUrl=URL.createObjectURL(blob);
      } catch {}
    }));
    await idb.set('cache','stamps',{ stamps:_stampCache, ts:Date.now() });
  } catch(e) { console.warn('スタンプ読み込みを無効化しました:', e.message || e); _stampCache=[]; _stampLoadFailed=true; }
};
const toggleStampPicker = async () => {
  if (_stampPickerOpen) { document.getElementById('co-stamp-picker')?.remove(); _stampPickerOpen=false; return; }
  _stampPickerOpen=true;
  await loadStamps();
  const picker=document.createElement('div'); picker.id='co-stamp-picker'; picker.className='co-stamp-picker';
  picker.innerHTML = !_stampCache?.length
    ? '<div style="padding:16px;color:#6b7280">スタンプがありません</div>'
    : _stampCache.map(s=>{ const sid=s.stamp_id?.value||s.$id?.value||''; const src=s._objectUrl||''; return src?`<div class="stamp-item" data-stamp-id="${escapeHTML(sid)}" title="${escapeHTML(s.stamp_name?.value||'')}"><img src="${escapeHTML(src)}" alt=""/></div>`:''; }).join('');
  picker.querySelectorAll('.stamp-item').forEach(el=>el.addEventListener('click',()=>{ sendStamp(el.dataset.stampId); document.getElementById('co-stamp-picker')?.remove(); _stampPickerOpen=false; }));
  document.querySelector('.input-area')?.appendChild(picker);
  setTimeout(()=>document.addEventListener('click',_stampOut),50);
};
const _stampOut = e => { const p=document.getElementById('co-stamp-picker'); if(p&&!p.contains(e.target)&&e.target!==document.getElementById('btn-stamp')){ p.remove(); _stampPickerOpen=false; document.removeEventListener('click',_stampOut); } };

/* ============================================================
 *  アバター（IndexedDB キャッシュ + kintone fetch）
 * ============================================================ */
const loadAllAvatars = async () => {
  if (!CONFIG.APP_ID_AVATARS || loadAllAvatars.failed) return;
  try {
    const res=await api.getRecords(CONFIG.APP_ID_AVATARS,'',500);
    Object.values(state.avatarCache).forEach(v=>{ if(v?.url?.startsWith('blob:')) URL.revokeObjectURL(v.url); });
    state.avatarCache={};
    await Promise.all(res.records.map(async rec=>{
      const type=rec.avatar_type?.value, target=rec.avatar_target?.value, file=rec.avatar_file?.value?.[0];
      if (!type||!target||!file?.fileKey) return;
      const ckey=`${type}:${target}`;
      let dataUrl=await avatarIdb.get(ckey);
      if (!dataUrl) {
        try {
          const blob=await api.fetchFile(file.fileKey);
          dataUrl=await new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsDataURL(blob); });
          await avatarIdb.set(ckey,dataUrl);
        } catch { return; }
      }
      const resp=await fetch(dataUrl); const blob=await resp.blob();
      state.avatarCache[ckey]={ url:URL.createObjectURL(blob), recordId:rec.$id.value };
    }));
    refreshAllAvatarElements();
  } catch(e) { console.warn('アバター読み込みを無効化しました:', e.message || e); loadAllAvatars.failed = true; }
};

const getAvatarUrl = (type,target) => state.avatarCache[`${type}:${target}`]?.url||null;

const applyAvatarToEl = (el, type, target, fallback) => {
  if (!el||!target) return;
  const url=getAvatarUrl(type,target);
  if (url) { el.innerHTML=`<img src="${url}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:top;border-radius:50%;">`; el.style.background='transparent'; el.style.padding='0'; }
  else { el.innerHTML=escapeHTML(fallback||'?'); el.style.background=''; el.style.padding=''; }
};

const refreshAllAvatarElements = () => {
  applyAvatarToEl(document.querySelector('#sidebar-user .user-avatar'),'user',state.currentUser?.code,getInitial(state.currentUser?.name));
  document.querySelectorAll('.room-item[data-room-id]').forEach(el=>{
    const room=state.rooms[el.dataset.roomId]; if(!room) return;
    const av=el.querySelector('.room-avatar'); if(!av) return;
    if (room.is_dm) { const other=getMemberCodes(room.members).find(c=>c!==state.currentUser?.code); if(other) applyAvatarToEl(av,'user',other,getRoomInitial(getRoomDisplayName(room,state.currentUser?.code))); }
    else applyAvatarToEl(av,'room',el.dataset.roomId,getRoomInitial(getRoomDisplayName(room,state.currentUser?.code)));
  });
  document.querySelectorAll('.msg-avatar[data-sender]').forEach(el=>applyAvatarToEl(el,'user',el.dataset.sender,el.textContent.trim()));
  document.querySelectorAll('.member-avatar[data-member-code]').forEach(el=>applyAvatarToEl(el,'user',el.dataset.memberCode,el.dataset.initial||el.textContent.trim()));
  const mra=document.getElementById('members-room-avatar');
  if (mra&&state.currentRoom) applyAvatarToEl(mra,'room',state.currentRoom.id,getRoomInitial(getRoomDisplayName(state.currentRoom,state.currentUser?.code)));
};

const cropToCircleBlob = file => new Promise((res,rej)=>{
  const reader=new FileReader();
  reader.onload=e=>{
    const img=new Image(); img.onerror=rej;
    img.onload=()=>{
      const S=128, c=document.createElement('canvas'); c.width=S; c.height=S;
      const ctx=c.getContext('2d'); const min=Math.min(img.width,img.height);
      const sx=(img.width-min)/2, sy=(img.height-min)/2;
      ctx.beginPath(); ctx.arc(S/2,S/2,S/2,0,Math.PI*2); ctx.clip();
      ctx.drawImage(img,sx,sy,min,min,0,0,S,S);
      c.toBlob(b=>b?res(b):rej(new Error('toBlob失敗')),'image/jpeg',0.9);
    };
    img.src=e.target.result;
  };
  reader.onerror=rej; reader.readAsDataURL(file);
});

const saveAvatarToApp = async (type, target, blob, existingId) => {
  const f=new File([blob],`avatar_${type}_${target}.jpg`,{type:'image/jpeg'});
  const fileKey=await api.uploadFile(f);
  if (existingId) { await api.updateRecord(CONFIG.APP_ID_AVATARS,parseInt(existingId),{avatar_file:{value:[{fileKey}]}}); }
  else { await api.addRecord(CONFIG.APP_ID_AVATARS,{avatar_type:{value:type},avatar_target:{value:String(target)},avatar_file:{value:[{fileKey}]}}); }
};

const openMyAvatarPicker = () => {
  const fi=document.createElement('input'); fi.type='file'; fi.accept='image/*';
  fi.onchange=async()=>{
    const file=fi.files[0]; if(!file) return;
    try {
      showToast('アイコンを保存中…','info');
      const blob=await cropToCircleBlob(file);
      const ex=state.avatarCache[`user:${state.currentUser.code}`];
      await saveAvatarToApp('user',state.currentUser.code,blob,ex?.recordId);
      await avatarIdb.clearAll(); state.avatarCache={};
      await loadAllAvatars(); showToast('アイコンを更新しました','success');
    } catch(e) { showToast('アイコンの保存に失敗しました','error'); console.error(e); }
  };
  fi.click();
};

const openRoomAvatarPicker = roomId => {
  const fi=document.createElement('input'); fi.type='file'; fi.accept='image/*';
  fi.onchange=async()=>{
    const file=fi.files[0]; if(!file) return;
    try {
      showToast('グループアイコンを保存中…','info');
      const blob=await cropToCircleBlob(file);
      const ex=state.avatarCache[`room:${roomId}`];
      await saveAvatarToApp('room',roomId,blob,ex?.recordId);
      await avatarIdb.clearAll(); state.avatarCache={};
      await loadAllAvatars(); openMembersPanel(); showToast('グループアイコンを更新しました','success');
    } catch(e) { showToast('グループアイコンの保存に失敗しました','error'); }
  };
  fi.click();
};

/* ============================================================
 *  背景色ピッカー
 * ============================================================ */
const BG_KEY='chatone_bg_color';
const BG_PRESETS=[{v:'',l:'デフォルト'},{v:'#ffffff',l:'ホワイト'},{v:'#fdf6e3',l:'クリーム'},{v:'#e6f9ef',l:'ミント'},{v:'#e8f1fc',l:'スカイ'},{v:'#f1ecfa',l:'ラベンダー'},{v:'#fdebe3',l:'ピーチ'},{v:'#eceff1',l:'グレー'},{v:'#2b2f33',l:'ダーク'}];
const applyBgColor = c => { const l=document.getElementById('message-list'); if(!l) return; l.style.backgroundColor=c||''; l.classList.toggle('co-bg-custom',!!c); };
const loadBgColorPref = () => { try { applyBgColor(localStorage.getItem(BG_KEY)||''); } catch {} };
const saveBgColor = c => { try { localStorage.setItem(BG_KEY,c||''); } catch {} applyBgColor(c); };
let _bgOpen=false;
const toggleBgColorPicker = () => {
  if (_bgOpen) { document.getElementById('co-bg-picker')?.remove(); _bgOpen=false; document.getElementById('btn-bg-color')?.classList.remove('active'); return; }
  _bgOpen=true; document.getElementById('btn-bg-color')?.classList.add('active');
  let cur=''; try { cur=localStorage.getItem(BG_KEY)||''; } catch {}
  const p=document.createElement('div'); p.id='co-bg-picker'; p.className='co-bg-picker';
  p.innerHTML=`<div class="co-bg-picker-title">背景色を選択</div><div class="co-bg-picker-grid">${BG_PRESETS.map(preset=>`<button class="co-bg-swatch ${preset.v===cur?'active':''}" data-color="${escapeHTML(preset.v)}" title="${escapeHTML(preset.l)}" style="background:${preset.v||'linear-gradient(135deg,#f5f6f8 50%,#fff 50%)'}"></button>`).join('')}<label class="co-bg-swatch co-bg-custom-swatch" title="カスタム">🎨<input type="color" id="co-bg-custom-input" value="${cur&&cur.startsWith('#')?cur:'#ffffff'}"/></label></div>`;
  p.querySelectorAll('.co-bg-swatch[data-color]').forEach(b=>b.addEventListener('click',()=>{ saveBgColor(b.dataset.color); toggleBgColorPicker(); }));
  document.getElementById('co-bg-custom-input')?.addEventListener('input',e=>saveBgColor(e.target.value));
  const hdr=document.getElementById('chat-header'); if(hdr){ hdr.style.position='relative'; hdr.appendChild(p); }
  setTimeout(()=>document.addEventListener('click',_bgOut),50);
};
const _bgOut = e => { const p=document.getElementById('co-bg-picker'), b=document.getElementById('btn-bg-color'); if(p&&!p.contains(e.target)&&e.target!==b){ p.remove(); _bgOpen=false; b?.classList.remove('active'); document.removeEventListener('click',_bgOut); } };

/* ============================================================
 *  Toast / Confirm
 * ============================================================ */
const showToast = (message, type='info') => {
  const c=document.getElementById('toast-container'); if(!c) return;
  const t=document.createElement('div'); t.className=`toast toast-${type}`; t.textContent=message;
  c.appendChild(t); requestAnimationFrame(()=>t.classList.add('show'));
  setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),300); },3200);
};

const showConfirm = msg => new Promise(resolve => {
  const o=document.createElement('div'); o.className='modal-overlay';
  o.innerHTML=`<div class="modal co-confirm-modal"><div class="modal-body co-confirm-body"><p class="co-confirm-msg">${escapeHTML(msg).replace(/\n/g,'<br>')}</p></div><div class="modal-footer co-confirm-footer"><button class="btn-cancel" id="co-cf-no">いいえ</button><button class="btn-create co-confirm-ok" id="co-cf-yes">はい</button></div></div>`;
  document.body.appendChild(o);
  document.getElementById('co-cf-yes')?.addEventListener('click',()=>{ o.remove(); resolve(true); });
  document.getElementById('co-cf-no')?.addEventListener('click',()=>{ o.remove(); resolve(false); });
});

const openModal  = id => document.getElementById(id)?.classList.remove('hidden');
const closeModal = id => document.getElementById(id)?.classList.add('hidden');

/* ============================================================
 *  添付プレビュー
 * ============================================================ */
const renderAttachPreview = fileList => {
  const files=fileList?Array.from(fileList):[];
  state.pendingFiles=files;
  const preview=document.getElementById('attach-preview'); if(!preview) return;
  preview.innerHTML=files.map((f,i)=>{
    const isImg=/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f.name)||f.type.startsWith('image/');
    if (isImg) return `<div class="attach-image-wrap" data-index="${i}"><img class="attach-image-preview" data-object-url="1" alt="${escapeHTML(f.name)}"/><button class="attach-chip-remove" data-index="${i}">✕</button></div>`;
    return `<span class="attach-chip">📎 ${escapeHTML(f.name)}<button class="attach-chip-remove" data-index="${i}">✕</button></span>`;
  }).join('');
  files.forEach((f,i)=>{ if(f.type.startsWith('image/')){ const img=preview.querySelector(`.attach-image-wrap[data-index="${i}"] img`); if(img) img.src=URL.createObjectURL(f); } });
  preview.querySelectorAll('.attach-chip-remove').forEach(b=>b.addEventListener('click',()=>{ state.pendingFiles.splice(parseInt(b.dataset.index),1); renderAttachPreview(state.pendingFiles); }));
};

const formatFileSize = bytes => {
  if (!bytes) return '';
  if (bytes<1024) return `${bytes} B`;
  if (bytes<1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
};

/* ============================================================
 *  ユーティリティ
 * ============================================================ */
const encodeUserCode = c => { if(!c) return c; return String(c).replace(/_/g,'_us_').replace(/@/g,'_at_').replace(/\./g,'_dot_').replace(/#/g,'_hash_').replace(/\$/g,'_dollar_').replace(/\//g,'_slash_').replace(/\[/g,'_lb_').replace(/\]/g,'_rb_'); };
const decodeUserCode = c => { if(!c) return c; return String(c).replace(/_rb_/g,']').replace(/_lb_/g,'[').replace(/_slash_/g,'/').replace(/_dollar_/g,'$').replace(/_hash_/g,'#').replace(/_dot_/g,'.').replace(/_at_/g,'@').replace(/_us_/g,'_'); };
const userKey        = c => encodeUserCode(c);
const hasMember      = (m,c) => !!m&&(!!m[userKey(c)]||!!m[c]);
const getMemberCodes = m => Object.keys(m||{}).map(decodeUserCode);
const unreadCount    = (r,c) => (r?.unread||{})[userKey(c)]||0;
const isReadBy       = (m,c) => !!m?.read_by?.[userKey(c)];
const escapeHTML     = s => { if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); };
const linkify        = t => t.replace(/(https?:\/\/[^\s<>"]+)/g,'<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>').replace(/\n/g,'<br>');
const getRoomInitial = n => n?n.charAt(0).toUpperCase():'?';
const getInitial     = n => n?n.charAt(0).toUpperCase():'?';
const formatTime = ms => {
  if (!ms) return '';
  const d=new Date(ms), now=new Date();
  if (d.toDateString()===now.toDateString()) return d.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString('ja-JP',{month:'numeric',day:'numeric'});
};
const formatDateTime = ms => { if(!ms) return ''; const d=new Date(ms); return d.toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}); };

/* ============================================================
 *  イベントバインド
 * ============================================================ */
const bindEvents = () => {
  document.getElementById('btn-back')?.addEventListener('click', () => {
    document.getElementById('chatone-sidebar')?.classList.remove('hidden-mobile');
    document.getElementById('chat-area')?.classList.add('hidden');
    document.getElementById('chat-empty')?.classList.remove('hidden');
  });
  document.getElementById('btn-send')?.addEventListener('click', sendMessage);
  document.getElementById('msg-input')?.addEventListener('keydown', e => {
    if (e.key==='Enter'&&!e.shiftKey&&!state.isComposing) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('msg-input')?.addEventListener('compositionstart', ()=>{ state.isComposing=true; });
  document.getElementById('msg-input')?.addEventListener('compositionend',   ()=>{ state.isComposing=false; });
  document.getElementById('file-input')?.addEventListener('change', e=>renderAttachPreview(e.target.files));
  if (CONFIG.APP_ID_STAMPS) document.getElementById('btn-stamp')?.addEventListener('click',e=>{ e.stopPropagation(); toggleStampPicker(); });
  document.getElementById('btn-bg-color')?.addEventListener('click',e=>{ e.stopPropagation(); toggleBgColorPicker(); });
  document.getElementById('btn-members')?.addEventListener('click',()=>openMembersPanel());

  // 新規ルーム
  let _usTimer=null, _usBound=false;
  document.getElementById('btn-new-room')?.addEventListener('click',()=>{
    state.selectedUsers=[]; renderSelectedUsers();
    document.getElementById('user-search-dropdown').classList.add('hidden');
    document.getElementById('user-search-input').value='';
    document.getElementById('new-room-name').value='';
    openModal('modal-new-room');
    setTimeout(()=>{
      const input=document.getElementById('user-search-input'); if(!input) return;
      input.value=''; input.focus();
      if (_usBound) return; _usBound=true;
      let isComp=false;
      const doSearch=()=>{ clearTimeout(_usTimer); const kw=input.value.trim(); if(!kw){ document.getElementById('user-search-dropdown').classList.add('hidden'); return; } _usTimer=setTimeout(()=>searchAndShowUsers(kw),250); };
      input.addEventListener('compositionstart',()=>{ isComp=true; });
      input.addEventListener('compositionend',()=>{ isComp=false; doSearch(); });
      input.addEventListener('input',()=>{ if(!isComp) doSearch(); });
    },50);
  });

  document.getElementById('modal-close')?.addEventListener('click',()=>closeModal('modal-new-room'));
  document.getElementById('btn-cancel-room')?.addEventListener('click',()=>closeModal('modal-new-room'));
  document.getElementById('btn-create-room')?.addEventListener('click',createRoom);
  document.getElementById('members-modal-close')?.addEventListener('click',()=>{ closeModal('modal-members'); _maBound=false; });
  document.getElementById('btn-leave-room')?.addEventListener('click',leaveRoom);
  document.getElementById('btn-delete-room')?.addEventListener('click',deleteRoom);
  ['modal-new-room','modal-members'].forEach(id=>{
    document.getElementById(id)?.addEventListener('click',e=>{ if(e.target===e.currentTarget) closeModal(id); });
  });

  let _srTimer=null;
  document.getElementById('room-search')?.addEventListener('input',e=>{ clearTimeout(_srTimer); _srTimer=setTimeout(()=>renderRoomList(state.rooms,e.target.value),200); });

  // 添付ドラッグ＆ドロップ
  const inputArea=document.querySelector('.input-area');
  if (inputArea) {
    inputArea.addEventListener('dragover',e=>{ e.preventDefault(); inputArea.classList.add('drag-over'); });
    inputArea.addEventListener('dragleave',()=>inputArea.classList.remove('drag-over'));
    inputArea.addEventListener('drop',e=>{ e.preventDefault(); inputArea.classList.remove('drag-over'); const files=Array.from(e.dataTransfer?.files||[]); if(!files.length) return; renderAttachPreview([...state.pendingFiles,...files]); });
  }

  // ペーストで画像追加
  document.getElementById('msg-input')?.addEventListener('paste',e=>{
    const items=e.clipboardData?.items; if(!items) return;
    const imgs=Array.from(items).filter(it=>it.type.startsWith('image/')); if(!imgs.length) return;
    e.preventDefault();
    const files=imgs.map(it=>{ const b=it.getAsFile(); return new File([b],`image_${Date.now()}.${b.type.split('/')[1]||'png'}`,{type:b.type}); });
    renderAttachPreview([...state.pendingFiles,...files]);
  });

  document.getElementById('btn-logout')?.addEventListener('click',logout);

  window.addEventListener('resize',()=>{
    const was=state.isMobile; state.isMobile=window.innerWidth<768;
    if (was!==state.isMobile) {
      if (!state.isMobile) document.getElementById('chatone-sidebar')?.classList.remove('hidden-mobile');
      else if (state.currentRoom) document.getElementById('chatone-sidebar')?.classList.add('hidden-mobile');
    }
  });
};

/* ============================================================
 *  エントリーポイント
 * ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  await idb.open().catch(()=>{});
  await registerSW();

  const creds = await authStore.load();
  if (!creds) { showLoginScreen(); return; }

  // 接続確認（プロキシ経由、5秒タイムアウト、失敗時はオフラインとして続行）
  setSplashStatus('接続確認中…');
  try {
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),5000);
    const auth=btoa(`${creds.loginName}:${creds.password}`);
    const r=await fetch(CONFIG.PROXY_ENDPOINTS.kintoneProxy,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        subdomain:creds.subdomain, path:'/k/v1/records.json',
        method:'GET', auth, params:{app:String(CONFIG.APP_ID_STAMPS), query:'limit 1 offset 0'},
      }),
      signal:ctrl.signal,
    });
    clearTimeout(timer);
    if (r.status===401||r.status===403) { await authStore.clear(); showLoginScreen(); return; }
  } catch(e) {
    if (e.name!=='AbortError') console.warn('[Auth] オフライン、接続確認スキップ:', e.message);
  }

  await startApp();
});
