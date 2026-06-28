/* =====================================================
 *  sw.js — Chatone PWA Service Worker
 *  ・アプリシェルをキャッシュ（オフライン起動）
 *  ・FCM は firebase-messaging-sw.js が担当
 *  ・このファイルは / (ルート) に置いてください
 * ===================================================== */

const CACHE_NAME   = 'chatone-pwa-v9';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './chatone-pwa.js',
  './chatone-pwa.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const assetUrl = (path) => new URL(path, self.registration.scope).toString();

// インストール時にアセットをキャッシュ
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(ASSETS.map(assetUrl => cache.add(assetUrl))))
      .then(() => self.skipWaiting())
  );
});

// アクティベート時に古いキャッシュを削除
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ネットワークファースト（失敗時はキャッシュにフォールバック）
self.addEventListener('fetch', (e) => {
  // Firebase / kintone / CDN へのAPIリクエストはキャッシュしない
  const url = new URL(e.request.url);
  if (
    url.hostname.includes('firebasedatabase.app') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('cybozu.com') ||
    url.hostname.includes('dropboxapi.com') ||
    url.hostname.includes('gstatic.com')
  ) {
    return; // ブラウザのデフォルト挙動に任せる
  }

  // 同一オリジンのナビゲーションリクエスト → index.html を返す（SPA対応）
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(assetUrl('./index.html')))
    );
    return;
  }

  // その他（JS/CSS/画像等）→ キャッシュを優先
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // 成功したレスポンスをキャッシュに追加
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      });
    })
  );
});

// メインスレッドからのメッセージ（SKIP_WAITING）
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
