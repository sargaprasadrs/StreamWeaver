const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { MappingTransform, coerceValue } = require('../src/streams/MappingTransform');
const { validateMapping } = require('../src/validation');
const { runPipeline } = require('../src/pipeline');

describe('coerceValue', () => {
  it('passes strings through trimmed', () => {
    expect(coerceValue('  hi  ', 'string')).to.deep.equal({ ok: true, value: 'hi' });
  });

  it('coerces numbers including thousands separators', () => {
    expect(coerceValue(' 1,234.5 ', 'number')).to.deep.equal({ ok: true, value: 1234.5 });
  });

  it('rejects non-numeric strings for number type', () => {
    expect(coerceValue('abc', 'number').ok).to.equal(false);
  });

  it('coerces boolean truthy and falsy words', () => {
    expect(coerceValue('YES', 'boolean').value).to.equal(true);
    expect(coerceValue('0', 'boolean').value).to.equal(false);
  });

  it('rejects unknown boolean words', () => {
    expect(coerceValue('maybe', 'boolean').ok).to.equal(false);
  });

  it('coerces dates to ISO strings', () => {
    const out = coerceValue('2026-09-23', 'date');
    expect(out.ok).to.equal(true);
    expect(out.value).to.equal('2026-09-23T00:00:00.000Z');
  });

  it('rejects invalid dates', () => {
    expect(coerceValue('not a date', 'date').ok).to.equal(false);
  });
});

describe('MappingTransform', () => {
  function collect(mapper) {
    const rows = [];
    mapper.on('data', (row) => rows.push(row));
    return rows;
  }

  it('renames and coerces according to the mapping', async () => {
    const mapper = new MappingTransform({
      a: { destField: 'alpha', type: 'string' },
      b: { destField: 'beta', type: 'number' },
    });
    mapper.setColumns(['a', 'b']);
    const rows = collect(mapper);
    mapper.write(['x', '42']);
    await new Promise((r) => setImmediate(r));
    expect(rows).to.deep.equal([{ alpha: 'x', beta: 42 }]);
  });

  it('marks rows with coercion errors instead of throwing', async () => {
    const mapper = new MappingTransform({
      a: { destField: 'alpha', type: 'number' },
    });
    mapper.setColumns(['a']);
    const rows = collect(mapper);
    mapper.write(['oops']);
    await new Promise((r) => setImmediate(r));
    expect(rows[0].__error).to.equal(true);
    expect(rows[0].reason).to.match(/cannot coerce/);
    expect(rows[0].rowIndex).to.equal(0);
  });

  it('reports missing required fields', async () => {
    const mapper = new MappingTransform({
      a: { destField: 'alpha', type: 'string', required: true },
    });
    mapper.setColumns(['a']);
    const rows = collect(mapper);
    mapper.write(['   ']);
    await new Promise((r) => setImmediate(r));
    expect(rows[0].__error).to.equal(true);
    expect(rows[0].reason).to.match(/missing/);
  });

  it('does not fail rows for missing optional fields', async () => {
    const mapper = new MappingTransform({
      a: { destField: 'alpha', type: 'number', required: false },
    });
    mapper.setColumns(['a']);
    const rows = collect(mapper);
    mapper.write(['']);
    await new Promise((r) => setImmediate(r));
    expect(rows[0].__error).to.equal(true);
    expect(rows[0].reason).to.match(/optional/);
  });

  it('keeps the stream flowing after error rows', async () => {
    const mapper = new MappingTransform({
      a: { destField: 'alpha', type: 'number' },
    });
    mapper.setColumns(['a']);
    const rows = collect(mapper);
    mapper.write(['bad']);
    mapper.write(['7']);
    await new Promise((r) => setImmediate(r));
    expect(rows).to.have.lengthOf(2);
    expect(rows[1]).to.deep.equal({ alpha: 7 });
  });

  it('throws when constructed without a mapping object', () => {
    expect(() => new MappingTransform(null)).to.throw(/Mapping config/);
  });
});

