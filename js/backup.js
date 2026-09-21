// === BACKUP AND RESTORE ===
// Everything the app knows lives in one browser's IndexedDB. A cleared cache, a lost
// phone or a reinstalled browser takes it with it, and re-importing means finding the
// original export files again — which for Apple Health means another twenty-minute
// export from the phone. So: a single file, written by the user, readable by them.
//
// The file is gzipped JSON. Years of daily records run to tens of megabytes as plain
// text and compress by roughly ten to one, and both directions are native browser
// APIs, so this costs no dependency.

const BACKUP_VERSION = 1;
const BACKUP_STORES = ['sessions', 'daily', 'imports', 'settings', 'goals', 'overrides'];

function buildBackup() {
  return Promise.all(BACKUP_STORES.map(name => dbGetAll(name).then(rows => [name, rows])))
    .then(pairs => {
      const stores = Object.fromEntries(pairs);
      return {
        // The marker is what the file sniffer looks for, so a backup dropped onto the
        // import screen is recognised as one rather than as unknown JSON.
        activityLedgerBackup: BACKUP_VERSION,
        createdAt: Date.now(),
        counts: Object.fromEntries(pairs.map(([name, rows]) => [name, rows.length])),
        stores
      };
    });
}

function exportBackup() {
  return buildBackup().then(backup => {
    const json = JSON.stringify(backup);
    const name = `activity-ledger-${todayLocal()}.json.gz`;
    // Compression is best-effort: if the browser lacks CompressionStream the plain
    // file is still a valid backup, and a bigger download beats no backup at all.
    if (typeof CompressionStream === 'undefined') {
      downloadBlob(new Blob([json], { type: 'application/json' }),
                   name.replace(/\.gz$/, ''));
      return backup;
    }
    return new Response(
      new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))
    ).blob().then(blob => {
      downloadBlob(blob, name);
      return backup;
    });
  });
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  // Revoking immediately can cancel the download in some browsers; a moment later is
  // safe and still avoids leaking the object URL.
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- restoring ----------------------------------------------------------------------

// GZIP_MAGIC is declared with the other file signatures in import/sniffer.js — these
// are plain scripts sharing one global scope, so a second const of the same name is a
// syntax error that takes down every file after it.
function readBackupFile(file) {
  return file.slice(0, 2).arrayBuffer().then(buf => {
    const head = new Uint8Array(buf);
    const gzipped = GZIP_MAGIC.every((b, i) => head[i] === b);
    if (!gzipped) return file.text();
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot read compressed backups.');
    }
    return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }).then(text => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error('That file is not readable as a backup.');
    }
    if (!parsed || !parsed.activityLedgerBackup) {
      throw new Error('That file is not an Activity Ledger backup.');
    }
    if (parsed.activityLedgerBackup > BACKUP_VERSION) {
      throw new Error('That backup was made by a newer version of the app.');
    }
    return parsed;
  });
}

// Restoring merges rather than replaces. Every record carries a deterministic id, so
// writing one that already exists is a no-op — which means restoring an older backup
// on top of a newer database adds what was missing instead of throwing away the
// difference. Replacing would be the more destructive reading of "restore".
function restoreBackup(backup) {
  const stores = backup.stores || {};
  const written = {};
  return BACKUP_STORES.reduce((chain, name) => chain.then(() => {
    const rows = stores[name];
    if (!Array.isArray(rows) || !rows.length) { written[name] = 0; return; }
    return dbPutMany(name, rows).then(n => { written[name] = n; });
  }), Promise.resolve())
    // Reconciliation is re-run because a restore can introduce records that change
    // which source wins on a given day.
    .then(runDedupe)
    .then(() => written);
}

function backupSummary(backup) {
  const c = backup.counts || {};
  return {
    when: backup.createdAt ? new Date(backup.createdAt).toLocaleString() : 'unknown',
    sessions: c.sessions || 0,
    daily: c.daily || 0,
    goals: c.goals || 0
  };
}
