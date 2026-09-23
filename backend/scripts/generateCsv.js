const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

/**
 * Deterministic CSV generator for memory audits.
 *
 * Usage:
 *   node scripts/generateCsv.js --rows 12500000 --out tmp/audit-2gb.csv
 *   node scripts/generateCsv.js --rows 50000 --out tmp/audit-small.csv
 *
 * Row shape exercises the whole pipeline: quoted fields with embedded
 * commas, numbers, booleans, and ISO dates. ~170 bytes/row, so
 * 12,500,000 rows ≈ 2.1GB.
 */

function parseArgs(argv) {
  const args = { rows: 100000, out: 'tmp/audit.csv' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rows') args.rows = Math.max(1, parseInt(argv[i + 1], 10) || args.rows);
    if (argv[i] === '--out') args.out = argv[i + 1] || args.out;
  }
  return args;
}

function csvEscape(value) {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function makeRow(i) {
  const name = `Person ${i}, Jr`;
  const email = `user${i}@example.com`;
  const score = (i * 7) % 1000;
  const active = i % 2 === 0 ? 'true' : 'false';
  const joined = new Date(Date.UTC(2020, i % 12, (i % 28) + 1)).toISOString();
  return `${i},${csvEscape(name)},${email},${score},${active},${joined}\n`;
}

async function main() {
  const { rows, out } = parseArgs(process.argv.slice(2));
  const dir = path.dirname(out);
  await fs.promises.mkdir(dir, { recursive: true });

  const header = 'id,name,email,score,active,joined\n';
  let bytes = Buffer.byteLength(header);

  const source = Readable.from(
    (function* generate() {
      yield header;
      for (let i = 0; i < rows; i++) {
        const line = makeRow(i);
        bytes += Buffer.byteLength(line);
        yield line;
      }
    })(),
    { highWaterMark: 1024 * 1024 }
  );

  await pipeline(source, fs.createWriteStream(out));
  console.log(`Wrote ${rows} rows (${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB) to ${out}`);
}

main().catch((err) => {
  console.error('Generation failed:', err.message);
  process.exit(1);
});
