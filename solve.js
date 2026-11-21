// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// {columns, rows, errors} for {text, header}, but reads the text with bulk
// indexOf/slice scans instead of one character at a time.
//
// Semantics (matching csv-reader 1.0.0 byte for byte):
// - a U+FEFF at the very start is dropped;
// - a record ends at LF or CRLF; a line left with no characters is no record;
// - outside quotes a CR not followed by LF is dropped (stray_cr);
// - a field that opens with a quote runs to the next quote that is not doubled,
//   "" inside it is one quote, each CRLF or lone CR inside it is read as LF;
//   what follows its closing quote, up to the next comma or line break, is
//   appended as it stands (quote_junk, when the field ends); a quote that never
//   closes is a literal character, and the text after it is read again as
//   unquoted (unterminated_quote); a quote inside an unquoted field is literal;
// - fields stay strings, never trimmed or converted;
// - columns is the first record when header is true, else null; rows holds the
//   records after it, each padded (short_row) or cut (long_row) to the first
//   record's width; each error is {code, line, row} in the order met.
//
// Speed notes: the delimiter search uses indexOf (native, fast). A CR is never
// searched for with indexOf, because in LF-terminated files the next CR can be
// thousands of characters away and every field would re-scan that stretch;
// instead a CR is found by a short scan bounded by the field's own end.

const COMMA = 44; // ,
const LF = 10; // \n
const CR = 13; // \r
const QUOTE = 34; // "
const BOM = 0xfeff;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === BOM) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // The first CR in [from, to), or -1. Bounded by the field's own end, so it
  // never scans past the field the way indexOf would.
  function firstCr(from, to) {
    for (let i = from; i < to; i++) {
      if (text.charCodeAt(i) === CR) return i;
    }
    return -1;
  }

  // Reads unquoted characters onto `init`, up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field, how it
  // ended (0 comma, 1 line break, 2 end of text) and how many characters were
  // kept (`added`, for the quote_junk check). Mutates pos and line.
  function readUnquoted(init) {
    let added = 0;
    let parts = null;
    let seg = pos;
    for (;;) {
      const cIdx = text.indexOf(',', pos);
      const lIdx = text.indexOf('\n', pos);
      let d = -1;
      let kind = 0;
      if (cIdx !== -1) { d = cIdx; kind = 0; }
      if (lIdx !== -1 && (d === -1 || lIdx < d)) { d = lIdx; kind = 1; }
      if (d === -1) {
        // To the end of the text: only stray CRs can still appear in it.
        const cr = firstCr(seg, n);
        if (cr === -1) {
          const tail = text.slice(seg);
          added += tail.length;
          pos = n;
          return { value: parts === null ? init + tail : init + parts.join('') + tail, ended: 2, added };
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        const tail = text.slice(seg, cr);
        added += tail.length;
        if (parts === null) parts = [];
        parts.push(tail);
        pos = cr + 1;
        seg = pos;
        continue;
      }
      // The first CR in [seg, d), or -1. Scanned inline (not a call) because
      // this runs once per field: a CR here is always a stray one, since a
      // CRLF's CR would sit at d - 1 and kind would be a line break.
      let cr = -1;
      for (let i = seg; i < d; i++) {
        if (text.charCodeAt(i) === CR) { cr = i; break; }
      }
      if (cr === -1) {
        const tail = text.slice(seg, d);
        added += tail.length;
        if (kind === 0) {
          pos = d + 1;
          return { value: parts === null ? init + tail : init + parts.join('') + tail, ended: 0, added };
        }
        pos = d + 1;
        line += 1;
        return { value: parts === null ? init + tail : init + parts.join('') + tail, ended: 1, added };
      }
      if (kind === 1 && cr === d - 1) {
        // CRLF: the CR sits right before the LF, so the field ends at it.
        const tail = text.slice(seg, cr);
        added += tail.length;
        pos = d + 1;
        line += 1;
        return { value: parts === null ? init + tail : init + parts.join('') + tail, ended: 1, added };
      }
      // A stray CR: dropped, and the field goes on after it.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      const tail = text.slice(seg, cr);
      added += tail.length;
      if (parts === null) parts = [];
      parts.push(tail);
      pos = cr + 1;
      seg = pos;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field and
  // how it ended (0 comma, 1 line break, 2 end of text). Mutates pos and line.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let seg = pos + 1;
    pos = pos + 1;
    let closed = false;
    let value = '';
    while (pos < n) {
      const q = text.indexOf('"', pos);
      const lim = q === -1 ? n : q;
      // The first line break (LF or CR) before the next quote, if any.
      let ni = -1;
      for (let i = pos; i < lim; i++) {
        const c = text.charCodeAt(i);
        if (c === LF || c === CR) { ni = i; break; }
      }
      if (ni !== -1) {
        // A line break inside quotes becomes one LF, and counts a line.
        if (parts === null) parts = [];
        parts.push(text.slice(seg, ni), '\n');
        line += 1;
        pos = (text.charCodeAt(ni) === CR && text.charCodeAt(ni + 1) === LF) ? ni + 2 : ni + 1;
        seg = pos;
        continue;
      }
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === QUOTE) {
        // A doubled quote is one literal quote.
        if (parts === null) parts = [];
        parts.push(text.slice(seg, q), '"');
        pos = q + 2;
        seg = pos;
        continue;
      }
      // The closing quote.
      if (parts === null) value = text.slice(seg, q);
      else { parts.push(text.slice(seg, q)); value = parts.join(''); }
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (pos >= n) return { value, ended: 2 };
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      return { value, ended: 0 };
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      return { value, ended: 1 };
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      return { value, ended: 1 };
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = (header && columns === null) ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended = 0;
    for (;;) {
      if (text.charCodeAt(pos) === QUOTE) {
        quoted = true;
        const field = readQuoted();
        fields.push(field.value);
        ended = field.ended;
      } else {
        quoted = false;
        const field = readUnquoted('');
        fields.push(field.value);
        ended = field.ended;
      }
      if (ended !== 0) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
