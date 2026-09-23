const { Transform } = require('node:stream');

/**
 * Detect a delimiter from a sniff line (first line of the file).
 * Picks the candidate with the most occurrences.
 */
function detectDelimiter(sniffLine) {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const c of candidates) {
    const count = sniffLine.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Incremental CSV tokenizer: feed text chunks, get complete rows back.
 * Maintains partial field/row state across chunks, so chunks may split
 * mid-field, mid-quote, or mid-newline. Handles:
 *  - quoted fields with embedded delimiters and newlines
 *  - escaped quotes ("")
 *  - CRLF and LF line endings
 *  - leading UTF-8 BOM (skipBom option)
 *
 * The buffer stays bounded by the longest single field, never by the
 * whole file, so arbitrarily large inputs are safe.
 */
function createCsvTokenizer({ delimiter = ',', skipBom = false } = {}) {
  let buf = '';
  let field = '';
  let row = [];
  let inQuotes = false;
  let started = false; // any token of the current field seen (for "" vs empty)
  let ended = false;
  let bomPending = skipBom;

  const pushField = () => {
    row.push(field);
    field = '';
    started = false;
  };

  const pushRow = () => {
    pushField();
    const out = row;
    row = [];
    return out;
  };

  return {
    /** Feed a text chunk; returns the complete rows found inside it. */
    write(chunk) {
      if (ended) throw new Error('Tokenizer already ended');
      if (bomPending) {
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
        bomPending = false;
      }
      buf += chunk;
      const rows = [];
      let i = 0;
      const n = buf.length;
      while (i < n) {
        const ch = buf[i];
        if (inQuotes) {
          if (ch === '"') {
            if (buf[i + 1] === '"') {
              field += '"';
              started = true;
              i += 2;
              continue;
            }
            inQuotes = false;
            i++;
            continue;
          }
          field += ch;
          started = true;
          i++;
          continue;
        }
        if (ch === '"' && field === '' && !started) {
          inQuotes = true;
          started = true;
          i++;
          continue;
        }
        if (ch === delimiter) {
          pushField();
          i++;
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          if (ch === '\r' && buf[i + 1] === '\n') i++;
          rows.push(pushRow());
          i++;
          continue;
        }
        field += ch;
        started = true;
        i++;
      }
      buf = '';
      return rows;
    },

    /** Flush any pending final row (file without trailing newline). */
    end() {
      if (ended) return [];
      ended = true;
      if (field !== '' || row.length > 0 || started) {
        return [pushRow()];
      }
      return [];
    },

    get ended() {
      return ended;
    },
  };
}

/**
 * CsvParseTransform: binary chunks in (as utf8 strings via setEncoding),
 * row arrays out (objectMode). Header handling: the first row is emitted
 * as { header: [...] } on the stream's 'header' event once parsed.
 */
class CsvParseTransform extends Transform {
  /**
   * @param {object} options
   * @param {string} [options.delimiter] fixed delimiter; detected from the
   *   first line when omitted
   * @param {string[]} [options.columns] pre-known header; skips header row
   */
  constructor(options = {}) {
    super({ objectMode: true, highWaterMark: 16 });
    this.columns = options.columns || null;
    this.fixedDelimiter = options.delimiter || null;
    this.tokenizer = null;
    this.byteCarry = Buffer.alloc(0);
    this.headerEmitted = false;
    this.on('header', (cols) => {
      this.columns = cols;
    });
  }

  _transform(chunk, _enc, callback) {
    try {
      // Multi-byte UTF-8 safety: only decode up to the last complete
      // character boundary; hold any incomplete tail bytes back in a
      // bounded carry (never more than 3 bytes).
      const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const raw = this.byteCarry && this.byteCarry.length
        ? Buffer.concat([this.byteCarry, incoming])
        : incoming;
      let boundary = raw.length;
      for (let i = raw.length - 1; i >= Math.max(0, raw.length - 3); i--) {
        const b = raw[i];
        if ((b & 0xc0) === 0x80) continue; // continuation byte: look further back
        let len;
        if ((b & 0x80) === 0) len = 1;
        else if ((b & 0xe0) === 0xc0) len = 2;
        else if ((b & 0xf0) === 0xe0) len = 3;
        else len = 4;
        if (i + len > raw.length) boundary = i; // incomplete character at the tail
        break; // lead byte found; if complete, keep the whole buffer
      }
      if (boundary === raw.length && raw.length >= 3) {
        // All trailing bytes were continuation bytes: a multi-byte
        // character is split across chunks, so cut before the window.
        let allCont = true;
        for (let i = raw.length - 1; i >= raw.length - 3; i--) {
          if ((raw[i] & 0xc0) !== 0x80) {
            allCont = false;
            break;
          }
        }
        if (allCont) boundary = raw.length - 3;
      }
      const text = raw.subarray(0, boundary).toString('utf8');
      this.byteCarry = raw.subarray(boundary);

      if (!this.tokenizer) {
        const sniff = text.slice(0, 4096).split(/\r?\n/)[0] || '';
        this.tokenizer = createCsvTokenizer({
          delimiter: this.fixedDelimiter || detectDelimiter(sniff),
          skipBom: true,
        });
      }

      const rows = this.tokenizer.write(text);
      this._emitRows(rows);
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _flush(callback) {
    try {
      if (this.tokenizer) {
        this._emitRows(this.tokenizer.end());
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }

  _emitRows(rows) {
    for (const row of rows) {
      if (!this.headerEmitted) {
        this.headerEmitted = true;
        this.columns = row.map((c, idx) => (c && c.trim() !== '' ? c.trim() : `column_${idx + 1}`));
        this.emit('header', this.columns);
        continue;
      }
      this.push(row);
    }
  }
}

module.exports = { CsvParseTransform, createCsvTokenizer, detectDelimiter };
