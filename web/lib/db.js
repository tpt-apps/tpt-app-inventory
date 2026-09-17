// Minimal IndexedDB wrapper for a single "skus" object store, keyed by SKU.
// Kept dependency-free so it can be cached offline like every other file
// the app ships.

const DB_NAME = "tpt-inventory";
const DB_VERSION = 1;
const STORE = "skus";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {{id: string, expectedQty: number|null}[]} skus
 */
export async function replaceAllSkus(skus) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const store = t.objectStore(STORE);
    store.clear();
    for (const { id, expectedQty } of skus) {
      store.put({ id, expectedQty: expectedQty ?? null, countedQty: 0, lastScannedAt: null, unexpected: false });
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getAllSkus() {
  const db = await openDb();
  const store = db.transaction(STORE, "readonly").objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Record a scan hit for `id`. If it's not in the loaded SKU list, it's
 * added on the fly and flagged `unexpected` (useful for catching mis-picks
 * or unlisted stock during a count). Returns the updated record.
 */
export async function recordScan(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const store = t.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      let sku = getReq.result;
      if (!sku) {
        sku = { id, expectedQty: null, countedQty: 0, lastScannedAt: null, unexpected: true };
      }
      sku.countedQty += 1;
      sku.lastScannedAt = Date.now();
      store.put(sku);
      resolve(sku);
    };
    getReq.onerror = () => reject(getReq.error);
    t.onerror = () => reject(t.error);
  });
}

export async function resetAllCounts() {
  const skus = await getAllSkus();
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const store = t.objectStore(STORE);
    for (const sku of skus) {
      if (sku.unexpected) {
        store.delete(sku.id);
      } else {
        sku.countedQty = 0;
        sku.lastScannedAt = null;
        store.put(sku);
      }
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
