const fs = require('node:fs');
const path = require('node:path');

const config = require('../config');
const { db, hasDb } = require('../db');

/**
 * IngestService — persists transformed records and failed rows.
 *
 * With MongoDB configured, records are written with `insertMany`
 * (ordered:false) in 5,000-document batches; failed rows land in the
 * `failed_rows` collection. Without MongoDB the exact same data is
 * appended to JSONL files under OUTPUT_DIR, so the app is fully
 * demo-able in file-only mode.
 */
class IngestSession {
  constructor(uploadId) {
    this.uploadId = uploadId;
    this.recordsWritten = 0;
    this.failedWritten = 0;
    this.mongo = hasDb();
    this.recordsStream = null;
    this.failedStream = null;
  }

  _recordsPath() {
    return path.join(config.outputDir, `${this.uploadId}.records.jsonl`);
  }

  _failedPath() {
    return path.join(config.outputDir, `${this.uploadId}.failed.jsonl`);
  }

  async _fileStream(kind, streamField) {
    if (this[streamField]) return this[streamField];
    await fs.promises.mkdir(config.outputDir, { recursive: true });
    const file = kind === 'records' ? this._recordsPath() : this._failedPath();
    const stream = fs.createWriteStream(file, { flags: 'a' });
    this[streamField] = stream;
    return stream;
  }

  /** Persist one batch of transformed records. */
  async writeBatch(rows) {
    if (rows.length === 0) return;
    const base = this.recordsWritten;
    if (this.mongo) {
      const dbh = await db();
      const docs = rows.map((data, i) => ({ uploadId: this.uploadId, row: base + i, data }));
      await dbh.collection('records').insertMany(docs, { ordered: false });
    } else {
      const stream = await this._fileStream('records', 'recordsStream');
      const payload = rows.map((data, i) => JSON.stringify({ uploadId: this.uploadId, row: base + i, data })).join('\n');
      await new Promise((resolve, reject) => {
        stream.write(`${payload}\n`, (err) => (err ? reject(err) : resolve()));
      });
    }
    this.recordsWritten += rows.length;
  }

  /** Persist a batch of failed rows ({ rowIndex, reason, raw }). */
  async writeFailed(rows) {
    if (rows.length === 0) return;
    if (this.mongo) {
      const dbh = await db();
      const docs = rows.map((r) => ({
        uploadId: this.uploadId,
        rowIndex: r.rowIndex,
        reason: r.reason,
        raw: r.raw,
      }));
      await dbh.collection('failed_rows').insertMany(docs, { ordered: false });
    } else {
      const stream = await this._fileStream('failed', 'failedStream');
      const payload = rows
        .map((r) => JSON.stringify({ uploadId: this.uploadId, rowIndex: r.rowIndex, reason: r.reason, raw: r.raw }))
        .join('\n');
      await new Promise((resolve, reject) => {
        stream.write(`${payload}\n`, (err) => (err ? reject(err) : resolve()));
      });
    }
    this.failedWritten += rows.length;
  }

  async close() {
    const endStream = (s) => new Promise((resolve) => (s ? s.end(resolve) : resolve()));
    await Promise.all([endStream(this.recordsStream), endStream(this.failedStream)]);
  }
}

/** Read all failed rows for an upload (file-only mode). */
async function readFailedFile(uploadId) {
  const file = path.join(config.outputDir, `${uploadId}.failed.jsonl`);
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return rows;
}

/**
 * Paginated failed rows for the error-handling UI.
 * @returns {Promise<{ rows, total, page, pageSize }>}
 */
async function listFailedRows(uploadId, { page = 1, pageSize = 50 } = {}) {
  const safePage = Math.max(1, page);
  const safeSize = Math.min(500, Math.max(1, pageSize));
  const skip = (safePage - 1) * safeSize;

  if (hasDb()) {
    const dbh = await db();
    const total = await dbh.collection('failed_rows').countDocuments({ uploadId });
    const rows = await dbh
      .collection('failed_rows')
      .find({ uploadId })
      .sort({ rowIndex: 1 })
      .skip(skip)
      .limit(safeSize)
      .toArray();
    return { rows, total, page: safePage, pageSize: safeSize };
  }

  const all = await readFailedFile(uploadId);
  all.sort((a, b) => a.rowIndex - b.rowIndex);
  return {
    rows: all.slice(skip, skip + safeSize),
    total: all.length,
    page: safePage,
    pageSize: safeSize,
  };
}

module.exports = { IngestSession, listFailedRows, readFailedFile };
