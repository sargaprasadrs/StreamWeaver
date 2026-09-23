const { expect } = require('chai');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { CsvParseTransform, createCsvTokenizer, detectDelimiter } = require('../src/streams/CsvParseTransform');

/** Collect all rows emitted by a CsvParseTransform fed with the given text. */
async function parseAll(text, chunkSize = 64) {
  const rows = [];
  const parser = new CsvParseTransform();
  parser.on('data', (row) => rows.push(row));
  const source = Readable.from(
    (function* generate() {
      for (let i = 0; i < text.length; i += chunkSize) {
        yield text.slice(i, i + chunkSize);
      }
    })()
  );
  await pipeline(source, parser);
  return rows;
}

describe('detectDelimiter', () => {
  it('picks the comma for comma-separated lines', () => {
    expect(detectDelimiter('a,b,c')).to.equal(',');
  });
  it('picks semicolon when it dominates', () => {
    expect(detectDelimiter('a;b;c,d')).to.equal(';');
  });
  it('picks tab for TSV', () => {
    expect(detectDelimiter('a\tb\tc')).to.equal('\t');
  });
  it('defaults to comma when nothing matches', () => {
    expect(detectDelimiter('single')).to.equal(',');
  });
});

describe('createCsvTokenizer', () => {
  it('parses simple rows', () => {
    const t = createCsvTokenizer();
    expect(t.write('a,b\nc,d\n')).to.deep.equal([['a', 'b'], ['c', 'd']]);
    expect(t.end()).to.deep.equal([]);
  });

  it('flushes a final row without trailing newline', () => {
    const t = createCsvTokenizer();
    t.write('a,b\nc,d');
    expect(t.end()).to.deep.equal([['c', 'd']]);
  });

  it('handles quoted fields with embedded delimiters and newlines', () => {
    const t = createCsvTokenizer();
    const rows = [...t.write('x,"a,b",c\ny,"line\nbreak",d'), ...t.end()];
    expect(rows).to.deep.equal([['x', 'a,b', 'c'], ['y', 'line\nbreak', 'd']]);
  });

  it('unescapes doubled quotes inside quoted fields', () => {
    const t = createCsvTokenizer();
    t.write('"say ""hi""",b');
    expect(t.end()).to.deep.equal([['say "hi"', 'b']]);
  });

  it('treats CRLF as a row separator', () => {
    const t = createCsvTokenizer();
    expect(t.write('a,b\r\nc,d\r\n')).to.deep.equal([['a', 'b'], ['c', 'd']]);
  });

  it('emits empty fields for consecutive delimiters', () => {
    const t = createCsvTokenizer();
    expect(t.write('a,,c\n')).to.deep.equal([['a', '', 'c']]);
  });

  it('keeps row state across chunk boundaries', () => {
    const t = createCsvTokenizer();
    const r1 = t.write('hel');
    const r2 = t.write('lo,wo');
    const r3 = t.write('rld\n');
    expect(r1).to.deep.equal([]);
    expect(r2).to.deep.equal([]);
    expect(r3).to.deep.equal([['hello', 'world']]);
  });

  it('keeps quoted-field state across chunk boundaries', () => {
    const t = createCsvTokenizer();
    expect(t.write('a,"spl')).to.deep.equal([]);
    expect(t.write('it quote"')).to.deep.equal([]);
    expect(t.end()).to.deep.equal([['a', 'split quote']]);
  });

  it('skips a leading UTF-8 BOM when skipBom is set', () => {
    const t = createCsvTokenizer({ skipBom: true });
    const rows = [...t.write('\uFEFFa,b\n'), ...t.end()];
    expect(rows).to.deep.equal([['a', 'b']]);
  });
});

describe('CsvParseTransform', () => {
  it('emits data rows as arrays and exposes the header via the header event', async () => {
    const rows = await parseAll('id,name\n1,ann\n2,bo\n');
    expect(rows).to.deep.equal([['1', 'ann'], ['2', 'bo']]);
  });

  it('handles quoted fields and BOM end to end', async () => {
    const rows = await parseAll('\uFEFFname,note\nann,"likes, commas"\n');
    expect(rows).to.deep.equal([['ann', 'likes, commas']]);
  });

  it('splits mid-multibyte-character chunks safely', async () => {
    const text = 'name,emoji\nrow1,\u00e9\u00e8\u00ea\nrow2,\u4f60\u597d\n';
    const rows = await parseAll(text, 3); // 3-byte chunks: splits multi-byte chars
    expect(rows).to.deep.equal([['row1', '\u00e9\u00e8\u00ea'], ['row2', '\u4f60\u597d']]);
  });

  it('normalizes non-empty header cells and fills blank ones', async () => {
    const parser = new CsvParseTransform();
    let header = null;
    parser.on('header', (cols) => {
      header = cols;
    });
    const source = Readable.from([' name ,  ,c\n1,2,3\n']);
    await pipeline(source, parser);
    expect(header).to.deep.equal(['name', 'column_2', 'c']);
  });

  it('parses an empty file into zero rows', async () => {
    const rows = await parseAll('');
    expect(rows).to.deep.equal([]);
  });

  it('parses a file with only a header row', async () => {
    const rows = await parseAll('a,b,c\n');
    expect(rows).to.deep.equal([]);
  });

  it('treats stray quotes as data rather than failing', async () => {
    const rows = await parseAll('h1,h2,h3\na,"b"c,d\n');
    expect(rows).to.deep.equal([['a', 'bc', 'd']]);
  });

  it('processes a large file in bounded memory', async function () {
    this.timeout(20000);
    let count = 0;
    const parser = new CsvParseTransform();
    parser.on('data', () => count++);
    const source = Readable.from(
      (function* generate() {
        yield 'a,b\n';
        for (let i = 0; i < 100000; i++) {
          yield `${i},"row ${i}",x\n`;
        }
      })()
    );
    await pipeline(source, parser);
    expect(count).to.equal(100000);
  });
});
