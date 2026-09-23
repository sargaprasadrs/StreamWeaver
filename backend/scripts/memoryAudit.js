const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');

/**
 * Memory audit harness.
 *
 * Runs the full streaming pipeline against a (large) CSV while sampling
 * process.memoryUsage().rss every 250ms, then records peak RSS and
 * throughput. Writes results to tmp/audit-results.json and, when
 * MongoDB is configured, persists them to the `upload_audits` collection.
 *
 * Usage:
 *   node scripts/memoryAudit.js --file tmp/audit-2gb.csv [--mapping sample]
 */

function parseArgs(argv) {
  const args = { file: 'tmp/audit.csv', intervalMs: 250 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[i + 1] || args.file;
    if (argv[i] === '--interval') args.intervalMs = Math.max(50, parseInt(argv[i + 1], 10) || args.intervalMs);
  }
  return args;
}

const SAMPLE_MAPPING = {
  id: { destField: 'id', type: 'number', required: true },
  name: { destField: 'name', type: 'string' },
  email: { destField: 'email', type: 'string' },
  score: { destField: 'score', type: 'number' },
  active: { destField: 'active', type: 'boolean' },
  joined: { destField: 'joined', type: 'date' },
};

async function main() {
  const { file, intervalMs } = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(file);

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    console.error('Generate one first:  node scripts/generateCsv.js --rows 12500000 --out tmp/audit-2gb.csv');
    process.exit(1);
  }

  const sizeGB = fs.statSync(filePath).size / 1024 / 1024 / 1024;
  console.log(`Audit target: ${filePath} (${sizeGB.toFixed(2)} GB)`);

  // Lazy-require so the audit measures pipeline memory only.
  const { runPipeline } = require('../src/pipeline');

  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss / 1024 / 1024;
    if (rss > (global.__auditPeakRss || 0)) global.__auditPeakRss = rss;
    process.stdout.write(`\rsample: rss=${rss.toFixed(1)} MB   `);
  }, intervalMs);

  let result;
  try {
    result = await runPipeline({
      filePath,
      mapping: SAMPLE_MAPPING,
      onProgress: (m) => {
        if (m.rowsProcessed > 0 && m.rowsProcessed % 500000 === 0) {
          console.log(`  ... ${m.rowsProcessed} rows processed`);
        }
      },
    });
  } finally {
    clearInterval(sampler);
  }

  const samplerPeakMB = Math.round((global.__auditPeakRss || 0) * 10) / 10;
  const record = {
    timestamp: new Date().toISOString(),
    file: filePath,
    fileGB: Math.round(sizeGB * 1000) / 1000,
    intervalMs,
    rowsProcessed: result.rowsProcessed,
    rowsFailed: result.rowsFailed,
    elapsedMs: result.elapsedMs,
    rowsPerSec: result.rowsPerSec,
    peakRssPipelineMB: result.peakRssMB,
    peakRssSamplerMB: samplerPeakMB,
    peakRssMB: Math.max(result.peakRssMB, samplerPeakMB),
    budgetMB: 150,
    withinBudget: Math.max(result.peakRssMB, samplerPeakMB) <= 150,
  };

  const outDir = path.resolve('tmp');
  await fs.promises.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, 'audit-results.json');
  await fs.promises.writeFile(outPath, JSON.stringify(record, null, 2));

  console.log('\n--- Memory audit result ---');
  console.log(JSON.stringify(record, null, 2));

  if (config.mongoUri) {
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      await client.db(config.mongoDb).collection('upload_audits').insertOne(record);
      await client.close();
      console.log('Persisted to MongoDB collection: upload_audits');
    } catch (err) {
      console.warn(`Could not persist audit to MongoDB: ${err.message}`);
    }
  }

  process.exit(record.withinBudget ? 0 : 2);
}

main().catch((err) => {
  console.error('Audit failed:', err.message);
  process.exit(1);
});
