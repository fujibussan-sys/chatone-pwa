/* =====================================================
 *  firebase-messaging-sw.js
 *  FCM バックグラウンド通知受信 Service Worker
 *  ⚠️ このファイルは必ず public/ のルートに置いてください
 * ===================================================== */

// Firebase SDK を importScripts で読み込む（compat 版）
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// ── ここに Firebase 設定を入力してください ──────────────
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

// バックグラウンド受信 → OS通知を表示
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'Chatone';
  const body  = payload.notification?.body  || '';
  const roomId = payload.data?.roomId || '';

  self.registration.showNotification(title, {
    body,
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    tag:   roomId || 'chatone-msg',   // 同じルームの通知は積み重ねず上書き
    renotify: true,
    data:  { roomId, url: roomId ? `/?room=${roomId}` : '/' },
    actions: [
      { action: 'open', title: '開く' },
      { action: 'dismiss', title: '閉じる' },
    ],
  });
});

// 通知クリック → 対象ルームを開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url   = event.notification.data?.url || '/';
  const roomId = event.notification.data?.roomId;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // すでに開いているウィンドウがあればフォーカスしてメッセージを送る
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (roomId) {
            client.postMessage({ type: 'open-room', roomId });
          }
          return;
        }
      }
      // なければ新規タブで開く
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
