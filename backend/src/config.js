require('dotenv').config();

const config = {
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGODB_URI || '',
  mongoDb: process.env.MONGODB_DB || 'streamweaver',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024),
  uploadDir: process.env.UPLOAD_DIR || './tmp/uploads',
  outputDir: process.env.OUTPUT_DIR || './tmp/output',
  sampleRowLimit: Number(process.env.SAMPLE_ROW_LIMIT || 1000),
  batchSize: Number(process.env.BATCH_SIZE || 5000),
  rawRowLimit: Number(process.env.RAW_ROW_LIMIT || 5000),
};

module.exports = config;
