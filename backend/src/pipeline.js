const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');
const { CsvParseTransform } = require('./streams/CsvParseTransform');
const { MappingTransform } = require('./streams/MappingTransform');

/**
 * Execute the streaming ETL pipeline for one upload file.
 * fs.ReadStream → CsvParseTransform → MappingTransform → counting sink.
 * Never loads the file (or any large buffer) fully into memory.
 *
 * @param {object} opts
 * @param {string} opts.filePath absolute path to the CSV on disk
 * @param {object} opts.mapping  { sourceCol: { destField, type, required } }
 * @param {function} [opts.onProgress] called with partial metrics as the run advances
 * @returns {Promise<{rowsProcessed, rowsFailed, elapsedMs, rowsPerSec, peakRssMB}>}
 */
async function runPipeline({ filePath, mapping, onProgress }) {
  const startedAt = process.hrtime.bigint();
  const metrics = { rowsProcessed: 0, rowsFailed: 0, peakRssMB: 0 };

  const parser = new CsvParseTransform();
  const mapper = new MappingTransform(mapping || {});

  parser.once('header', (cols) => {
    mapper.setColumns(cols);
  });

  // Progress sampling: emit partial metrics at most every 500ms and
  // track peak RSS for the memory audit trail.
  let lastEmit = 0;
  const maybeEmit = (force = false) => {
    const now = Date.now();
    if (force || now - lastEmit >= 500) {
      lastEmit = now;
      metrics.peakRssMB = Math.max(metrics.peakRssMB, process.memoryUsage().rss / 1024 / 1024);
      if (onProgress) onProgress({ ...metrics });
    }
  };
  mapper.on('data', () => maybeEmit());

  const sink = new Writable({
    objectMode: true,
    write(row, _enc, cb) {
      if (row && row.__error) {
        metrics.rowsFailed++;
      } else {
        metrics.rowsProcessed++;
      }
      maybeEmit();
      cb();
    },
  });

  await pipeline(fs.createReadStream(filePath, { encoding: 'utf8' }), parser, mapper, sink);

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  maybeEmit(true);
  return {
    rowsProcessed: metrics.rowsProcessed,
    rowsFailed: metrics.rowsFailed,
    elapsedMs: Math.round(elapsedMs),
    rowsPerSec: elapsedMs > 0 ? Math.round((metrics.rowsProcessed / elapsedMs) * 1000) : 0,
    peakRssMB: Math.round(metrics.peakRssMB * 10) / 10,
  };
}

module.exports = { runPipeline };
