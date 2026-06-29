/* Chatone PWA runtime hotfixes
 * - Prevent sw.js from replacing the FCM service worker.
 * - Store FCM tokens per device when the older main script writes the legacy path.
 * - Clear stale stamp blob URLs saved in IndexedDB by older builds.
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

  const clearStampCache = () => {
    if (!('indexedDB' in window)) return;
    const req = indexedDB.open('chatone-pwa', 1);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cache')) {
        db.close();
        return;
      }
      const tx = db.transaction('cache', 'readwrite');
      const store = tx.objectStore('cache');
      store.delete('stamps');
      store.delete('stamps-v2');
      tx.oncomplete = () => { db.close(); log('stamp cache cleared'); };
      tx.onerror = () => db.close();
      tx.onabort = () => db.close();
    };
  };

  clearStampCache();

  if ('serviceWorker' in navigator) {
    const nativeRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = (scriptURL, options = {}) => {
      const url = String(scriptURL || '');
      if (url.endsWith('/sw.js') || url.endsWith('sw.js')) {
        const scope = options.scope || new URL('./', document.baseURI).pathname;
        log('skip legacy sw.js registration');
        return navigator.serviceWorker.getRegistration(scope)
          .then(reg => reg || navigator.serviceWorker.ready);
      }
      return nativeRegister(scriptURL, options);
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
