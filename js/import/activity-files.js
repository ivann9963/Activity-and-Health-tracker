// === WORKOUT FILES: FIT, GPX, TCX ===
// The per-workout files a watch or app writes. Strava's bulk export carries one per
// activity — the file the device originally uploaded — and they hold what its
// activities.csv cannot: the heart-rate trace, and (in a FIT file) the UTC offset the
// watch was set to, which is the only statement of local time anywhere in the archive.
//
// Everything here is a pure function over bytes or text, so it is testable without a
// zip or a browser. Each reader returns the same shape:
//   { samples: [{ ms, bpm }], startMs, endMs, distanceM, offsetMin }
// with any field it could not find left null — never guessed. A sample's bpm may be
// null too: a moment the device recorded without a heart rate.

// --- FIT ------------------------------------------------------------------------------
// Garmin's binary format, used by nearly every watch. Only the handful of fields this
// app stores are decoded; everything else is skipped by its declared size, which is
// what keeps a partial decoder safe against fields it does not know.

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);   // FIT counts seconds from here
const FIT_MSG = { session: 18, record: 20, activity: 34 };

// Invalid-value sentinels per base type, indexed by the low five bits of the type.
// A field holding its sentinel was not recorded, which is not the same as zero.
const FIT_INVALID = { 0: 0xFF, 1: 0x7F, 2: 0xFF, 3: 0x7FFF, 4: 0xFFFF, 5: 0x7FFFFFFF,
                      6: 0xFFFFFFFF, 10: 0, 11: 0, 12: 0, 13: 0xFF };

function readFitValue(view, p, size, baseType, little) {
  const t = baseType & 0x1F;
  let v;
  if (size === 1 && (t === 0 || t === 2 || t === 10 || t === 13)) v = view.getUint8(p);
  else if (size === 1 && t === 1) v = view.getInt8(p);
  else if (size === 2 && (t === 4 || t === 11)) v = view.getUint16(p, little);
  else if (size === 2 && t === 3) v = view.getInt16(p, little);
  else if (size === 4 && (t === 6 || t === 12)) v = view.getUint32(p, little);
  else if (size === 4 && t === 5) v = view.getInt32(p, little);
  else return null;   // arrays, strings, floats: nothing this app reads
  return v === FIT_INVALID[t] ? null : v;
}

function parseFit(buffer) {
  const view = new DataView(buffer);
  const out = { samples: [], startMs: null, endMs: null, distanceM: null, offsetMin: null };
  let pos = 0;

  // A FIT file may be several files chained end to end; each has its own header.
  while (pos + 12 <= view.byteLength) {
    const headerSize = view.getUint8(pos);
    const dataSize = view.getUint32(pos + 4, true);
    const magic = String.fromCharCode(view.getUint8(pos + 8), view.getUint8(pos + 9),
                                      view.getUint8(pos + 10), view.getUint8(pos + 11));
    if (magic !== '.FIT') {
      if (pos === 0) throw new Error('not a FIT file');
      break;
    }
    const end = Math.min(view.byteLength, pos + headerSize + dataSize);
    readFitRecords(view, pos + headerSize, end, out);
    pos = end + 2;   // skip the CRC
  }
  out.samples.sort((a, b) => a.ms - b.ms);
  return out;
}

function readFitRecords(view, p, end, out) {
  const defs = [];
  let lastTs = null;

  while (p < end) {
    const h = view.getUint8(p++);
    let local, compressedTs = null;

    if (h & 0x80) {
      // Compressed timestamp header: five bits of offset from the last full timestamp.
      local = (h >> 5) & 0x03;
      if (lastTs != null) {
        const offset = h & 0x1F;
        let ts = (lastTs & ~0x1F) + offset;
        if (offset < (lastTs & 0x1F)) ts += 0x20;
        compressedTs = lastTs = ts;
      }
    } else if (h & 0x40) {
      // Definition message: says how the data messages of one local type are laid out.
      local = h & 0x0F;
      const little = view.getUint8(p + 1) === 0;
      const global = view.getUint16(p + 2, little);
      const count = view.getUint8(p + 4);
      p += 5;
      const fields = [];
      for (let i = 0; i < count; i++, p += 3) {
        fields.push({ num: view.getUint8(p), size: view.getUint8(p + 1), type: view.getUint8(p + 2) });
      }
      let devBytes = 0;
      if (h & 0x20) {
        const devCount = view.getUint8(p++);
        for (let i = 0; i < devCount; i++, p += 3) devBytes += view.getUint8(p + 1);
      }
      defs[local] = { global, little, fields, devBytes };
      continue;
    } else {
      local = h & 0x0F;
    }

    const def = defs[local];
    if (!def) throw new Error('FIT data message before its definition');
    const values = {};
    for (const f of def.fields) {
      if (p + f.size > end) return;
      values[f.num] = readFitValue(view, p, f.size, f.type, def.little);
      p += f.size;
    }
    p += def.devBytes;

    if (values[253] != null) lastTs = values[253];
    const ts = values[253] != null ? values[253] : compressedTs;
    const ms = ts != null ? FIT_EPOCH_MS + ts * 1000 : null;

    if (def.global === FIT_MSG.record) {
      // A record with no heart rate (strap off, or not yet found) is kept as a reading
      // of nothing: it ends the previous reading's span rather than letting that one
      // claim time nobody measured.
      if (ms != null) out.samples.push({ ms, bpm: values[3] > 0 ? values[3] : null });
    } else if (def.global === FIT_MSG.session) {
      // start_time (2), total_elapsed_time (7, ms), total_distance (9, cm).
      if (values[2] != null && out.startMs == null) out.startMs = FIT_EPOCH_MS + values[2] * 1000;
      if (values[2] != null && values[7] != null) {
        const sessionEnd = FIT_EPOCH_MS + values[2] * 1000 + values[7];
        if (out.endMs == null || sessionEnd > out.endMs) out.endMs = sessionEnd;
      }
      if (values[9] != null) out.distanceM = (out.distanceM || 0) + values[9] / 100;
    } else if (def.global === FIT_MSG.activity) {
      // local_timestamp (5) is the watch's wall clock at `timestamp`; the difference
      // is the UTC offset the workout was actually recorded in.
      if (ts != null && values[5] != null) {
        const offsetMin = Math.round((values[5] - ts) / 60);
        if (Math.abs(offsetMin) <= 14 * 60) out.offsetMin = offsetMin;
      }
    }
  }
}

