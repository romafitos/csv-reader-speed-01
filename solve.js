// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers, faster: the reference walks the text one character at a
// time and builds every field by concatenation. This reader instead
// slices fields out of the text with indexOf scans, which V8 runs in
// native code:
//  - a whole record whose physical line holds no quote and no stray CR
//    is split in one native split(',') call;
//  - an unquoted field is found by indexOf(',') / indexOf('\n') plus a
//    short check for a stray CR inside that field's own span, then
//    sliced once;
//  - a quoted field is found by indexOf('"') for its closing quote and
//    sliced once when it holds no doubled quote and no line break.
// The slow paths (doubled quotes, line breaks inside quotes, stray CRs,
// quote junk, unterminated quotes) keep the reference's exact error
// order and line counting. No state is kept between calls.
//
// Speed note: every indexOf here is bounded by the field or line it
// searches (a stray-CR check is run on the field's own short slice,
// never on the rest of the text), so no scan runs away down the file.

const COMMA = 0;
const BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Scan of one unquoted field starting at p, keeping `init` as its
  // start. Sets hv (value) and he (how it ended: COMMA/BREAK/END),
  // moves pos past the terminator and counts the line break.
  // Stray CRs are dropped, one stray_cr error each, in order.
  let hv = '';
  let he = END;
  function scanUnquoted(p, init) {
    let v = init;
    for (;;) {
      const ci = text.indexOf(',', p);
      const ni = text.indexOf('\n', p);
      let lim;
      let kind;
      if (ni !== -1 && (ci === -1 || ni < ci)) {
        lim = ni;
        kind = BREAK;
      } else if (ci !== -1) {
        lim = ci;
        kind = COMMA;
      } else {
        lim = n;
        kind = END;
      }
      const seg = text.slice(p, lim);
      const ri = seg.indexOf('\r');
      if (ri === -1) {
        v += seg;
        if (kind === COMMA) pos = lim + 1;
        else if (kind === BREAK) {
          pos = lim + 1;
          line += 1;
        } else pos = lim;
        hv = v;
        he = kind;
        return;
      }
      if (kind === BREAK && ri === seg.length - 1) {
        // The span's only CR is the CRLF terminator at its end.
        v += seg.slice(0, -1);
        pos = lim + 1;
        line += 1;
        hv = v;
        he = BREAK;
        return;
      }
      // Stray CR(s) inside this span: drop each, error each, then
      // re-scan from the delimiter (the delimiter itself still ends
      // the field on the next pass). A CR at the span's end before a
      // LF is the CRLF terminator, not a stray CR: keep it out.
      const stop = kind === BREAK && seg.charCodeAt(seg.length - 1) === 13 ? seg.length - 1 : seg.length;
      let s = '';
      for (let i = 0; i < stop; i++) {
        if (seg.charCodeAt(i) === 13) {
          errors.push({ code: 'stray_cr', line: recLine, row: recRow });
        } else {
          s += seg[i];
        }
      }
      v += s;
      p = lim;
    }
  }

  // Record-local error context, refreshed per record (scanUnquoted
  // reads these for stray_cr errors).
  let recLine = 1;
  let recRow = null;

  // Finish one record: width, header, short/long padding and errors.
  function finish(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  outer: while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;

    // Fast path: one physical line, no quote, no stray CR.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    if (lineEnd > pos) {
      const seg = text.slice(pos, lineEnd);
      if (seg.indexOf('"') === -1) {
        const r = seg.indexOf('\r');
        if (r === -1 || (nl !== -1 && r === seg.length - 1)) {
          const fields = seg.split(',');
          if (r === seg.length - 1) {
            const last = fields.length - 1;
            fields[last] = fields[last].slice(0, -1);
          }
          pos = nl === -1 ? n : nl + 1;
          line += 1;
          if (fields.length === 1 && fields[0] === '') continue;
          finish(fields);
          continue;
        }
      }
    }

    // Slow path: this record holds a quote or a stray CR.
    const fields = [];
    let ended;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (!quoted) {
        scanUnquoted(pos, '');
        fields.push(hv);
        ended = he;
        continue;
      }
      // Quoted field: find the closing quote (not doubled).
      const open = pos;
      let cur = pos + 1;
      let parts = null;
      let close = -1;
      for (;;) {
        const qi = text.indexOf('"', cur);
        if (qi === -1) {
          close = -2;
          break;
        }
        if (text.charCodeAt(qi + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(cur, qi), '"');
          cur = qi + 2;
          continue;
        }
        close = qi;
        break;
      }
      if (close === -2) {
        // Never closes: the quote is literal, the rest is read again
        // as an unquoted field starting just after the opening quote.
        errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
        scanUnquoted(open + 1, '"');
        fields.push(hv);
        ended = he;
        continue;
      }
      let val = parts === null ? text.slice(pos + 1, close) : parts.join('') + text.slice(cur, close);
      if (val.indexOf('\n') !== -1 || val.indexOf('\r') !== -1) {
        // CRLF and lone CR inside quotes each read as one LF, and
        // each counts as one line. In the transformed value every
        // line break is exactly one '\n', so count those.
        val = val.replace(/\r\n?/g, '\n');
        let add = 0;
        let at = -1;
        for (;;) {
          at = val.indexOf('\n', at + 1);
          if (at === -1) break;
          add += 1;
        }
        line += add;
      }
      pos = close + 1;
      if (pos >= n) {
        fields.push(val);
        ended = END;
        continue;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fields.push(val);
        ended = COMMA;
      } else if (c === 10) {
        pos += 1;
        line += 1;
        fields.push(val);
        ended = BREAK;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fields.push(val);
        ended = BREAK;
      } else {
        // Junk after the closing quote, appended as it stands.
        const before = val.length;
        scanUnquoted(pos, val);
        if (hv.length > before) {
          errors.push({ code: 'quote_junk', line: recLine, row: recRow });
        }
        fields.push(hv);
        ended = he;
      }
    } while (ended === COMMA);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue outer;
    finish(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
