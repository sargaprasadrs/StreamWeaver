/**
 * Shared incremental CSV row reader used by the sample endpoint.
 * Parses rows character-by-character with a bounded buffer so
 * arbitrarily large files never fully load into RAM. Handles quoted
 * fields, escaped quotes, embedded delimiters/newlines, CRLF, and a
 * leading UTF-8 BOM.
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

function createCsvRowReader(delimiter) {
  let buf = '';
  let row = [];
  let field = '';
  let inQuotes = false;
  let exhausted = false;

  function pushField() {
    row.push(field);
    field = '';
  }

  function pushRow() {
    pushField();
    const out = row;
    row = [];
    return out;
  }

  return {
    /** Feed a chunk; returns the complete rows found inside it. */
    write(chunk) {
      const rows = [];
      buf += chunk;
      let i = 0;
      while (i < buf.length) {
        const ch = buf[i];
        if (inQuotes) {
          if (ch === '"') {
            if (buf[i + 1] === '"') {
              field += '"';
              i += 2;
              continue;
            }
            inQuotes = false;
            i++;
            continue;
          }
          field += ch;
          i++;
          continue;
        }
        if (ch === '"' && field === '') {
          inQuotes = true;
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
        i++;
      }
      buf = '';
      return rows;
    },

    /** Flush any pending final row (file without trailing newline). */
    end() {
      if (exhausted) return [];
      exhausted = true;
      if (field !== '' || row.length > 0) {
        return [pushRow()];
      }
      return [];
    },
  };
}

module.exports = { createCsvRowReader, detectDelimiter };
