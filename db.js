// Tiny IndexedDB wrapper for Trail Log. No dependencies.
// 'hikes'  — local mirror of hike records, rendered by the UI.
// 'blobs'  — content-addressed cache of GitHub blob content, keyed by sha.
//            Immutable: once a sha is fetched it never needs re-fetching.
// 'meta'   — small key/value store (last-synced tree map, etc).
const TrailDB = (() => {
  const DB_NAME = 'trail-log';
  const DB_VERSION = 2;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('hikes')) {
          const store = db.createObjectStore('hikes', { keyPath: 'id' });
          store.createIndex('dateHiked', 'dateHiked');
          store.createIndex('country', 'country');
          store.createIndex('state', 'state');
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs', { keyPath: 'sha' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(storeName, mode) {
    const db = await open();
    const transaction = db.transaction(storeName, mode);
    return { transaction, store: transaction.objectStore(storeName) };
  }

  function wrap(store, req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---- hikes ----
  async function getAll() {
    const { store } = await tx('hikes', 'readonly');
    const all = await wrap(store, store.getAll());
    return all.sort((a, b) => {
      const da = a.dateHiked || '';
      const db_ = b.dateHiked || '';
      return db_.localeCompare(da) || (b.createdAt - a.createdAt);
    });
  }

  async function get(id) {
    const { store } = await tx('hikes', 'readonly');
    return wrap(store, store.get(id));
  }

  async function put(hike) {
    const { store, transaction } = await tx('hikes', 'readwrite');
    store.put(hike);
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(hike);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function remove(id) {
    const { store, transaction } = await tx('hikes', 'readwrite');
    store.delete(id);
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function clearAll() {
    const { store, transaction } = await tx('hikes', 'readwrite');
    store.clear();
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // ---- blob cache ----
  async function blobGet(sha) {
    const { store } = await tx('blobs', 'readonly');
    return wrap(store, store.get(sha));
  }

  async function blobPut(sha, contentBase64, contentType) {
    const { store, transaction } = await tx('blobs', 'readwrite');
    store.put({ sha, contentBase64, contentType });
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // ---- meta kv ----
  async function metaGet(key) {
    const { store } = await tx('meta', 'readonly');
    const row = await wrap(store, store.get(key));
    return row ? row.value : undefined;
  }

  async function metaSet(key, value) {
    const { store, transaction } = await tx('meta', 'readwrite');
    store.put({ key, value });
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  return { getAll, get, put, remove, clearAll, blobGet, blobPut, metaGet, metaSet, uuid };
})();