// --- GPX and TCX ----------------------------------------------------------------------
// XML, but small enough per workout (a few MB at most) that a regex over each point is
// simpler and no less correct than a streaming parser. Times are UTC ('Z') and state
// no offset, so these files cannot say what the local time was.

const GPX_POINT_RE = /<trkpt\b[\s\S]*?<\/trkpt>/g;
const TCX_POINT_RE = /<Trackpoint>[\s\S]*?<\/Trackpoint>/g;

function readTrackPoints(text, pointRe, timeRe, hrRe) {
  const out = { samples: [], startMs: null, endMs: null, distanceM: null, offsetMin: null };
  const points = text.match(pointRe) || [];
  for (const pt of points) {
    const t = timeRe.exec(pt);
    const ms = t ? Date.parse(t[1]) : NaN;
    if (!isFinite(ms)) continue;
    if (out.startMs == null || ms < out.startMs) out.startMs = ms;
    if (out.endMs == null || ms > out.endMs) out.endMs = ms;
    const hr = hrRe.exec(pt);
    const bpm = hr ? Number(hr[1]) : NaN;
    out.samples.push({ ms, bpm: isFinite(bpm) && bpm > 0 ? bpm : null });
  }
  out.samples.sort((a, b) => a.ms - b.ms);
  return out;
}

function parseGpx(text) {
  // The heart-rate element is namespaced differently by every writer: gpxtpx:hr,
  // ns3:hr, or a bare <hr>.
  return readTrackPoints(text, GPX_POINT_RE, /<time>([^<]+)<\/time>/, /<(?:\w+:)?hr>\s*(\d+)/);
}

function parseTcx(text) {
  const out = readTrackPoints(text, TCX_POINT_RE, /<Time>([^<]+)<\/Time>/,
                              /<HeartRateBpm[^>]*>\s*<Value>\s*(\d+)/);
  // A lap's DistanceMeters is the device's own total; summing laps gives the workout.
  let dist = 0, any = false;
  const lapRe = /<Lap\b[\s\S]*?<\/Lap>/g;
  let lap;
  while ((lap = lapRe.exec(text))) {
    // Trackpoints carry a running DistanceMeters of their own; only the lap's, which
    // comes before its <Track>, is a total.
    const m = /<DistanceMeters>([\d.]+)<\/DistanceMeters>/.exec(lap[0].split('<Track>')[0]);
    if (m) { dist += Number(m[1]); any = true; }
  }
  if (any && dist > 0) out.distanceM = dist;
  return out;
}

// Which reader a file name calls for, with its gzip wrapper noted. Strava stores most
// uploads gzipped: 1234.fit.gz, 1234.tcx.gz.
function activityFileFormat(name) {
  const m = /\.(fit|gpx|tcx)(\.gz)?$/i.exec(String(name || ''));
  return m ? { format: m[1].toLowerCase(), gzip: !!m[2] } : null;
}

// Read one workout file's bytes into the common shape.
function parseActivityFile(format, buffer) {
  if (format === 'fit') return parseFit(buffer);
  const text = new TextDecoder().decode(buffer);
  if (format === 'gpx') return parseGpx(text);
  if (format === 'tcx') return parseTcx(text.trimStart());
  throw new Error('unknown workout file format: ' + format);
}

// Heart-rate readings into seconds per band. A reading of null is a moment known to
// have no heart rate; it earns nothing and closes the span before it. A reading is worth the gap to the next
// reading, capped, because a long gap means the strap came off rather than that the
// heart held one rate; the last reading has no successor and is worth nothing.
const ACTIVITY_FILE_HR_GAP_CAP_MS = 5 * 60 * 1000;

function bandsFromSamples(samples) {
  if (!samples || samples.length < 2) return null;
  const bands = {};
  let any = false;
  for (let i = 0; i + 1 < samples.length; i++) {
    if (samples[i].bpm == null) continue;
    const gap = samples[i + 1].ms - samples[i].ms;
    if (!(gap > 0)) continue;
    const floor = hrBandFor(samples[i].bpm);
    bands[floor] = (bands[floor] || 0) + Math.min(gap, ACTIVITY_FILE_HR_GAP_CAP_MS) / 1000;
    any = true;
  }
  return any ? bands : null;
}

if (typeof module !== 'undefined') {
  module.exports = { parseFit, parseGpx, parseTcx, activityFileFormat, parseActivityFile,
                     bandsFromSamples };
}
