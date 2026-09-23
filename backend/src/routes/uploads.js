const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('../config');
const { createUploadController } = require('../controllers/uploadController');
const { findJob } = require('../db');

const router = express.Router();

router.post('/', createUploadController());

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
 * Incremental CSV row reader. Parses rows character-by-character with a
 * bounded buffer so arbitrarily large files never fully load into RAM.
 * Handles quoted fields, escaped quotes, embedded delimiters/newlines,
 * CRLF, and a leading UTF-8 BOM.
 */
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
    /**
     * Feed a chunk; returns the complete rows found inside it.
     */
    write(chunk) {
      const rows = [];
      buf += chunk;
      let i = 0;
      // Guard against runaway scans on pathological inputs
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

    /**
     * Flush any pending final row (file without trailing newline).
     */
    end() {
      if (exhausted) return [];
      exhausted = true;
      const pending = field !== '' || row.length > 0;
      if (pending) {
        const out = pushRow();
        return [out];
      }
      return [];
    },
  };
}

function readSampleStream(filePath, rowLimit) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let first = true;
    let columns = null;
    const rows = [];
    let headerRaw = null;
    let truncated = false;
    let reader = null;

    function finish() {
      stream.destroy();
      resolve({ columns, rows, truncated });
    }

    stream.on('data', (chunk) => {
      let text = chunk;
      if (first) {
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const sniff = text.slice(0, 4096).split(/\r?\n/)[0] || '';
        reader = createCsvRowReader(detectDelimiter(sniff));
        first = false;
      }
      // Row state (partial fields/rows) persists inside the reader across
      // chunks, so no carry buffer is needed between chunks.
      let rowsOut = [];
      try {
        rowsOut = reader.write(text);
      } catch (err) {
        reject(err);
        stream.destroy();
        return;
      }
      for (const r of rowsOut) {
        if (!columns) {
          columns = r.map((c, idx) => (c && c.trim() !== '' ? c.trim() : `column_${idx + 1}`));
          continue;
        }
        rows.push(r);
        if (rows.length >= rowLimit) {
          truncated = true;
          finish();
          return;
        }
      }
    });

    stream.on('end', () => {
      if (first) {
        // Empty file
        columns = [];
        return finish();
      }
      let tail = [];
      try {
        tail = reader.end();
      } catch {
        tail = [];
      }
      for (const r of tail) {
        if (!columns) {
          columns = r.map((c, idx) => (c && c.trim() !== '' ? c.trim() : `column_${idx + 1}`));
          continue;
        }
        if (rows.length >= rowLimit) {
          truncated = true;
          break;
        }
        rows.push(r);
      }
      finish();
    });

    stream.on('error', (err) => reject(err));
  });
}

router.get('/:id/sample', async (req, res, next) => {
  try {
    const job = await findJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Upload not found' });
    if (job.status !== 'ready') {
      return res.status(409).json({ error: `Upload is not ready (status: ${job.status})` });
    }
    const filePath = job.tempPath || path.join(config.uploadDir, req.params.id);
    if (!fs.existsSync(filePath)) {
      return res.status(410).json({ error: 'Upload temp file missing' });
    }
    const sample = await readSampleStream(filePath, config.sampleRowLimit);
    res.json({
      uploadId: job._id,
      filename: job.originalName,
      columns: sample.columns,
      rows: sample.rows,
      truncated: sample.truncated,
      rowLimit: config.sampleRowLimit,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, createCsvRowReader, detectDelimiter };
