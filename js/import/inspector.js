// === FILE INSPECTOR ===
// Reads an export and reports what is inside it WITHOUT writing anything to the
// database. This exists because nobody — including the person who owns the data —
// reliably knows what their Apple or Strava export actually contains: which devices
// recorded what, how far back it really goes, which record types are present.
//
// It runs the exact same parser the importer uses (with collect:false), so the report
// can never disagree with what an import would do. The report is also renderable as
// plain text, so it can be copied out of the app and shared when something looks off.

function inspectFile(file, onProgress) {
  const startedAt = Date.now();
  return sniffFile(file).then(sniff => {
    const base = {
      file: { name: file.name, size: file.size, kind: sniff.kind, label: sniff.label },
      sniff
    };
    if (sniff.kind === 'apple-zip' || sniff.kind === 'apple-xml') {
      return appleXmlStream(file, sniff)
        .then(stream => scanAppleExport(stream, { collect: false, onProgress }))
        .then(res => ({ ...base, ...summariseApple(res), ms: Date.now() - startedAt }));
    }
    if (sniff.kind === 'strava-csv' || sniff.kind === 'strava-zip') {
      const textOf = sniff.kind === 'strava-zip'
        ? zipEntryText(file, sniff.entry) : file.text();
      return textOf
        .then(text => summariseStrava(text))
        .then(res => ({ ...base, ...res, ms: Date.now() - startedAt }));
    }
    return { ...base, unsupported: true, ms: Date.now() - startedAt };
  });
}

function summariseApple(res) {
  const types = Object.entries(res.tally.types)
    .map(([type, t]) => ({
      type,
      count: t.count,
      from: t.from, to: t.to,
      sources: Object.entries(t.sources).sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ name: n, count: c })),
      units: Object.keys(t.units),
      // Whether this type feeds one of our metrics, or is merely present.
      mapped: appleTypeMetric(type)
    }))
    .sort((a, b) => b.count - a.count);

  return {
    meta: res.meta,
    totals: { records: res.tally.records, workouts: res.tally.workouts, bytes: res.bytes },
    range: { from: res.tally.from, to: res.tally.to },
    sources: Object.entries(res.tally.sources).sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    types
  };
}

// Which of our metrics a given Apple type would feed, for the "what will actually be
// imported" column of the report.
function appleTypeMetric(type) {
  if (type.startsWith('Workout:')) {
    const act = canonicalActivity('apple', type.slice(8));
    const m = Object.entries(METRICS).find(([, spec]) => spec.activity === act);
    return m ? m[0] : 'session:' + act;
  }
  if (type === 'HKCategoryTypeIdentifierSleepAnalysis') return 'sleep';
  const spec = APPLE_DAILY_METRICS[type];
  return spec ? spec.metric : null;
}

function summariseStrava(text) {
  const rows = parseCSVObjects(text);
  const col = name => Object.keys(rows[0] || {}).find(k => k.toLowerCase().includes(name));
  const dateCol = col('activity date');
  const typeCol = col('activity type');
  const byType = Object.create(null);
  let from = null, to = null;

  for (const r of rows) {
    const t = (r[typeCol] || 'Unknown').trim();
    byType[t] = (byType[t] || 0) + 1;
    const d = stravaDateKey(r[dateCol]);
    if (d) {
      if (!from || d < from) from = d;
      if (!to || d > to) to = d;
    }
  }
  return {
    totals: { records: 0, workouts: rows.length, bytes: text.length },
    range: { from, to },
    sources: [{ name: 'Strava', count: rows.length }],
    types: Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({
      type: 'Activity:' + type, count, from, to,
      sources: [{ name: 'Strava', count }], units: [],
      mapped: 'session:' + canonicalActivity('strava', type)
    }))
  };
}

// Strava writes "Mar 12, 2024, 7:41:22 AM" in the account's locale. We only need the
// day for the report, so a permissive Date.parse is good enough here; the real
// importer (phase 5) will be stricter.
function stravaDateKey(s) {
  const t = Date.parse(String(s || '').replace(/,\s*/g, ' '));
  return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

// Plain-text rendering, for copying out of the app.
function inspectionReportText(rep) {
  const L = [];
  L.push(`FILE      ${rep.file.name} (${humanSize(rep.file.size)})`);
  L.push(`DETECTED  ${rep.file.label} [${rep.file.kind}]`);
  if (rep.unsupported) {
    L.push('', 'This file type cannot be inspected yet.');
    if (rep.sniff.entries) {
      L.push('', 'Archive contents:');
      rep.sniff.entries.slice(0, 40).forEach(e => L.push('  ' + e.name));
      if (rep.sniff.entries.length > 40) L.push(`  …and ${rep.sniff.entries.length - 40} more`);
    }
    return L.join('\n');
  }
  if (rep.meta && rep.meta.exportDate) L.push(`EXPORTED  ${rep.meta.exportDate}`);
  L.push(`COVERS    ${rep.range.from || '?'} → ${rep.range.to || '?'}`);
  L.push(`CONTAINS  ${rep.totals.records.toLocaleString()} records, ` +
         `${rep.totals.workouts.toLocaleString()} workouts`);
  L.push(`READ IN   ${(rep.ms / 1000).toFixed(1)}s`);
  L.push('', 'RECORDING SOURCES');
  rep.sources.forEach(s => L.push(`  ${s.name.padEnd(20)} ${s.count.toLocaleString()}`));
  L.push('', 'RECORD TYPES (→ means it feeds a metric the app tracks)');
  rep.types.forEach(t => {
    const name = t.type.replace(/^HK(Quantity|Category)TypeIdentifier/, '').replace(/HKWorkoutActivityType/, '');
    L.push(`  ${name.padEnd(34)} ${String(t.count).padStart(9)}  ` +
           `${t.from || '?'}..${t.to || '?'}` + (t.mapped ? `  → ${t.mapped}` : ''));
  });
  return L.join('\n');
}
