// === THE DATA SCREEN ===
// Where files come in. For now it inspects: drop an export here and it reports what
// is actually inside, without writing anything. That matters because nobody — not
// even the person whose data it is — reliably knows what an Apple or Strava export
// contains until they look.

let _inspection = null;   // the most recent report, kept so the view can re-render
let _busy = false;

function renderDataView(host) {
  host.innerHTML = `
    <div class="view-head">
      <h1>Your data</h1>
      <p class="subtle">Everything stays on this device. Nothing is uploaded.</p>
    </div>

    <div class="card">
      <div id="dropzone" class="dropzone" tabindex="0" role="button"
           aria-label="Choose or drop an export file">
        <div class="dropzone-icon" aria-hidden="true">📥</div>
        <div class="dropzone-title">Drop an export here</div>
        <div class="dropzone-sub">or click to choose a file</div>
        <input type="file" id="file-input" hidden
               accept=".zip,.xml,.csv,application/zip,text/xml,text/csv">
      </div>
      <div id="import-status"></div>
    </div>

    <div id="inspection-result"></div>

    ${exportHelpHtml()}`;

  wireDropzone();
  if (_inspection) renderInspection(_inspection);
}

function wireDropzone() {
  const zone = el('dropzone');
  const input = el('file-input');
  if (!zone || !input) return;

  const choose = () => { if (!_busy) input.click(); };
  zone.onclick = choose;
  zone.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(); } };
  input.onchange = () => { if (input.files[0]) handleFile(input.files[0]); };

  // The whole zone is a drop target. preventDefault on dragover is what actually
  // enables dropping — without it the browser navigates away to the file instead.
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
  el('inspection-result').innerHTML = '';

  const status = el('import-status');
  const total = file.size;
  let lastPaint = 0;

  const onProgress = bytes => {
    // Repainting on every chunk would spend more time in layout than in parsing.
    const now = Date.now();
    if (now - lastPaint < 100) return;
    lastPaint = now;
    // For a zipped file the byte count is of the DECOMPRESSED stream, which is larger
    // than the file on disk, so a percentage would be misleading — show the raw count.
    const pct = file.name.endsWith('.zip') ? null : (bytes / total) * 100;
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
      status.innerHTML = `<div class="error-box">
        <strong>Could not read that file.</strong>
        <div class="subtle">${escHtml(err && err.message || String(err))}</div></div>`;
    })
    .finally(() => { _busy = false; });
}

function renderInspection(rep) {
  const host = el('inspection-result');
  if (!host) return;

  if (rep.unsupported) {
    host.innerHTML = `<div class="card">
      <h2>${escHtml(rep.file.label)}</h2>
      <p class="subtle">This file was recognised but cannot be read yet.</p>
      ${rep.sniff.entries ? `<details><summary>Archive contents
        (${rep.sniff.entries.length} files)</summary>
        <pre class="scroll">${escHtml(rep.sniff.entries.map(e => e.name).join('\n'))}</pre>
        </details>` : ''}
      ${copyReportButton()}</div>`;
    wireCopyButton(rep);
    return;
  }

  const span = rep.range.from && rep.range.to
    ? `${rep.range.from} → ${rep.range.to}` : 'unknown';
  const years = rep.range.from && rep.range.to
    ? (daysBetween(rep.range.from, rep.range.to) / 365.25) : 0;

  host.innerHTML = `
    <div class="card">
      <h2>${escHtml(rep.file.label)}</h2>
      <div class="stat-row">
        ${statTile('Covers', span, years >= 1 ? `${years.toFixed(1)} years` : '')}
        ${statTile('Workouts', humanCount(rep.totals.workouts), '')}
        ${statTile('Records', humanCount(rep.totals.records), `read in ${(rep.ms / 1000).toFixed(1)}s`)}
      </div>

      <h3>Who recorded it</h3>
      <p class="subtle">Each device that contributed data. Overlapping sources are the
         reason this app reconciles rather than adds up.</p>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Source</th><th class="num">Records</th></tr></thead>
        <tbody>${rep.sources.map(s => `<tr>
          <td>${escHtml(s.name)}</td><td class="num">${humanCount(s.count)}</td></tr>`).join('')}
        </tbody>
      </table></div>

      <h3>What is in the file</h3>
      <p class="subtle">A green tick marks the types this app will actually store.</p>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Type</th><th class="num">Count</th><th>Range</th><th>Tracked</th></tr></thead>
        <tbody>${rep.types.map(t => `<tr>
          <td>${escHtml(t.type.replace(/^HK(Quantity|Category)TypeIdentifier/, '').replace(/HKWorkoutActivityType/, ''))}</td>
          <td class="num">${humanCount(t.count)}</td>
          <td class="subtle nowrap">${escHtml(t.from || '?')} → ${escHtml(t.to || '?')}</td>
          <td>${t.mapped ? `<span class="yes">✓ ${escHtml(t.mapped)}</span>` : '<span class="no">—</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>

      ${copyReportButton()}
    </div>`;
  wireCopyButton(rep);
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
    <button class="btn btn-ghost" id="copy-report">Copy report as text</button>
  </div>`;
}

function wireCopyButton(rep) {
  const btn = el('copy-report');
  if (!btn) return;
  btn.onclick = () => {
    const text = inspectionReportText(rep);
    navigator.clipboard.writeText(text)
      .then(() => showToast('Report copied', 'success'))
      .catch(() => showToast('Could not copy — check clipboard permissions', 'error'));
  };
}

// Getting the exports is the one part of this the app cannot do for you, so the
// instructions live next to the drop zone rather than in a README nobody opens.
function exportHelpHtml() {
  return `
  <div class="card">
    <h2>How to get your exports</h2>
    <details open>
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
    <details>
      <summary><strong>Fitbit</strong> — automatic, once connected</summary>
      <p>Fitbit can sync directly, without export files. That connection arrives in a
         later version; for now, if the Google Health app on your iPhone is set to share
         with Apple Health, your Fitbit data is already inside the Apple export above.</p>
    </details>
  </div>`;
}

registerView({ id: 'data', label: 'Data', icon: '📥', render: renderDataView });
