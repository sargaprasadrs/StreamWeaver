const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { BatchBuffer } = require('../src/streams/BatchBuffer');
const { SandboxTransform, compileSnippet } = require('../src/streams/SandboxTransform');
const { runPipeline } = require('../src/pipeline');

describe('BatchBuffer', () => {
  it('flushes full batches and a partial final batch', async () => {
    const batches = [];
    const buffer = new BatchBuffer({ size: 2, onBatch: async (rows) => batches.push(rows) });
    await pipeline(Readable.from([1, 2, 3, 4, 5], { objectMode: true }), buffer);
    expect(batches.map((b) => b.length)).to.deep.equal([2, 2, 1]);
    expect(buffer.batchesFlushed).to.equal(3);
    expect(buffer.recordsFlushed).to.equal(5);
  });

  it('does not flush when empty', async () => {
    const batches = [];
    const buffer = new BatchBuffer({ size: 10, onBatch: async (rows) => batches.push(rows) });
    await pipeline(Readable.from([], { objectMode: true }), buffer);
    expect(batches).to.deep.equal([]);
  });

  it('propagates an onBatch error to the pipeline', async () => {
    const buffer = new BatchBuffer({
      size: 1,
      onBatch: async () => {
        throw new Error('bulk write failed');
      },
    });
    let failed = false;
    try {
      await pipeline(Readable.from([{ a: 1 }], { objectMode: true }), buffer);
    } catch (err) {
      failed = true;
      expect(err.message).to.match(/bulk write failed/);
    }
    expect(failed).to.equal(true);
  });

  it('requires an onBatch callback', () => {
    expect(() => new BatchBuffer({})).to.throw(/onBatch/);
  });
});

describe('SandboxTransform', () => {
  function collect(transform) {
    const out = [];
    transform.on('data', (row) => out.push(row));
    return out;
  }

  it('applies a string transform to the requested field', async () => {
    const t = new SandboxTransform({ code: 'return value.toUpperCase()', fields: ['name'] });
    const rows = collect(t);
    t.write({ name: 'ann', age: 30 });
    await new Promise((r) => setImmediate(r));
    expect(rows[0]).to.deep.equal({ name: 'ANN', age: 30 });
  });

  it('defaults to transforming every string field', async () => {
    const t = new SandboxTransform({ code: 'return value.toUpperCase()' });
    const rows = collect(t);
    t.write({ name: 'ann', city: 'nyc', age: 30 });
    await new Promise((r) => setImmediate(r));
    expect(rows[0]).to.deep.equal({ name: 'ANN', city: 'NYC', age: 30 });
  });

  it('supports arithmetic and row context', async () => {
    const t = new SandboxTransform({
      code: 'return Number(value) * 2',
      fields: ['score'],
    });
    const rows = collect(t);
    t.write({ score: '21' });
    await new Promise((r) => setImmediate(r));
    expect(rows[0].score).to.equal(42);
  });

  it('marks the row failed on a runtime error and keeps flowing', async () => {
    const t = new SandboxTransform({ code: 'return value.nope.deep', fields: ['name'] });
    const rows = collect(t);
    t.write({ name: 'ann' });
    t.write({ name: null });
    await new Promise((r) => setImmediate(r));
    expect(rows.length).to.equal(2);
    expect(rows[0].__error).to.equal(true);
    expect(rows[0].reason).to.match(/transform error/);
  });

  it('times out malicious infinite loops', async () => {
    const t = new SandboxTransform({ code: 'while (true) {}', fields: ['name'], timeoutMs: 50 });
    const rows = collect(t);
    const t0 = Date.now();
    t.write({ name: 'ann' });
    await new Promise((r) => setImmediate(r));
    expect(rows[0].__error).to.equal(true);
    expect(rows[0].reason).to.match(/timed out/);
    expect(Date.now() - t0).to.be.lessThan(2000);
  });

  it('has no access to Node globals', async () => {
    const t = new SandboxTransform({ code: 'return typeof process', fields: ['x'] });
    const rows = collect(t);
    t.write({ x: 'v' });
    await new Promise((r) => setImmediate(r));
    expect(rows[0].x).to.equal('undefined');
  });

  it('passes through rows already flagged with errors', async () => {
    const t = new SandboxTransform({ code: 'return value', fields: ['a'] });
    const rows = collect(t);
    t.write({ __error: true, rowIndex: 3, reason: 'bad' });
    await new Promise((r) => setImmediate(r));
    expect(rows[0].__error).to.equal(true);
  });

  it('exposes a reusable invoker from compileSnippet', () => {
    const { context, invoker } = compileSnippet('return value + "!"');
    context.__value = 'hi';
    context.__row = {};
    expect(invoker.runInContext(context)).to.equal('hi!');
  });

  it('rejects empty code', () => {
    expect(() => new SandboxTransform({ code: '   ' })).to.throw(/code is required/);
  });
});

describe('runPipeline with transform + batched ingestion', () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-pipe2-'));
    filePath = path.join(tmpDir, 'data.csv');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('streams records through a transform in batches and captures failed rows', async () => {
    fs.writeFileSync(filePath, 'name,age\nann,30\nbo,abc\ncid,41\ndee,50\n');
    const batches = [];
    const failed = [];
    const result = await runPipeline({
      filePath,
      mapping: {
        name: { destField: 'person', type: 'string', required: true },
        age: { destField: 'years', type: 'number', required: true },
      },
      transform: { code: 'return value.toUpperCase()', field: 'person' },
      batchSize: 2,
      onBatch: async (rows) => batches.push(rows),
      onFailed: async (rows) => failed.push(...rows),
    });
    expect(result.rowsProcessed).to.equal(3);
    expect(result.rowsFailed).to.equal(1);
    expect(result.insertedCount).to.equal(3);
    expect(result.batches).to.equal(2);
    expect(batches.map((b) => b.length)).to.deep.equal([2, 1]);
    expect(batches[0][0]).to.deep.equal({ person: 'ANN', years: 30 });
    expect(failed[0].reason).to.match(/years/);
    expect(result.sandboxEngine).to.equal('vm');
  });
});
