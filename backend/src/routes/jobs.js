const express = require('express');
const { findJob } = require('../db');
const { listFailedRows } = require('../services/ingestService');

const router = express.Router();

function sanitizeJob(job) {
  if (!job) return job;
  const { tempPath, ...rest } = job;
  return rest;
}

/** GET /api/jobs/:id — current job status + metrics. */
router.get('/:id', async (req, res, next) => {
  try {
    const job = await findJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(sanitizeJob(job));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/jobs/:id/errors?page=&pageSize=
 * Paginated failed rows for the error-handling UI.
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

module.exports = router;
