// Tiny IndexedDB wrapper for Trail Log. No dependencies, no network.
const TrailDB = (() => {
  const DB_NAME = 'trail-log';
  const DB_VERSION = 1;
  const STORE = 'hikes';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('dateHiked', 'dateHiked');
          store.createIndex('country', 'country');
          store.createIndex('state', 'state');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode) {
    const db = await open();
    const transaction = db.transaction(STORE, mode);
    return { transaction, store: transaction.objectStore(STORE) };
  }

  async function getAll() {
    const { store } = await tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => {
        const da = a.dateHiked || '';
        const db_ = b.dateHiked || '';
        return db_.localeCompare(da) || (b.createdAt - a.createdAt);
      }));
      req.onerror = () => reject(req.error);
    });
  }

  async function get(id) {
    const { store } = await tx('readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function put(hike) {
    const { store, transaction } = await tx('readwrite');
    store.put(hike);
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(hike);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function remove(id) {
    const { store, transaction } = await tx('readwrite');
    store.delete(id);
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function clearAll() {
    const { store, transaction } = await tx('readwrite');
    store.clear();
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

  return { getAll, get, put, remove, clearAll, uuid };
})();
