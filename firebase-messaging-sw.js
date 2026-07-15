/* =====================================================
 *  Chatone unified Service Worker
 *  - FCM background notifications
 *  - PWA app-shell cache
 * ===================================================== */

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const CACHE_NAME = 'chatone-pwa-v19';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './chatone-pwa.js',
  './chatone-pwa.css',
  './chatone-pwa-hotfix.js?v=20260629-5',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const assetUrl = path => new URL(path, self.registration.scope).toString();

firebase.initializeApp({
  apiKey:            'AIzaSyBlTJjF_fOYLpEQTsxt_X18s-A_4FGV-9U',
  authDomain:        'chatone-fujibussan.firebaseapp.com',
  databaseURL:       'https://chatone-fujibussan-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:         'chatone-fujibussan',
  storageBucket:     'chatone-fujibussan.firebasestorage.app',
  messagingSenderId: '1077755971352',
  appId:             '1:1077755971352:web:4267f0b620e79b0af5c06d',
});

const messaging = firebase.messaging();

// PWAアプリアイコンのバッジ(未読数)を、現在表示中の通知件数に合わせて更新
const updateBadgeFromNotifications = () => {
  if (!('setAppBadge' in self.navigator)) return Promise.resolve();
  return self.registration.getNotifications().then(list => {
    return list.length
      ? self.navigator.setAppBadge(list.length).catch(() => {})
      : self.navigator.clearAppBadge().catch(() => {});
  });
};

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(ASSETS.map(path => cache.add(assetUrl(path)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (
    url.hostname.includes('firebasedatabase.app') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('cybozu.com') ||
    url.hostname.includes('dropboxapi.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('a.run.app')
  ) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(assetUrl('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      });
    })
  );
});

messaging.onBackgroundMessage(payload => {
  const title = payload.data?.title || payload.notification?.title || 'Chatone';
  const body = payload.data?.body || payload.notification?.body || '';
  const roomId = payload.data?.roomId || '';
  const icon = assetUrl('./icons/icon-192.png');
  const badge = assetUrl('./icons/icon-72.png');
  const url = roomId ? assetUrl(`./?room=${encodeURIComponent(roomId)}`) : assetUrl('./');

  self.registration.showNotification(title, {
    body,
    icon,
    badge,
    tag: roomId || 'chatone-msg',
    renotify: true,
    data: { roomId, url },
    actions: [
      { action: 'open', title: '開く' },
      { action: 'dismiss', title: '閉じる' },
    ],
  }).then(updateBadgeFromNotifications);
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(updateBadgeFromNotifications());
  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || assetUrl('./');
  const roomId = event.notification.data?.roomId;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) await client.navigate(url).catch(() => null);
          await client.focus();
          if (roomId) client.postMessage({ type: 'open-room', roomId });
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
