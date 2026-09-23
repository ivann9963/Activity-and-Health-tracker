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
    // A backup is inspected like anything else: before restoring one it is worth
    // seeing when it was made and how much it holds, especially when deciding
    // whether an older file is still the one you want.
    if (sniff.kind === 'app-backup') {
      return readBackupFile(file)
        .then(backup => ({ ...base, ...summariseBackup(backup), ms: Date.now() - startedAt }))
        .catch(err => ({ ...base, unsupported: true, error: err.message,
                         ms: Date.now() - startedAt }));
    }
    if (sniff.kind === 'fitbit-zip') {
      return inspectTakeout(file, sniff.entries)
        .then(res => ({ ...base, ...res, ms: Date.now() - startedAt }));
    }
    if (sniff.kind === 'strava-csv' || sniff.kind === 'strava-zip') {
      const textOf = sniff.kind === 'strava-zip'
        ? zipEntryText(file, sniff.entry) : file.text();
      return textOf
        .then(text => summariseStrava(text, sniff.kind === 'strava-zip' ? sniff.entries : null))
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

function summariseBackup(backup) {
  const stores = backup.stores || {};
  const counts = backup.counts || {};
  const dates = (stores.sessions || []).map(r => r.localDate)
    .concat((stores.daily || []).map(r => r.localDate))
    .filter(Boolean)
    .sort();

  return {
    meta: { exportDate: backup.createdAt
      ? new Date(backup.createdAt).toISOString().slice(0, 19).replace('T', ' ') : null },
    totals: { records: counts.daily || (stores.daily || []).length,
              workouts: counts.sessions || (stores.sessions || []).length, bytes: 0 },
    range: { from: dates[0] || null, to: dates[dates.length - 1] || null },
    sources: [{ name: 'Your own backup', count: (stores.sessions || []).length }],
    types: Object.entries(stores).map(([name, rows]) => ({
      type: name, count: (rows || []).length, from: null, to: null,
      sources: [], units: [], mapped: 'restored'
    })).sort((a, b) => b.count - a.count),
    isBackup: true
  };
}

// Read with the importer's own CSV reader, so the report cannot promise a workout the
// import then drops, or a date the import places on a different day.
function summariseStrava(text, entries) {
  const parsed = readStravaActivities(text);
  const byType = Object.create(null);
  let from = null, to = null, withFile = 0, withDistance = 0;
  const names = entries ? new Set(entries.map(e => e.name.replace(/^.*?(activities\/)/, '$1'))) : null;

  for (const a of parsed.activities) {
    const t = a.rawActivity || 'Unknown';
    const d = localDateOf(a.start, fallbackOffset(a.start));
    const b = byType[t] || (byType[t] = { count: 0, from: null, to: null });
    b.count++;
    if (!b.from || d < b.from) b.from = d;
    if (!b.to || d > b.to) b.to = d;
    if (!from || d < from) from = d;
    if (!to || d > to) to = d;
    if (names && a.filename && names.has(a.filename)) withFile++;
    if (a.distanceM != null) withDistance++;
  }
  const n = parsed.activities.length;
  const sources = [{ name: 'Strava', count: n }];
  return {
    totals: { records: 0, workouts: n, bytes: text.length },
    range: { from, to },
    sources,
    strava: { withFile, withDistance, distanceUnitKnown: parsed.distanceUnitKnown,
              notes: parsed.notes, archive: !!entries },
    types: Object.entries(byType).sort((a, b) => b[1].count - a[1].count).map(([type, t]) => ({
      type: 'Activity:' + type, count: t.count, from: t.from, to: t.to,
      sources, units: [],
      mapped: 'session:' + canonicalActivity('strava', type)
    }))
  };
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
  L.push(rep.takeout
    ? `CONTAINS  ${rep.totals.records.toLocaleString()} data files`
    : `CONTAINS  ${rep.totals.records.toLocaleString()} records, ` +
      `${rep.totals.workouts.toLocaleString()} workouts`);
  if (rep.strava) {
    L.push(`FILES     ${rep.strava.archive ? rep.strava.withFile.toLocaleString() +
           ' workouts have a recording file' : 'activities.csv only — no recording files'}`);
    L.push(`DISTANCE  ${rep.strava.distanceUnitKnown
      ? rep.strava.withDistance.toLocaleString() + ' workouts state one, in metres'
      : 'unit not stated in this file — left blank'}`);
    Object.entries(rep.strava.notes || {}).forEach(([k, v]) =>
      L.push(`SKIPPED   ${v.toLocaleString()} × ${k}`));
  }
  L.push(`READ IN   ${(rep.ms / 1000).toFixed(1)}s`);
  L.push('', 'RECORDING SOURCES');
  rep.sources.forEach(s => L.push(`  ${s.name.padEnd(20)} ${s.count.toLocaleString()}`));
  L.push('', 'RECORD TYPES (→ means it feeds a metric the app tracks)');
  rep.types.forEach(t => {
    const name = t.type.replace(/^HK(Quantity|Category)TypeIdentifier/, '').replace(/HKWorkoutActivityType/, '');
    L.push(`  ${name.padEnd(34)} ${String(t.count).padStart(9)}  ` +
           `${t.from || '?'}..${t.to || '?'}` + (t.mapped ? `  → ${t.mapped}` : ''));
    if (t.sample) {
      L.push(`      sample: ${t.sample.file} (${t.sample.format}` +
             (t.sample.count != null ? `, ${t.sample.count} entries` : '') + ')');
      if (t.sample.error) L.push(`      error: ${t.sample.error}`);
      if (t.sample.keys && t.sample.keys.length) L.push(`      keys: ${t.sample.keys.join(', ')}`);
      if (t.sample.example) L.push(`      example: ${JSON.stringify(t.sample.example)}`);
    }
  });
  return L.join('\n');
}
