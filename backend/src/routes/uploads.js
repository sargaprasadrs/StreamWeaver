const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('../config');
const { createUploadController } = require('../controllers/uploadController');
const { findJob, updateJob } = require('../db');
const { runPipeline } = require('../pipeline');
const { validateMapping } = require('../validation');
const { createCsvRowReader, detectDelimiter } = require('../csvReader');
const { IngestSession, listFailedRows } = require('../services/ingestService');

const router = express.Router();

router.post('/', createUploadController());

/** GET /api/uploads/:id — lightweight job status (no temp path). */
router.get('/:id', async (req, res, next) => {
  try {
    const job = await findJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Upload not found' });
    res.json({
      uploadId: job._id,
      originalName: job.originalName,
      status: job.status,
      sizeBytes: job.sizeBytes,
      rowsProcessed: job.rowsProcessed || 0,
      rowsFailed: job.rowsFailed || 0,
      insertedCount: job.insertedCount || 0,
      peakRssMB: job.peakRssMB,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
  } catch (err) {
    next(err);
  }
});

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
 * PUT /api/uploads/:id/mapping — validate and persist the column mapping
 * (and optional sandboxed transform snippet).
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

    const updates = { mapping, mappingUpdatedAt: new Date().toISOString() };
    const transform = req.body && req.body.transform;
    if (transform !== undefined) {
      if (transform && (typeof transform.code !== 'string' || transform.code.trim() === '')) {
        return res.status(422).json({ error: 'Transform requires a non-empty code string' });
      }
      updates.transform = transform || null;
    }

    await updateJob(req.params.id, updates);
    res.json({ uploadId: req.params.id, mapping, transform: updates.transform, status: 'saved' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/uploads/:id/run — execute the streaming ETL pipeline.
 *
 * Records are persisted in `batchSize` batches; bad rows go to the
 * failed-rows store; live progress is pushed to the WebSocket broker
 * while the run is in flight.
 */
router.post('/:id/run', async (req, res, next) => {
  const uploadId = req.params.id;
  try {
    const job = await findJob(uploadId);
    if (!job) return res.status(404).json({ error: 'Upload not found' });
    if (!job.mapping || Object.keys(job.mapping).length === 0) {
      return res.status(409).json({ error: 'No mapping saved for this upload' });
    }

    const filePath = job.tempPath || path.join(config.uploadDir, `${uploadId}.csv`);
    if (!fs.existsSync(filePath)) {
      return res.status(410).json({ error: 'Upload temp file missing' });
    }

    const transform = (req.body && req.body.transform) || job.transform || null;
    const broker = req.app.locals.progressBroker;
    const session = new IngestSession(uploadId);

    await updateJob(uploadId, { status: 'processing', startedAt: new Date().toISOString() });
    if (broker) {
      broker.emitProgress(uploadId, { status: 'processing', percent: 0 }, { force: true });
    }

    const result = await runPipeline({
      filePath,
      mapping: job.mapping,
      transform,
      batchSize: config.batchSize,
      onBatch: (rows) => session.writeBatch(rows),
      onFailed: (rows) => session.writeFailed(rows),
      onProgress: (m) => {
        updateJob(uploadId, { rowsProcessed: m.rowsProcessed, rowsFailed: m.rowsFailed, insertedCount: m.insertedCount }).catch(() => {});
        if (broker) {
          broker.emitProgress(uploadId, {
            status: 'processing',
            rowsProcessed: m.rowsProcessed,
            rowsFailed: m.rowsFailed,
            insertedCount: m.insertedCount,
            rowsPerSec: m.rowsPerSec,
            peakRssMB: m.peakRssMB,
          });
        }
      },
    });
    await session.close();

    const finishedAt = new Date().toISOString();
    await updateJob(uploadId, {
      status: 'completed',
      rowsProcessed: result.rowsProcessed,
      rowsFailed: result.rowsFailed,
      insertedCount: result.insertedCount,
      peakRssMB: result.peakRssMB,
      finishedAt,
    });

    const payload = { uploadId, status: 'completed', ...result };
    if (broker) broker.emitTerminal(uploadId, payload);

    res.json(payload);
  } catch (err) {
    await updateJob(uploadId, { status: 'failed', finishedAt: new Date().toISOString() }).catch(() => {});
    const broker = req.app.locals.progressBroker;
    if (broker) broker.emitTerminal(uploadId, { status: 'failed', error: err.message });
    next(err);
  }
});

/**
 * GET /api/uploads/:id/errors — convenience alias for the failed-rows feed.
 */
router.get('/:id/errors', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 50;
    const result = await listFailedRows(req.params.id, { page, pageSize });
    res.json({ uploadId: req.params.id, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, readSampleStream };
