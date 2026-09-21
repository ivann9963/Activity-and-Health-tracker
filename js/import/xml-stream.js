// === STREAMING XML TAG SCANNER ===
// A deliberately small, forgiving scanner that walks XML tag by tag without ever
// holding the whole document. DOMParser is not an option here: an Apple Health
// export is routinely 300MB–1GB of XML and parsing it into a DOM tree would exhaust
// the tab's memory long before it finished.
//
// We do not need a real XML parser — the Apple export is machine-generated, flat, and
// we only care about start tags and their attributes. So this recognises exactly what
// that document contains: the prolog, a DOCTYPE with an internal subset, comments,
// and elements with double-quoted attributes.

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlUnescape(s) {
  if (s.indexOf('&') === -1) return s; // overwhelmingly the common case, so short-circuit
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[body] != null ? XML_ENTITIES[body] : whole;
  });
}

const ATTR_RE = /([A-Za-z_:][\w:.\-]*)\s*=\s*"([^"]*)"/g;

function parseAttrs(text) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(text))) attrs[m[1]] = xmlUnescape(m[2]);
  return attrs;
}

// Scans a growing buffer and emits tags. `onTag(name, attrs, kind)` where kind is
// 'open', 'close' or 'self'. Incomplete trailing text is retained for the next chunk.
class XmlTagScanner {
  constructor(onTag) {
    this.onTag = onTag;
    this.buf = '';
  }

  feed(chunk) {
    this.buf += chunk;
    let pos = 0;
    while (true) {
      const lt = this.buf.indexOf('<', pos);
      if (lt === -1) { pos = this.buf.length; break; }

      // Declarations and comments: skipped wholesale, but they can contain '>' so
      // each needs its own terminator. The DOCTYPE in an Apple export carries an
      // internal subset in square brackets full of nested <!ELEMENT> declarations.
      if (this.buf.startsWith('<!--', lt)) {
        const end = this.buf.indexOf('-->', lt + 4);
        if (end === -1) { pos = lt; break; }
        pos = end + 3; continue;
      }
      if (this.buf.startsWith('<!', lt) || this.buf.startsWith('<?', lt)) {
        const bracket = this.buf.indexOf('[', lt);
        const gt = this.buf.indexOf('>', lt);
        if (gt === -1) { pos = lt; break; }
        if (bracket !== -1 && bracket < gt) {
          const close = this.buf.indexOf(']>', bracket);
          if (close === -1) { pos = lt; break; }
          pos = close + 2; continue;
        }
        pos = gt + 1; continue;
      }

      const gt = this.buf.indexOf('>', lt);
      if (gt === -1) { pos = lt; break; } // tag straddles a chunk boundary — wait
      const inner = this.buf.slice(lt + 1, gt);
      pos = gt + 1;

      if (inner[0] === '/') {
        this.onTag(inner.slice(1).trim(), null, 'close');
        continue;
      }
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const sp = body.search(/\s/);
      const name = sp === -1 ? body : body.slice(0, sp);
      const attrs = sp === -1 ? {} : parseAttrs(body.slice(sp));
      this.onTag(name, attrs, selfClosing ? 'self' : 'open');
    }
    // Keep only the unconsumed tail. Without this the buffer would grow to the size
    // of the whole file and defeat the point of streaming.
    this.buf = pos > 0 ? this.buf.slice(pos) : this.buf;
  }

  end() { this.buf = ''; }
}

// Drive a scanner from a ReadableStream of bytes, decoding incrementally so multi-byte
// UTF-8 characters split across chunk boundaries survive intact.
function scanXmlStream(stream, onTag, onProgress) {
  const scanner = new XmlTagScanner(onTag);
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let bytes = 0;

  function pump() {
    return reader.read().then(({ done, value }) => {
      if (done) {
        scanner.feed(decoder.decode());
        scanner.end();
        return bytes;
      }
      bytes += value.byteLength;
      scanner.feed(decoder.decode(value, { stream: true }));
      if (onProgress) onProgress(bytes);
      return pump();
    });
  }
  return pump();
}

if (typeof module !== 'undefined') {
  module.exports = { XmlTagScanner, xmlUnescape, parseAttrs };
}
