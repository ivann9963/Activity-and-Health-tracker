// === ZIP READER (zero dependencies) ===
// Apple hands you `export.zip`, and asking the user to unzip a 1GB archive by hand
// before they can use the app is a bad first impression. Browsers ship everything
// needed to read a ZIP without a library: DecompressionStream('deflate-raw') does the
// actual inflating, and we only have to walk the ZIP's own directory structure.
//
// Crucially this never loads the whole archive into memory. We read the few hundred
// bytes of the central directory via Blob.slice(), then hand a STREAM of just the
// entry we want to the decompressor. A multi-gigabyte export stays at a few MB of RAM.

const ZIP_EOCD_SIG   = 0x06054b50;
const ZIP_EOCD64_SIG = 0x06064b50;
const ZIP_CDIR_SIG   = 0x02014b50;
const ZIP_LOCAL_SIG  = 0x04034b50;

function sliceBuffer(blob, start, end) {
  return blob.slice(start, end).arrayBuffer().then(b => new DataView(b));
}

// The End Of Central Directory record lives in the last 64KB, after a variable-length
// comment, so it has to be found by scanning backwards for its signature.
function findEOCD(blob) {
  const tailLen = Math.min(blob.size, 65557); // max comment (65535) + EOCD header (22)
  return sliceBuffer(blob, blob.size - tailLen, blob.size).then(view => {
    for (let i = view.byteLength - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === ZIP_EOCD_SIG) {
        return {
          entryCount: view.getUint16(i + 10, true),
          cdirSize:   view.getUint32(i + 12, true),
          cdirOffset: view.getUint32(i + 16, true),
          tailStart:  blob.size - tailLen,
          eocdAt:     i,
          view
        };
      }
    }
    throw new Error('Not a ZIP file (no end-of-central-directory record found)');
  });
}

// ZIP64: when an archive exceeds 4GB or 65535 entries, the 32-bit fields above are
// filled with 0xFFFFFFFF and the real values live in a separate ZIP64 record. Apple
// exports from a long-owned phone can genuinely get there.
function resolveZip64(blob, eocd) {
  const needs64 = eocd.cdirOffset === 0xFFFFFFFF || eocd.cdirSize === 0xFFFFFFFF ||
                  eocd.entryCount === 0xFFFF;
  if (!needs64) return Promise.resolve(eocd);
  // The ZIP64 locator sits immediately before the EOCD and points at the ZIP64 EOCD.
  const locAt = eocd.eocdAt - 20;
  if (locAt < 0 || eocd.view.getUint32(locAt, true) !== 0x07064b50) {
    throw new Error('ZIP64 archive is missing its locator record');
  }
  const z64Offset = Number(eocd.view.getBigUint64(locAt + 8, true));
  return sliceBuffer(blob, z64Offset, z64Offset + 56).then(v => {
    if (v.getUint32(0, true) !== ZIP_EOCD64_SIG) throw new Error('Bad ZIP64 record');
    return { ...eocd,
      entryCount: Number(v.getBigUint64(32, true)),
      cdirSize:   Number(v.getBigUint64(40, true)),
      cdirOffset: Number(v.getBigUint64(48, true)) };
  });
}

// A ZIP64 extra field replaces whichever of the size/offset values were maxed out,
// in a fixed order and only for those that were.
function readZip64Extra(view, start, len, entry) {
  let p = start;
  const end = start + len;
  while (p + 4 <= end) {
    const tag = view.getUint16(p, true), size = view.getUint16(p + 2, true);
    if (tag === 0x0001) {
      let q = p + 4;
      if (entry.uncompressedSize === 0xFFFFFFFF) { entry.uncompressedSize = Number(view.getBigUint64(q, true)); q += 8; }
      if (entry.compressedSize   === 0xFFFFFFFF) { entry.compressedSize   = Number(view.getBigUint64(q, true)); q += 8; }
      if (entry.localOffset      === 0xFFFFFFFF) { entry.localOffset      = Number(view.getBigUint64(q, true)); q += 8; }
      return;
    }
    p += 4 + size;
  }
}

// List every file in the archive, without reading any of their contents.
function zipEntries(blob) {
  return findEOCD(blob)
    .then(eocd => resolveZip64(blob, eocd))
    .then(eocd => sliceBuffer(blob, eocd.cdirOffset, eocd.cdirOffset + eocd.cdirSize)
      .then(view => {
        const entries = [];
        let p = 0;
        const dec = new TextDecoder();
        while (p + 46 <= view.byteLength && view.getUint32(p, true) === ZIP_CDIR_SIG) {
          const nameLen  = view.getUint16(p + 28, true);
          const extraLen = view.getUint16(p + 30, true);
          const cmtLen   = view.getUint16(p + 32, true);
          const entry = {
            name: dec.decode(new Uint8Array(view.buffer, view.byteOffset + p + 46, nameLen)),
            method: view.getUint16(p + 10, true),
            compressedSize:   view.getUint32(p + 20, true),
            uncompressedSize: view.getUint32(p + 24, true),
            localOffset:      view.getUint32(p + 42, true)
          };
          if (extraLen) readZip64Extra(view, p + 46 + nameLen, extraLen, entry);
          entry.isDir = entry.name.endsWith('/');
          if (!entry.isDir) entries.push(entry);
          p += 46 + nameLen + extraLen + cmtLen;
        }
        return entries;
      }));
}

// Where an entry's compressed bytes actually begin. The central directory records the
// offset of the LOCAL header, whose name and extra fields may differ in length from
// the central copy, so the local header has to be read to find the data.
function entryDataStart(blob, entry) {
  return sliceBuffer(blob, entry.localOffset, entry.localOffset + 30).then(v => {
    if (v.getUint32(0, true) !== ZIP_LOCAL_SIG) {
      throw new Error('Corrupt ZIP: bad local header for ' + entry.name);
    }
    return entry.localOffset + 30 + v.getUint16(26, true) + v.getUint16(28, true);
  });
}

// A ReadableStream of an entry's decompressed bytes. Method 8 is deflate (the norm);
// method 0 is stored, where the bytes are already plain.
function zipEntryStream(blob, entry) {
  return entryDataStart(blob, entry).then(start => {
    const raw = blob.slice(start, start + entry.compressedSize).stream();
    if (entry.method === 0) return raw;
    if (entry.method === 8) return raw.pipeThrough(new DecompressionStream('deflate-raw'));
    throw new Error('Unsupported ZIP compression method ' + entry.method + ' for ' + entry.name);
  });
}

// Convenience for small entries only (manifests, CSVs) — never for export.xml.
function zipEntryText(blob, entry) {
  return zipEntryStream(blob, entry)
    .then(s => new Response(s).text());
}
