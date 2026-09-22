// === THE DATA SCREEN ===
// Where files come in. Inspect first, import second: the report shows what is actually
// inside a file before anything is written, because nobody — not even the person whose
// data it is — reliably knows what their own health export contains until they look.

let _inspection = null;    // most recent report, kept so the view survives a re-render
let _inspectedFile = null; // the File the report describes, so Import needs no re-pick
let _busy = false;

function renderDataView(host) {
  return Promise.all([dbGetAll('imports'), getSetting('dedupeSummary', null)])
    .then(([imports, dedupe]) => {
    imports.sort((a, b) => b.importedAt - a.importedAt);
    host.innerHTML = `
      <div class="view-head">
        <h1>Your data</h1>
        <p class="subtle">Everything stays on this device. Nothing is uploaded.</p>
      </div>

      <div class="card">
        <div id="dropzone" class="dropzone" tabindex="0" role="button"
             aria-label="Choose or drop an export file">
          <div class="dropzone-icon">${icon('upload', 36)}</div>
          <div class="dropzone-title">Drop an export here</div>
          <div class="dropzone-sub">or click to choose a file</div>
          <input type="file" id="file-input" hidden
                 accept=".zip,.xml,.csv,.gz,.json,application/zip,application/gzip,text/xml,text/csv,application/json">
        </div>
        <div id="import-status"></div>
      </div>

      <div id="inspection-result"></div>
      ${reconciliationHtml(dedupe)}
      ${importHistoryHtml(imports)}
      ${exportHelpHtml()}`;

    wireDropzone();
    wireHistory();
    if (_inspection) renderInspection(_inspection);
  });
}

