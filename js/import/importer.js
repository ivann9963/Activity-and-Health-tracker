// === IMPORT ORCHESTRATION ===
// Parse (in a worker), store, then reconcile. Each import is recorded as a batch so
// it can be undone in full — importing a several-gigabyte archive is a big, slightly
// scary action, and being able to take it back makes it a safe one.

function newBatchId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function importFile(file, callbacks) {
  const cb = callbacks || {};
  const stage = s => cb.onStage && cb.onStage(s);

  return sniffFile(file).then(sniff => {
    if (IMPORTABLE_KINDS.indexOf(sniff.kind) === -1) {
      throw new Error(`${sniff.label} cannot be imported yet.`);
    }
    if (sniff.kind !== 'apple-zip' && sniff.kind !== 'apple-xml') {
      throw new Error(`${sniff.label} support is not finished yet — for now, import your ` +
                      `Apple Health export.`);
    }
    const batch = newBatchId();
    stage('Reading the file');
    return parseApple(file, sniff, batch, cb.onProgress)
      .then(res => {
        stage('Saving');
        return storeBatch(file, sniff, batch, res, stage);
      });
  });
}

// Parse in a worker, falling back to the main thread if one cannot be created —
// which happens on a file:// origin, and in a few locked-down browser configurations.
// A frozen tab beats no import at all.
function parseApple(file, sniff, batch, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker('js/workers/import-worker.js');
    } catch (err) {
      console.warn('Worker unavailable, parsing on the main thread:', err);
      return resolve(parseAppleInline(file, sniff, batch, onProgress));
    }
    worker.onmessage = ev => {
      const msg = ev.data;
      if (msg.type === 'progress') { if (onProgress) onProgress(msg.bytes); return; }
      worker.terminate();
      if (msg.type === 'error') reject(new Error(msg.message));
      else resolve(msg);
    };
    worker.onerror = err => {
      worker.terminate();
      // An error event here usually means importScripts failed (a path problem or an
      // offline cache miss), so retrying inline is worth a try before giving up.
      console.warn('Worker failed, parsing on the main thread:', err.message);
      resolve(parseAppleInline(file, sniff, batch, onProgress));
    };
    worker.postMessage({ file, kind: sniff.kind, entry: sniff.entry || null, batch });
  });
}

function parseAppleInline(file, sniff, batch, onProgress) {
  return appleXmlStream(file, sniff)
    .then(stream => scanAppleExport(stream, { collect: true, importBatch: batch, onProgress }));
}

// Write in chunks. One transaction for 40,000 records is fine, but chunking keeps
// each transaction short enough that the UI can paint between them.
const WRITE_CHUNK = 2000;

function storeChunked(store, records, onCount) {
  let i = 0;
  const step = () => {
    if (i >= records.length) return Promise.resolve();
    const slice = records.slice(i, i + WRITE_CHUNK);
    i += WRITE_CHUNK;
    return dbPutMany(store, slice).then(() => {
      if (onCount) onCount(Math.min(i, records.length), records.length);
      return step();
    });
  };
  return step();
}

function storeBatch(file, sniff, batch, res, stage) {
  const record = {
    id: batch,
    importedAt: Date.now(),
    fileName: file.name,
    fileSize: file.size,
    kind: sniff.kind,
    exportDate: res.meta && res.meta.exportDate || null,
    counts: { sessions: res.sessions.length, daily: res.daily.length,
              records: res.tally.records, workouts: res.tally.workouts },
    range: { from: res.tally.from, to: res.tally.to },
    sources: Object.entries(res.tally.sources || {})
      .sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
  };

  return storeChunked('sessions', res.sessions,
      n => stage(`Saving workouts (${humanCount(n)})`))
    .then(() => storeChunked('daily', res.daily,
      n => stage(`Saving daily figures (${humanCount(n)})`)))
    .then(() => dbPut('imports', record))
    .then(() => { stage('Reconciling duplicates'); return runDedupe(); })
    .then(dedupe => ({ batch: record, dedupe }));
}

// Remove everything one import wrote, then reconcile again so records that were
// suppressed in favour of the removed ones come back.
function undoImport(batchId) {
  return Promise.all([
    dbDeleteByBatch('sessions', batchId),
    dbDeleteByBatch('daily', batchId)
  ]).then(([s, d]) => dbDelete('imports', batchId)
    .then(runDedupe)
    .then(() => ({ sessions: s, daily: d })));
}
