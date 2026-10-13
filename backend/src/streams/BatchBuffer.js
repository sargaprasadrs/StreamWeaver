const { Writable } = require('node:stream');

/**
 * BatchBuffer: a bounded objectMode sink that accumulates records and
 * flushes them in fixed-size batches (default 5,000) via an async
 * `onBatch` callback. Also flushes a partial final batch on stream end.
 *
 * The in-memory footprint is bounded by `size` records at any moment, so
 * arbitrarily large inputs stay safe.
 */
class BatchBuffer extends Writable {
  /**
   * @param {object} opts
   * @param {number} [opts.size]    records per batch
   * @param {function} opts.onBatch async (rows) => void
   */
  constructor({ size = 5000, onBatch } = {}) {
    super({ objectMode: true, highWaterMark: 16 });
    if (typeof onBatch !== 'function') {
      throw new Error('BatchBuffer requires an onBatch callback');
    }
    this.size = Math.max(1, size);
    this.onBatch = onBatch;
    this.buffer = [];
    this.batchesFlushed = 0;
    this.recordsFlushed = 0;
  }

  async _flushBuffer(callback) {
    if (this.buffer.length === 0) return callback();
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.onBatch(batch);
      this.batchesFlushed += 1;
      this.recordsFlushed += batch.length;
      return callback();
    } catch (err) {
      return callback(err);
    }
  }

  _write(record, _enc, callback) {
    this.buffer.push(record);
    if (this.buffer.length >= this.size) {
      this._flushBuffer(callback);
      return;
    }
    callback();
  }

  _final(callback) {
    this._flushBuffer(callback);
  }
}

module.exports = { BatchBuffer };
