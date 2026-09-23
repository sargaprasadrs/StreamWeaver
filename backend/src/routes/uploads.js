const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('../config');
const { createUploadController } = require('../controllers/uploadController');
const { findJob, updateJob } = require('../db');
const { runPipeline } = require('../pipeline');
const { validateMapping } = require('../validation');
const { createCsvRowReader, detectDelimiter } = require('../csvReader');

const router = express.Router();

router.post('/', createUploadController());

/**
 * Streamed read of the CSV header + first `rowLimit` rows.
 * The buffer stays bounded by the longest row, never by file size.
 */
function readSampleStream(filePath, rowLimit) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let first = true;
    let columns = null;
    const rows = [];
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
      let rowsOut;
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

/**
 * PUT /api/uploads/:id/mapping — validate and persist the column mapping.
 */
router.put('/:id/mapping', async (req, res, next) => {
  try {
    const job = await findJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Upload not found' });

    const mapping = req.body && req.body.mapping;
    const validation = validateMapping(mapping);
    if (!validation.valid) {
      return res.status(422).json({ error: 'Mapping validation failed', details: validation.errors });
    }

    await updateJob(req.params.id, { mapping, mappingUpdatedAt: new Date().toISOString() });
    res.json({ uploadId: req.params.id, mapping, status: 'saved' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/uploads/:id/run — execute the streaming ETL pipeline.
 */
router.post('/:id/run', async (req, res, next) => {
  try {
    const job = await findJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Upload not found' });
    if (!job.mapping || Object.keys(job.mapping).length === 0) {
      return res.status(409).json({ error: 'No mapping saved for this upload' });
    }

    const filePath = job.tempPath || path.join(config.uploadDir, `${req.params.id}.csv`);
    if (!fs.existsSync(filePath)) {
      return res.status(410).json({ error: 'Upload temp file missing' });
    }

    await updateJob(req.params.id, { status: 'processing', startedAt: new Date().toISOString() });

    const result = await runPipeline({
      filePath,
      mapping: job.mapping,
      onProgress: (m) => {
        if (req.body && req.body.stream === false) return;
        // Progress goes to the WebSocket broker in week 3; for now we
        // surface partial metrics through the job record.
        updateJob(req.params.id, {
          rowsProcessed: m.rowsProcessed,
          rowsFailed: m.rowsFailed,
        }).catch(() => {});
      },
    });

    const finishedAt = new Date().toISOString();
    await updateJob(req.params.id, {
      status: 'completed',
      rowsProcessed: result.rowsProcessed,
      rowsFailed: result.rowsFailed,
      peakRssMB: result.peakRssMB,
      finishedAt,
    });

    res.json({
      uploadId: req.params.id,
      status: 'completed',
      ...result,
    });
  } catch (err) {
    await updateJob(req.params.id, { status: 'failed', finishedAt: new Date().toISOString() }).catch(() => {});
    next(err);
  }
});

module.exports = { router, readSampleStream };
