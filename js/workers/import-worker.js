// === IMPORT WORKER ===
// Parsing happens off the main thread. A multi-hundred-megabyte export takes tens of
// seconds to read, and doing that on the UI thread would freeze the tab hard enough
// that the browser offers to kill the page — while also making the progress bar,
// the one thing that would reassure the user, impossible to paint.
//
// Loaded as a classic worker so the same plain script files the page uses can be
// reused verbatim, with no build step and no duplicate module system.

importScripts(
  '../config.js',
  '../dates.js',
  '../activity-types.js',
  '../records.js',
  '../import/normalize.js',
  '../import/zip.js',
  '../import/xml-stream.js',
  '../import/apple-health.js',
  '../import/csv.js',
  '../import/fitbit-parse.js',
  '../import/fitbit-takeout.js'
);

self.onmessage = function (ev) {
  const { file, kind, entry, entries, batch } = ev.data;

  // Progress is throttled here rather than in the page: posting a message per chunk
  // would flood the main thread with exactly the work we moved off it.
  let lastPost = 0;
  const onProgress = bytes => {
    const now = Date.now();
    if (now - lastPost < 120) return;
    lastPost = now;
    self.postMessage({ type: 'progress', bytes });
  };

  // A Takeout archive is thousands of small files rather than one huge one, so it
  // reports progress by file count and its own walker handles the streaming.
  const parse = kind === 'fitbit-zip'
    ? importTakeout(file, entries, {
        importBatch: batch,
        onProgress: (done, total) => self.postMessage({ type: 'progress', done, total })
      })
    : openStream(file, kind, entry)
        .then(stream => scanAppleExport(stream, { collect: true, importBatch: batch, onProgress }));

  parse
    .then(res => {
      self.postMessage({
        type: 'done',
        sessions: res.sessions,
        daily: res.daily,
        tally: res.tally,
        meta: res.meta,
        bytes: res.bytes || 0
      });
    })
    .catch(err => {
      self.postMessage({ type: 'error', message: err && err.message || String(err) });
    });
};

function openStream(file, kind, entry) {
  if (kind === 'apple-zip') return zipEntryStream(file, entry);
  if (kind === 'apple-xml') return Promise.resolve(file.stream());
  return Promise.reject(new Error('The worker cannot read ' + kind + ' files'));
}
