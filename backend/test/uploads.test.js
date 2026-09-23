const request = require('supertest');
const expect = require('chai').expect;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.UPLOAD_DIR = path.join(os.tmpdir(), `sw-test-${Date.now()}`);
process.env.MAX_UPLOAD_BYTES = String(1024 * 1024);
process.env.SAMPLE_ROW_LIMIT = '1000';
process.env.MONGODB_URI = '';

const { createApp } = require('../src/server');
const config = require('../src/config');

describe('uploads API', () => {
  let app;

  before(() => {
    fs.mkdirSync(config.uploadDir, { recursive: true });
    app = createApp();
  });

  after(() => {
    fs.rmSync(config.uploadDir, { recursive: true, force: true });
  });

  describe('POST /api/uploads', () => {
    it('accepts a CSV and returns uploadId with status ready', async () => {
      const res = await request(app)
        .post('/api/uploads')
        .attach('file', Buffer.from('a,b\n1,2\n3,4\n'), 'data.csv');
      expect(res.status).to.equal(201);
      expect(res.body).to.have.property('uploadId');
      expect(res.body.status).to.equal('ready');
      expect(res.body.sizeBytes).to.equal(Buffer.from('a,b\n1,2\n3,4\n').length);
    });

    it('rejects unsupported file types', async () => {
      const res = await request(app)
        .post('/api/uploads')
        .attach('file', Buffer.from('not a csv'), 'payload.exe');
      expect(res.status).to.equal(400);
      expect(res.body.error).to.match(/Unsupported file type/);
    });

    it('rejects files over the size limit with 413', async () => {
      const big = Buffer.alloc(1024 * 1024 + 10, 0x61);
      const res = await request(app)
        .post('/api/uploads')
        .attach('file', big, 'big.csv');
      expect(res.status).to.equal(413);
    });

    it('rejects multipart payloads without a file part', async () => {
      const res = await request(app)
        .post('/api/uploads')
        .field('note', 'no file here');
      expect(res.status).to.equal(400);
    });
  });

  describe('GET /api/uploads/:id/sample', () => {
    let uploadId;

    before(async () => {
      const lines = ['id,name,score'];
      for (let i = 0; i < 25; i++) {
        lines.push(`${i},"Person ${i}, Jr",${(i * 7) % 100}`);
      }
      const res = await request(app)
        .post('/api/uploads')
        .attach('file', Buffer.from(lines.join('\n')), 'sample.csv');
      uploadId = res.body.uploadId;
    });

    it('returns header, first rows, and parses quoted fields with commas', async () => {
      const res = await request(app).get(`/api/uploads/${uploadId}/sample`);
      expect(res.status).to.equal(200);
      expect(res.body.columns).to.deep.equal(['id', 'name', 'score']);
      expect(res.body.rows).to.have.lengthOf(25);
      expect(res.body.rows[0]).to.deep.equal(['0', 'Person 0, Jr', '0']);
      expect(res.body.truncated).to.equal(false);
    });

    it('caps rows at the configured sample limit and flags truncated', async () => {
      const lines = ['n'];
      for (let i = 0; i < 1200; i++) lines.push(String(i));
      const up = await request(app)
        .post('/api/uploads')
        .attach('file', Buffer.from(lines.join('\n')), 'big.csv');
      const res = await request(app).get(`/api/uploads/${up.body.uploadId}/sample`);
      expect(res.status).to.equal(200);
      expect(res.body.rows).to.have.lengthOf(1000);
      expect(res.body.truncated).to.equal(true);
    });

    it('handles an empty file', async () => {
      const up = await request(app)
        .post('/api/uploads')
        .attach('file', Buffer.from(''), 'empty.csv');
      const res = await request(app).get(`/api/uploads/${up.body.uploadId}/sample`);
      expect(res.status).to.equal(200);
      expect(res.body.columns).to.deep.equal([]);
      expect(res.body.rows).to.deep.equal([]);
    });

    it('strips a UTF-8 BOM from the first header cell', async () => {
      const up = await request(app)
        .post('/api/uploads')
        .attach('file', Buffer.from('\uFEFFcol1,col2\nv1,v2\n', 'utf8'), 'bom.csv');
      const res = await request(app).get(`/api/uploads/${up.body.uploadId}/sample`);
      expect(res.status).to.equal(200);
      expect(res.body.columns).to.deep.equal(['col1', 'col2']);
      expect(res.body.rows[0]).to.deep.equal(['v1', 'v2']);
    });

    it('returns 404 for a missing upload', async () => {
      const res = await request(app).get('/api/uploads/does-not-exist/sample');
      expect(res.status).to.equal(404);
    });
  });
});
