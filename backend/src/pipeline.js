const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');
const { CsvParseTransform } = require('./streams/CsvParseTransform');
const { MappingTransform } = require('./streams/MappingTransform');
const { SandboxTransform } = require('./streams/SandboxTransform');
const config = require('./config');

const FAILED_FLUSH_SIZE = 500;

/**
 * Execute the streaming ETL pipeline for one upload file.
 *
 * fs.ReadStream → CsvParseTransform → MappingTransform
 *   → [SandboxTransform]  (optional user JS)
 *   → batched ingest sink (records every `batchSize`, failed rows separately)
 *
 * Never loads the file (or any large buffer) fully into memory: the
 * only in-memory state is one bounded batch plus one failed-row batch.
 *
 * @param {object} opts
 * @param {string} opts.filePath   absolute path to the CSV on disk
 * @param {object} opts.mapping    { sourceCol: { destField, type, required } }
 * @param {object} [opts.transform] { code, field } sandboxed per-row transform
 * @param {number} [opts.batchSize] records per persisted batch
 * @param {function} [opts.onBatch]  async (rows) => void  — persisted records
 * @param {function} [opts.onFailed] async (rows) => void  — failed row objects
 * @param {function} [opts.onProgress] called with partial metrics
 * @returns {Promise<{rowsProcessed, rowsFailed, insertedCount, batches, elapsedMs, rowsPerSec, peakRssMB, sandboxEngine}>}
 */
async function runPipeline({ filePath, mapping, transform, batchSize, onBatch, onFailed, onProgress }) {
  const startedAt = process.hrtime.bigint();
  const effectiveBatchSize = Math.max(1, batchSize || config.batchSize);
  const metrics = { rowsProcessed: 0, rowsFailed: 0, insertedCount: 0, batches: 0, peakRssMB: 0 };

  const parser = new CsvParseTransform();
  const mapper = new MappingTransform(mapping || {});

  parser.once('header', (cols) => {
    mapper.setColumns(cols);
  });

  let sandbox = null;
  if (transform && transform.code) {
    sandbox = new SandboxTransform({
      code: transform.code,
      fields: transform.field ? [transform.field] : null,
      timeoutMs: transform.timeoutMs,
    });
  }

  // Progress sampling: emit partial metrics at most every 500ms and track
  // peak RSS for the memory audit trail.
  let lastEmit = 0;
  const maybeEmit = (force = false) => {
    const now = Date.now();
    if (force || now - lastEmit >= 500) {
      lastEmit = now;
      metrics.peakRssMB = Math.max(metrics.peakRssMB, process.memoryUsage().rss / 1024 / 1024);
      if (onProgress) onProgress({ ...metrics });
    }
  };

  const sink = new Writable({
    objectMode: true,
    highWaterMark: 16,
    write(row, _enc, cb) {
      const finish = (err) => {
        maybeEmit();
        cb(err);
      };
      if (row && row.__error) {
        metrics.rowsFailed += 1;
        this.failed.push(row);
        if (this.failed.length >= FAILED_FLUSH_SIZE) {
          const batch = this.failed;
          this.failed = [];
          Promise.resolve(onFailed ? onFailed(batch) : undefined).then(() => finish(), finish);
        } else {
          finish();
        }
        return;
      }
      metrics.rowsProcessed += 1;
      this.batch.push(row);
      if (this.batch.length >= effectiveBatchSize) {
        const batch = this.batch;
        this.batch = [];
        Promise.resolve(onBatch ? onBatch(batch) : undefined)
          .then(() => {
            metrics.insertedCount += batch.length;
            metrics.batches += 1;
            finish();
          }, finish);
      } else {
        finish();
      }
    },
    final(cb) {
      const flush = [];
      if (this.batch.length > 0) {
        const batch = this.batch;
        this.batch = [];
        flush.push(
          Promise.resolve(onBatch ? onBatch(batch) : undefined).then(() => {
            metrics.insertedCount += batch.length;
            metrics.batches += 1;
          })
        );
      }
      if (this.failed.length > 0) {
        const batch = this.failed;
        this.failed = [];
        flush.push(Promise.resolve(onFailed ? onFailed(batch) : undefined));
      }
      Promise.all(flush).then(() => cb(), cb);
    },
  });
  sink.batch = [];
  sink.failed = [];

  const stages = [fs.createReadStream(filePath, { encoding: 'utf8' }), parser, mapper];
  if (sandbox) stages.push(sandbox);
  stages.push(sink);
  await pipeline(...stages);

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  maybeEmit(true);
  return {
    rowsProcessed: metrics.rowsProcessed,
    rowsFailed: metrics.rowsFailed,
    insertedCount: metrics.insertedCount,
    batches: metrics.batches,
    elapsedMs: Math.round(elapsedMs),
    rowsPerSec: elapsedMs > 0 ? Math.round((metrics.rowsProcessed / elapsedMs) * 1000) : 0,
    peakRssMB: Math.round(metrics.peakRssMB * 10) / 10,
    sandboxEngine: sandbox ? sandbox.engine : null,
  };
}

module.exports = { runPipeline };