function wireDropzone() {
  const zone = el('dropzone');
  const input = el('file-input');
  if (!zone || !input) return;

  const choose = () => { if (!_busy) input.click(); };
  zone.onclick = choose;
  zone.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(); } };
  input.onchange = () => { if (input.files[0]) handleFile(input.files[0]); };

  // preventDefault on dragover is what actually enables dropping; without it the
  // browser navigates away to the file instead.
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); zone.classList.remove('dragging');
  }));
  zone.addEventListener('drop', e => {
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
}

function handleFile(file) {
  if (_busy) return;
  _busy = true;
  _inspection = null;
  _inspectedFile = file;
  el('inspection-result').innerHTML = '';

  const status = el('import-status');
  let lastPaint = 0;
  const onProgress = bytes => {
    const now = Date.now();
    if (now - lastPaint < 100) return;
    lastPaint = now;
    // For a zipped file the byte count is of the DECOMPRESSED stream, which is bigger
    // than the file on disk, so a percentage would be misleading — show the raw count.
    const pct = /\.zip$/i.test(file.name) ? null : (bytes / file.size) * 100;
    status.innerHTML = progressBar(pct, `Reading… ${humanSize(bytes)}`);
  };

  status.innerHTML = progressBar(null, 'Opening file…');

  inspectFile(file, onProgress)
    .then(report => {
      _inspection = report;
      status.innerHTML = '';
      renderInspection(report);
    })
    .catch(err => {
      console.error(err);
      status.innerHTML = errorBox('Could not read that file.', err);
    })
    .finally(() => { _busy = false; });
}

function errorBox(headline, err) {
  return `<div class="error-box"><strong>${escHtml(headline)}</strong>
    <div class="subtle">${escHtml(err && err.message || String(err))}</div></div>`;
}

function renderInspection(rep) {
  const host = el('inspection-result');
  if (!host) return;

  if (rep.unsupported) {
    host.innerHTML = `<div class="card">
      <h2>${escHtml(rep.file.label)}</h2>
      <p class="subtle">${rep.error
        ? escHtml(rep.error)
        : 'This file was recognised but cannot be read yet.'}</p>
      ${rep.sniff.entries ? `<details><summary>Archive contents
        (${rep.sniff.entries.length} files)</summary>
        <pre class="scroll">${escHtml(rep.sniff.entries.map(e => e.name).join('\n'))}</pre>
        </details>` : ''}
      ${copyReportButton()}</div>`;
    wireCopyButton(rep);
    return;
  }

  const span = rep.range.from && rep.range.to ? `${rep.range.from} → ${rep.range.to}` : 'unknown';
  const years = rep.range.from && rep.range.to
    ? (daysBetween(rep.range.from, rep.range.to) / 365.25) : 0;
  const importable = ['apple-zip', 'apple-xml', 'fitbit-zip', 'app-backup']
    .indexOf(rep.file.kind) !== -1;

  host.innerHTML = `
    <div class="card">
      <h2>${escHtml(rep.file.label)}</h2>
      <div class="stat-row">
        ${statTile('Covers', span, years >= 1 ? `${years.toFixed(1)} years` : '')}
        ${rep.takeout
          ? statTile('Folders', humanCount(rep.types.length), '')
          : statTile('Workouts', humanCount(rep.totals.workouts), '')}
        ${statTile(rep.takeout ? 'Data files' : 'Records', humanCount(rep.totals.records),
                   `read in ${(rep.ms / 1000).toFixed(1)}s`)}
      </div>

      ${importable ? `<div class="card-actions">
        <button class="btn btn-primary" id="do-import">${rep.file.kind === 'app-backup'
          ? 'Restore this backup' : 'Import this file'}</button>
        <button class="btn btn-ghost" id="copy-report">Copy report as text</button>
      </div>` : `<p class="subtle">Importing this kind of file is not supported yet.</p>
        ${copyReportButton()}`}

      ${(rep.takeout || rep.isBackup) ? '' : `
      <h3>Who recorded it</h3>
      <p class="subtle">Each device that contributed data. Overlapping sources are the
         reason this app reconciles rather than adds up.</p>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Source</th><th class="num">Records</th></tr></thead>
        <tbody>${rep.sources.map(s => `<tr>
          <td>${escHtml(s.name)}</td><td class="num">${humanCount(s.count)}</td></tr>`).join('')}
        </tbody>
      </table></div>`}

      <h3>${rep.isBackup ? 'What the backup holds'
        : rep.takeout ? 'What is in the archive' : 'What is in the file'}</h3>
      <p class="subtle">${rep.isBackup
        ? 'Restoring merges rather than replaces: records carry stable ids, so ' +
          'anything already here is left alone and anything missing is added back.'
        : rep.takeout
        ? 'Each folder holds one kind of data. A green tick marks what will be ' +
          'imported; expand a row to see the real shape of its files.'
        : 'A green tick marks the types this app will actually store.'}</p>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Type</th><th class="num">Count</th><th>Range</th><th>Tracked</th></tr></thead>
        <tbody>${rep.types.map(t => `<tr>
          <td>${escHtml(t.type.replace(/^HK(Quantity|Category)TypeIdentifier/, '').replace(/HKWorkoutActivityType/, ''))}
            ${t.sample ? sampleHtml(t.sample) : ''}</td>
          <td class="num">${humanCount(t.count)}</td>
          <td class="subtle nowrap">${escHtml(t.from || '?')} → ${escHtml(t.to || '?')}</td>
          <td>${t.mapped ? `<span class="yes">${icon('check', 14)} ${escHtml(t.mapped)}</span>` : '<span class="no">—</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;

  wireCopyButton(rep);
  const btn = el('do-import');
  if (btn) btn.onclick = () => startImport(_inspectedFile);
}

function startImport(file) {
  if (_busy || !file) return;
  _busy = true;
  const status = el('import-status');
  const btn = el('do-import');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

  let lastPaint = 0, stageText = 'Reading the file';
  const paint = detail => { status.innerHTML = progressBar(null, detail); };

  importFile(file, {
    onStage: s => { stageText = s; paint(s); },
    onProgress: bytes => {
      const now = Date.now();
      if (now - lastPaint < 120) return;
      lastPaint = now;
      paint(`${stageText}… ${humanSize(bytes)}`);
    }
  })
    .then(result => {
      status.innerHTML = '';
      _inspection = null;
      _inspectedFile = null;
      if (result.restored) {
        const r = result.restored;
        const skipped = Object.values(r._skipped || {}).reduce((n, v) => n + v, 0);
        showToast(`Restored ${plural(r.sessions || 0, 'workout')} and ` +
                  `${plural(r.daily || 0, 'daily figure')}` +
                  (skipped ? ` · ${humanCount(skipped)} already here` : ''), 'success');
      } else {
        const suppressed = result.dedupe.sessionsSuppressed + result.dedupe.dailySuppressed;
        showToast(`Imported ${plural(result.batch.counts.sessions, 'workout')}` +
                  (suppressed ? ` · ${humanCount(suppressed)} duplicates set aside` : ''),
                  'success');
      }
      refreshView();
    })
    .catch(err => {
      console.error(err);
      status.innerHTML = errorBox('Import failed.', err);
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
    })
    .finally(() => { _busy = false; });
}

// Reconciliation is worth surfacing — the totals depend on it — but it is a property
// of the data, not a place you visit, so it reports here and links one tap deeper.
function reconciliationHtml(d) {
  if (!d || (!d.sessionsSuppressed && !d.dailySuppressed)) return '';
  return `<div class="card">
    <h2>Reconciliation</h2>
    <p class="subtle">${plural(d.sessionsSuppressed, 'workout')} and
       ${plural(d.dailySuppressed, 'daily figure')} are set aside so nothing is counted
       twice. Nothing was deleted${d.manualOverrides
         ? `, and ${plural(d.manualOverrides, 'decision')} ${d.manualOverrides === 1 ? 'is' : 'are'} yours`
         : ''}.</p>
    <div class="card-actions">
      <button class="btn btn-ghost" onclick="navigate('duplicates')">Review the decisions</button>
    </div>
  </div>`;
}

function importHistoryHtml(imports) {
  if (!imports.length) return '';
  return `<div class="card">
    <h2>Imports</h2>
    <p class="subtle">Each import can be undone in full. Undoing one brings back any
       records it had superseded.</p>
    ${imports.map(b => `
      <div class="list-row">
        <div>
          <div class="list-title">${escHtml(b.fileName || b.kind)}</div>
          <div class="subtle">${escHtml(b.range.from || '?')} → ${escHtml(b.range.to || '?')}
            · ${humanCount(b.counts.sessions)} workouts
            · ${humanCount(b.counts.daily)} daily figures</div>
          ${b.sources && b.sources.length ? `<div class="subtle">recorded by
            ${b.sources.slice(0, 6).map(src =>
              `${escHtml(src.name)} <span class="src-count">${humanCount(src.count)}</span>`
            ).join(' · ')}${b.sources.length > 6 ? ' …' : ''}</div>` : ''}
          <div class="subtle">imported ${new Date(b.importedAt).toLocaleString()}</div>
        </div>
        <button class="btn btn-ghost btn-small" data-undo="${escHtml(b.id)}">Undo</button>
      </div>`).join('')}
  </div>`;
}

function wireHistory() {
  document.querySelectorAll('[data-undo]').forEach(btn => {
    btn.onclick = () => confirmDialog({
      title: 'Undo this import?',
      message: 'Everything this file added is removed. Your original export is untouched, ' +
               'so you can import it again at any time.',
      confirmLabel: 'Undo import', danger: true
    }, () => {
      undoImport(btn.dataset.undo).then(({ sessions, daily }) => {
        showToast(`Removed ${humanCount(sessions)} workouts and ${humanCount(daily)} daily figures`, 'success');
        refreshView();
      });
    });
  });
}

// The schema of one sampled file, shown inline so the report is self-contained.
function sampleHtml(sample) {
  return `<details class="sample"><summary>${escHtml(sample.file)}</summary>
    <div class="subtle">${escHtml(sample.format)}${
      sample.count != null ? ` · ${humanCount(sample.count)} entries` : ''}</div>
    ${sample.error ? `<div class="subtle">${escHtml(sample.error)}</div>` : ''}
    ${sample.keys && sample.keys.length
      ? `<div class="sample-keys">${sample.keys.map(k => `<code>${escHtml(k)}</code>`).join(' ')}</div>` : ''}
    ${sample.example ? `<pre>${escHtml(JSON.stringify(sample.example, null, 1))}</pre>` : ''}
  </details>`;
}

function statTile(label, value, sub) {
  // Long values (a date span) need a smaller face or they wrap to three lines.
  const long = String(value).length > 12 ? ' stat-value-long' : '';
  return `<div class="stat-tile">
    <div class="stat-label">${escHtml(label)}</div>
    <div class="stat-value${long}">${escHtml(value)}</div>
    <div class="stat-sub">${escHtml(sub || '')}</div></div>`;
}

function copyReportButton() {
  return `<div class="card-actions">
    <button class="btn btn-ghost" id="copy-report">Copy report as text</button></div>`;
}

function wireCopyButton(rep) {
  const btn = el('copy-report');
  if (!btn) return;
  btn.onclick = () => navigator.clipboard.writeText(inspectionReportText(rep))
    .then(() => showToast('Report copied', 'success'))
    .catch(() => showToast('Could not copy — check clipboard permissions', 'error'));
}

// Getting the exports is the one part of this the app cannot do for you, so the
// instructions live next to the drop zone rather than in a README nobody opens.
function exportHelpHtml() {
  return `
  <div class="card">
    <h2>How to get your exports</h2>
    <details>
      <summary><strong>Apple Health</strong> — your full history</summary>
      <ol>
        <li>Open the <strong>Health</strong> app on your iPhone.</li>
        <li>Tap your <strong>profile picture</strong>, top right.</li>
        <li>Scroll to the bottom and tap <strong>Export All Health Data</strong>.</li>
        <li>Wait — it takes several minutes — then save <code>export.zip</code> to Files.</li>
      </ol>
      <p class="subtle">Drop the <code>.zip</code> in as-is; there is no need to unzip it.</p>
    </details>
    <details>
      <summary><strong>Strava</strong> — your rides, runs and swims</summary>
      <ol>
        <li>On strava.com, open <strong>Settings → My Account</strong>.</li>
        <li>Choose <strong>Download or Delete Your Account</strong>, then <strong>Get Started</strong>.</li>
        <li>Under <em>Download Request</em>, click <strong>Request your archive</strong>.</li>
        <li>Strava emails a link, usually within a few hours.</li>
      </ol>
    </details>
    <details open>
      <summary><strong>Google Health</strong> (the app formerly called Fitbit)</summary>
      <p><strong>The easy route — no second file needed.</strong> Google Health can push
         its data back into Apple Health, so one Apple export then covers both. In the
         <strong>Google Health</strong> app: tap your <strong>profile icon</strong> →
         <strong>Partner apps</strong> → <strong>Apple Health</strong> →
         <strong>Get started</strong> → <strong>Agree</strong>, then grant every metric
         you care about. If it offers a history window, choose the longest one.</p>
      <p>Afterwards, redo the Apple Health export above and drop it here. The report
         will show <em>Google Health</em> as a recording source, and its date range tells
         you how far back the sync actually reached.</p>
      <p><strong>The thorough route.</strong> Go to
         <a href="https://takeout.google.com" target="_blank" rel="noopener">takeout.google.com</a>,
         press <em>Deselect all</em>, then tick <strong>Fitbit</strong> — Google renamed
         the app but not the Takeout category, so that checkbox is your Google Health
         data. Drop the resulting archive here and the report will show exactly what is
         inside it.</p>
    </details>
  </div>`;
}

registerView({ id: 'data', label: 'Data', icon: 'data', render: renderDataView });
