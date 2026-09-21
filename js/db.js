// === INDEXEDDB LAYER ===
// Why IndexedDB and not localStorage (which the sibling finance app uses): an Apple
// Health export covering several years is hundreds of megabytes of XML. Even after
// we reduce it to sessions + daily aggregates it comfortably exceeds the ~5MB
// localStorage ceiling, and we need range queries by date rather than one big blob.
//
// Stores
//   sessions  — one discrete bout of activity (a run, a gym session)
//   daily     — one (date, metric, source) aggregate (steps, weight, resting HR, sleep)
//   imports   — a log of every import batch, so any import can be undone wholesale
//   settings  — a single key/value row per setting
//   goals     — per-metric targets
//   overrides — manual dedupe decisions, kept separate so a re-import cannot undo them
//
// Records in `sessions` and `daily` carry deterministic ids derived from their own
// content, which is what makes re-importing an overlapping export a no-op.

const DB_STORES = {
  sessions:  { keyPath: 'id', indexes: [
    { name: 'byStart',    keyPath: 'start' },
    { name: 'byDate',     keyPath: 'localDate' },
    { name: 'byActivity', keyPath: ['activity', 'localDate'] },
    { name: 'byBatch',    keyPath: 'importBatch' }
  ]},
  daily:     { keyPath: 'id', indexes: [
    { name: 'byDate',       keyPath: 'localDate' },
    { name: 'byMetricDate', keyPath: ['metric', 'localDate'] },
    { name: 'byBatch',      keyPath: 'importBatch' }
  ]},
  imports:   { keyPath: 'id', indexes: [{ name: 'byTime', keyPath: 'importedAt' }] },
  settings:  { keyPath: 'key' },
  goals:     { keyPath: 'id' },
  overrides: { keyPath: 'id' }
};

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(APP.dbName, APP.dbVersion);
    req.onupgradeneeded = ev => {
      const db = req.result;
      for (const [name, spec] of Object.entries(DB_STORES)) {
        const store = db.objectStoreNames.contains(name)
          ? req.transaction.objectStore(name)
          : db.createObjectStore(name, { keyPath: spec.keyPath });
        for (const idx of (spec.indexes || [])) {
          if (!store.indexNames.contains(idx.name)) store.createIndex(idx.name, idx.keyPath);
        }
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeNames, mode) {
  return openDB().then(db => db.transaction(storeNames, mode));
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(store, key) {
  return tx([store], 'readonly').then(t => promisifyRequest(t.objectStore(store).get(key)));
}

function dbGetAll(store) {
  return tx([store], 'readonly').then(t => promisifyRequest(t.objectStore(store).getAll()));
}

function dbPut(store, value) {
  return tx([store], 'readwrite').then(t => {
    const p = promisifyRequest(t.objectStore(store).put(value));
    return p.then(() => txDone(t)).then(() => value);
  });
}

function dbDelete(store, key) {
  return tx([store], 'readwrite').then(t => {
    const p = promisifyRequest(t.objectStore(store).delete(key));
    return p.then(() => txDone(t));
  });
}

function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

// Bulk write. Import batches are tens of thousands of records, and one transaction
// per record would take minutes — a single transaction per chunk takes milliseconds.
function dbPutMany(store, values) {
  if (!values.length) return Promise.resolve(0);
  return tx([store], 'readwrite').then(t => {
    const os = t.objectStore(store);
    for (const v of values) os.put(v);
    return txDone(t).then(() => values.length);
  });
}

// Range query over an index, inclusive at both ends.
function dbRange(store, indexName, lower, upper) {
  return tx([store], 'readonly').then(t => {
    const src = indexName ? t.objectStore(store).index(indexName) : t.objectStore(store);
    return promisifyRequest(src.getAll(IDBKeyRange.bound(lower, upper)));
  });
}

// Every record written by one import, so the batch can be rolled back.
function dbByBatch(store, batchId) {
  return tx([store], 'readonly').then(t =>
    promisifyRequest(t.objectStore(store).index('byBatch').getAll(batchId)));
}

function dbDeleteByBatch(store, batchId) {
  return tx([store], 'readwrite').then(t => {
    const idx = t.objectStore(store).index('byBatch');
    return promisifyRequest(idx.getAllKeys(batchId)).then(keys => {
      const os = t.objectStore(store);
      for (const k of keys) os.delete(k);
      return txDone(t).then(() => keys.length);
    });
  });
}

function dbCount(store) {
  return tx([store], 'readonly').then(t => promisifyRequest(t.objectStore(store).count()));
}

function dbClear(store) {
  return tx([store], 'readwrite').then(t => {
    const p = promisifyRequest(t.objectStore(store).clear());
    return p.then(() => txDone(t));
  });
}

// --- settings convenience -------------------------------------------------------
// Settings live one row per key so a write never races a concurrent import.

function getSetting(key, fallback) {
  return dbGet('settings', key).then(row => (row ? row.value : fallback));
}
function setSetting(key, value) { return dbPut('settings', { key, value }); }

function loadSettings() {
  return dbGetAll('settings').then(rows => {
    const saved = {};
    for (const r of rows) saved[r.key] = r.value;
    // Merge over defaults so settings added in a later version get a sensible value
    // instead of undefined — the same trick as the finance app's mergeSavedState.
    return { ...DEFAULT_SETTINGS, ...saved,
             sourcePriority: { ...DEFAULT_SOURCE_PRIORITY, ...(saved.sourcePriority || {}) },
             dedupe: { ...DEFAULT_SETTINGS.dedupe, ...(saved.dedupe || {}) } };
  });
}
