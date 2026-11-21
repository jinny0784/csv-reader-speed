// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's reading of {text, header} —
// {columns, rows, errors} under make.fun's broken-row policy — but reads the text in long jumps instead of a
// character at a time. Unquoted fields are located by a single regex scan for the next comma, LF or CR and are
// taken as one slice; quoted fields jump straight to their closing quote with String.indexOf when the content
// is plain, and fall back to a segment walk only when the content doubles a quote or holds a CR or LF.
//
// The policy, matched case for case against the reference:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record (a line of lone CRs leaves none:
//     its stray_cr errors stay, the record does not);
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a quoted field runs to the next undoubled quote: "" inside it is one quote, and each CRLF or lone CR inside
//     it is read as LF; what follows the closing quote, up to the next comma or line break, is appended as it
//     stands (quote_junk, when anything was appended); a quote that never closes is a literal character and the
//     text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the records after it (every record
//     when header is false), each padded with "" (short_row, with fields: its count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF, CRLF and lone CR
//     inside a quoted field counted), row its record's index in rows (null for the header), in the order met.
//
// Pure: nothing is kept from one call to the next.

// How a field ended.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// The next character that can end or interrupt a field, per field kind. lastIndex is set before every exec.
const UNQUOTED_SPECIAL = /[,\r\n]/g;
const QUOTED_SPECIAL = /["\r\n]/g;

/** csv-reader's answer for one case's input {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). Returns {value, ended, added}; `added` counts the characters kept from this call.
  function readUnquoted(value) {
    let parts = null; // field pieces, once a stray CR splits the field; null while it is one clean slice
    let added = 0;
    let seg = pos; // the start of the current clean piece
    UNQUOTED_SPECIAL.lastIndex = pos;
    let m;
    while ((m = UNQUOTED_SPECIAL.exec(text)) !== null) {
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        pos = i + 1;
        if (parts !== null) {
          parts.push(text.slice(seg, i));
          return { value: value + parts.join(''), ended: COMMA, added: added + (i - seg) };
        }
        return { value: value + text.slice(seg, i), ended: COMMA, added: i - seg };
      }
      if (c === '\n' || text[i + 1] === '\n') {
        // An LF, or a CR that an LF follows: the record ends.
        pos = i + (c === '\n' ? 1 : 2);
        line += 1;
        if (parts !== null) {
          parts.push(text.slice(seg, i));
          return { value: value + parts.join(''), ended: LINE_BREAK, added: added + (i - seg) };
        }
        return { value: value + text.slice(seg, i), ended: LINE_BREAK, added: i - seg };
      }
      // A CR no LF follows: dropped, and the field reads on.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (parts === null) parts = [];
      parts.push(text.slice(seg, i));
      added += i - seg;
      pos = i + 1;
      seg = pos;
      UNQUOTED_SPECIAL.lastIndex = pos;
    }
    pos = n;
    if (parts !== null) {
      parts.push(text.slice(seg, n));
      return { value: value + parts.join(''), ended: END, added: added + (n - seg) };
    }
    return { value: value + text.slice(seg, n), ended: END, added: n - seg };
  }

  // What follows a quoted field's closing quote (pos is just past it): the field ends at a comma, a line break
  // or the end of the text; anything else is appended as it stands and is quote_junk when it adds characters.
  function afterClose(value) {
    if (pos >= n) return { value, ended: END };
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // A quote that never closes: it is a literal character, and the text after it is read again as unquoted.
  function unterminated(open) {
    errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
    pos = open + 1;
    return readUnquoted('"');
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const close = text.indexOf('"', open + 1);
    if (close === -1) return unterminated(open);
    if (text[close + 1] !== '"') {
      // The next quote closes the field. When the content holds no CR and no LF it is one plain slice.
      const value = text.slice(open + 1, close);
      if (!value.includes('\r') && !value.includes('\n')) {
        pos = close + 1;
        return afterClose(value);
      }
    }
    // The general walk: content pieces between doubled quotes and CRs, each CRLF or lone CR read as one LF and
    // each LF counted. Line moves are tallied apart and committed only when the field really closes, so an
    // unterminated field leaves the line count where it was when the field opened.
    const parts = [];
    let seg = open + 1;
    let delta = 0;
    QUOTED_SPECIAL.lastIndex = seg;
    let m;
    while ((m = QUOTED_SPECIAL.exec(text)) !== null) {
      const i = m.index;
      const c = m[0];
      if (c === '"') {
        if (text[i + 1] === '"') {
          parts.push(text.slice(seg, i), '"');
          seg = i + 2;
          QUOTED_SPECIAL.lastIndex = seg;
          continue;
        }
        parts.push(text.slice(seg, i));
        line += delta;
        pos = i + 1;
        return afterClose(parts.join(''));
      }
      if (c === '\n') {
        delta += 1; // an LF inside quotes stays an LF in the value; only the tally moves
        continue;
      }
      // A CR inside quotes, with or without an LF after it, is read as one LF.
      parts.push(text.slice(seg, i), '\n');
      delta += 1;
      seg = text[i + 1] === '\n' ? i + 2 : i + 1;
      QUOTED_SPECIAL.lastIndex = seg;
    }
    return unterminated(open);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text[pos] === '"';
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
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