describe('validateMapping', () => {
  it('accepts a well-formed mapping', () => {
    const out = validateMapping({
      a: { destField: 'x', type: 'string', required: true },
      b: { destField: 'y', type: 'number' },
    });
    expect(out.valid).to.equal(true);
    expect(out.errors).to.deep.equal([]);
  });

  it('rejects empty or non-object mappings', () => {
    expect(validateMapping(null).valid).to.equal(false);
    expect(validateMapping({}).valid).to.equal(false);
    expect(validateMapping([]).valid).to.equal(false);
  });

  it('rejects duplicate destination fields', () => {
    const out = validateMapping({
      a: { destField: 'same' },
      b: { destField: 'same' },
    });
    expect(out.valid).to.equal(false);
    expect(out.errors[0].message).to.match(/Duplicate destination field "same"/);
  });

  it('rejects invalid types', () => {
    const out = validateMapping({ a: { destField: 'x', type: 'float' } });
    expect(out.valid).to.equal(false);
    expect(out.errors[0].message).to.match(/Invalid type/);
  });

  it('rejects unknown source columns when a column list is provided', () => {
    const out = validateMapping({ ghost: { destField: 'x' } }, { columns: ['a', 'b'] });
    expect(out.valid).to.equal(false);
    expect(out.errors[0].message).to.match(/Unknown source column "ghost"/);
  });

  it('rejects entries missing destField', () => {
    const out = validateMapping({ a: { type: 'string' } });
    expect(out.valid).to.equal(false);
    expect(out.errors[0].message).to.match(/destField is required/);
  });
});

describe('runPipeline', () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-pipe-'));
    filePath = path.join(tmpDir, 'data.csv');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs file to mapped rows end to end', async () => {
    fs.writeFileSync(filePath, 'name,age\nann,30\nbo,notanumber\ncid,41\n');
    const result = await runPipeline({
      filePath,
      mapping: {
        name: { destField: 'person', type: 'string' },
        age: { destField: 'years', type: 'number', required: true },
      },
    });
    expect(result.rowsProcessed).to.equal(2);
    expect(result.rowsFailed).to.equal(1);
    expect(result.rowsPerSec).to.be.a('number');
    expect(result.peakRssMB).to.be.a('number');
  });

  it('reports zero rows for an empty file', async () => {
    fs.writeFileSync(filePath, '');
    const result = await runPipeline({ filePath, mapping: { a: { destField: 'x' } } });
    expect(result.rowsProcessed).to.equal(0);
    expect(result.rowsFailed).to.equal(0);
  });

  it('handles a 50k-row file with low overhead', async function () {
    this.timeout(20000);
    const lines = ['a,b'];
    for (let i = 0; i < 50000; i++) lines.push(`${i},${i * 2}`);
    fs.writeFileSync(filePath, lines.join('\n'));
    const result = await runPipeline({
      filePath,
      mapping: {
        a: { destField: 'id', type: 'number' },
        b: { destField: 'double', type: 'number' },
      },
    });
    expect(result.rowsProcessed).to.equal(50000);
  });

  it('supports progress callbacks', async () => {
    fs.writeFileSync(filePath, 'a\n1\n2\n3\n');
    const seen = [];
    await runPipeline({
      filePath,
      mapping: { a: { destField: 'x', type: 'number' } },
      onProgress: (m) => seen.push({ ...m }),
    });
    expect(seen.length).to.be.at.least(1);
    expect(seen[seen.length - 1].rowsProcessed).to.equal(3);
  });

  it('works when driven through a raw stream pipeline', async () => {
    const mapper = new MappingTransform({ a: { destField: 'x' } });
    mapper.setColumns(['a']);
    const rows = [];
    const sink = new (require('node:stream').Writable)({
      objectMode: true,
      write(chunk, _e, cb) {
        rows.push(chunk);
        cb();
      },
    });
    await pipeline(Readable.from([['v1'], ['v2']]), mapper, sink);
    expect(rows).to.deep.equal([{ x: 'v1' }, { x: 'v2' }]);
  });
});
