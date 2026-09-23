const fs = require('node:fs/promises');

const config = require('./config');

let dbRef = null;

/**
 * Connect to MongoDB when MONGODB_URI is configured; otherwise run in
 * file-only mode. All callers must handle db() returning null.
 */
async function initDb() {
  if (!config.mongoUri) {
    return null;
  }
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  dbRef = client.db(config.mongoDb);
  return dbRef;
}

async function db() {
  return dbRef;
}

async function closeDb() {
  dbRef = null;
}

/**
 * Create indexes for the uploads and failed_rows collections.
 * Safe to call repeatedly.
 */
async function ensureIndexes(dbh) {
  if (!dbh) return;
  await dbh.collection('uploads').createIndex({ createdAt: 1 });
  await dbh.collection('failed_rows').createIndex({ uploadId: 1, rowIndex: 1 });
}

/**
 * Insert an upload job record. When no database is configured the record is
 * persisted under UPLOAD_DIR as <id>.job.json so uploads stay trackable.
 */
async function insertJob(job) {
  const dbh = await db();
  if (dbh) {
    const result = await dbh.collection('uploads').insertOne({ ...job, createdAt: new Date() });
    return { ...job, _id: result.insertedId };
  }
  const path = require('node:path');
  const file = path.join(config.uploadDir, `${job._id}.job.json`);
  await fs.writeFile(file, JSON.stringify(job, null, 2));
  return job;
}

/**
 * Fetch an upload job by id from Mongo or the file fallback.
 */
async function findJob(id) {
  const dbh = await db();
  if (dbh) {
    return dbh.collection('uploads').findOne({ _id: id });
  }
  try {
    const path = require('node:path');
    const file = path.join(config.uploadDir, `${id}.job.json`);
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Persist updates to an upload job (merged into the stored document).
 */
async function updateJob(id, updates) {
  const dbh = await db();
  const path = require('node:path');
  if (dbh) {
    await dbh.collection('uploads').updateOne({ _id: id }, { $set: updates });
    return;
  }
  const job = await findJob(id);
  if (!job) return;
  const file = path.join(config.uploadDir, `${id}.job.json`);
  await fs.writeFile(file, JSON.stringify({ ...job, ...updates }, null, 2));
}

module.exports = { initDb, db, closeDb, ensureIndexes, insertJob, findJob, updateJob };
