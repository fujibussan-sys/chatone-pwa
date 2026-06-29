/* Chatone PWA runtime hotfixes
 * - Prevent only legacy sw.js from replacing the FCM service worker.
 * - Store FCM tokens per device when the older main script writes the legacy path.
 * - Repair old IndexedDB instances that are missing required object stores.
 * - Clear stale stamp blob URLs saved in IndexedDB by older builds.
 * - Open ?room=... links created by push notifications.
 */
'use strict';

(() => {
  const log = (...args) => console.info('[Chatone hotfix]', ...args);

  const encodeKey = value => String(value || '')
    .replace(/_/g, '_us_')
    .replace(/@/g, '_at_')
    .replace(/\./g, '_dot_')
    .replace(/#/g, '_hash_')
    .replace(/\$/g, '_dollar_')
    .replace(/\//g, '_slash_')
    .replace(/\[/g, '_lb_')
    .replace(/\]/g, '_rb_');

  const repairIndexedDB = () => {
    if (!('indexedDB' in window)) return;
    const req = indexedDB.open('chatone-pwa', 1);
    req.onupgradeneeded = event => {
      const db = event.target.result;
      ['settings', 'cache'].forEach(store => {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      });
    };
    req.onsuccess = () => {
      const db = req.result;
      const hasSettings = db.objectStoreNames.contains('settings');
      const hasCache = db.objectStoreNames.contains('cache');
      if (!hasSettings || !hasCache) {
        db.close();
        if (sessionStorage.getItem('chatone-idb-repairing') === '1') return;
        sessionStorage.setItem('chatone-idb-repairing', '1');
        const del = indexedDB.deleteDatabase('chatone-pwa');
        del.onsuccess = () => {
          log('IndexedDB repaired, reloading');
          location.reload();
        };
        del.onerror = () => {
          sessionStorage.removeItem('chatone-idb-repairing');
          log('IndexedDB repair failed');
        };
        del.onblocked = () => {
          log('IndexedDB repair blocked; please close other Chatone tabs');
        };
        return;
      }

      sessionStorage.removeItem('chatone-idb-repairing');
      try {
        const tx = db.transaction('cache', 'readwrite');
        const store = tx.objectStore('cache');
        store.delete('stamps');
        store.delete('stamps-v2');
        tx.oncomplete = () => { db.close(); log('stamp cache cleared'); };
        tx.onerror = () => db.close();
        tx.onabort = () => db.close();
      } catch {
        db.close();
      }
    };
  };

  const openRequestedRoom = roomId => {
    if (!roomId) return;
    let tries = 0;
    const tryOpen = () => {
      const item = document.querySelector(`.room-item[data-room-id="${CSS.escape(roomId)}"]`);
      if (item) {
        item.click();
        history.replaceState(null, '', new URL('./', location.href));
        log('opened room from notification', roomId);
        return;
      }
      tries += 1;
      if (tries < 80) setTimeout(tryOpen, 250);
    };
    tryOpen();
  };

  repairIndexedDB();
  openRequestedRoom(new URL(location.href).searchParams.get('room'));
  navigator.serviceWorker?.addEventListener?.('message', event => {
    if (event.data?.type === 'open-room' && event.data.roomId) openRequestedRoom(event.data.roomId);
  });

  if ('serviceWorker' in navigator) {
    const nativeRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    let lastRegistration = null;
    navigator.serviceWorker.register = (scriptURL, options = {}) => {
      let pathname = '';
      try {
        pathname = new URL(String(scriptURL || ''), document.baseURI).pathname;
      } catch {
        pathname = String(scriptURL || '');
      }
      if (pathname.endsWith('/sw.js') && !pathname.endsWith('/firebase-messaging-sw.js')) {
        log('skip legacy sw.js registration');
        return Promise.resolve(lastRegistration || {
          scope: options.scope || new URL('./', document.baseURI).href,
          update: () => Promise.resolve(),
          unregister: () => Promise.resolve(false),
        });
      }
      return nativeRegister(scriptURL, options).then(reg => {
        lastRegistration = reg;
        return reg;
      });
    };
  }

  const patchFirebaseRef = () => {
    if (!window.firebase?.database || !firebase.apps?.length) return false;
    let sampleRef;
    try {
      sampleRef = firebase.database().ref('/');
    } catch {
      return false;
    }
    const refProto = Object.getPrototypeOf(sampleRef);
    if (!refProto || refProto.__chatoneHotfixPatched) return true;

    const nativeSet = refProto.set;
    refProto.set = function(value, onComplete) {
      try {
        const path = new URL(this.toString()).pathname.replace(/^\/+/, '');
        if (/^fcm_tokens\/[^/]+$/.test(path) && value?.token) {
          return this.child(encodeKey(value.token)).set(value, onComplete);
        }
      } catch {}
      return nativeSet.call(this, value, onComplete);
    };

    refProto.__chatoneHotfixPatched = true;
    log('firebase token writer patched');
    return true;
  };

  let tries = 0;
  const waitForFirebase = () => {
    if (patchFirebaseRef()) return;
    tries += 1;
    if (tries < 80) setTimeout(waitForFirebase, 250);
  };
  waitForFirebase();
})();
