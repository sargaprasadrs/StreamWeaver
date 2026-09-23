# StreamWeaver

High-throughput no-code ETL pipeline for processing massive datasets using Node.js Streams, React virtualization, secure sandboxed transformations, WebSockets, and MongoDB bulk operations.

## Status

- **Week 1 (done):** streaming multipart uploads (busboy → temp file, never fully in RAM), upload job records with size limits and abort cleanup, streamed CSV sample endpoint (header + first 1,000 rows), and a virtualized preview grid (react-window).
- **Week 2 (done):** CsvParseTransform + MappingTransform (objectMode), streaming ETL pipeline with metrics, mapping validation, mapping/run endpoints, MappingBoard UI with preview, and a 2GB memory-audit harness.

## Project Structure

```
StreamWeaver/
  backend/            Node.js 20+ / Express API
    src/server.js     app entry
    src/routes/       health.js, uploads.js
    src/controllers/  uploadController.js (busboy streaming upload)
    src/streams/      CsvParseTransform, MappingTransform (transform streams)
    src/pipeline.js   fs.ReadStream → parse → map → counting sink
    test/             mocha + chai + supertest suites
  frontend/           React (Vite) UI
    src/components/   UploadDropzone, VirtualCsvGrid, MappingBoard
    src/lib/          api.js (XHR upload progress)
  scripts/            memory audit + 2GB CSV generator
```

## Getting Started

### Backend

```bash
cd backend
cp .env.example .env   # optional; defaults work without MongoDB
npm install
npm run dev            # http://localhost:4000
npm test               # mocha test suite
```

Environment (see `backend/.env.example`): `PORT`, `MONGODB_URI` (leave blank for file-only mode), `MAX_UPLOAD_BYTES` (default 2GB), `UPLOAD_DIR`, `SAMPLE_ROW_LIMIT` (default 1000).

### Frontend

```bash
cd frontend
npm install
npm run dev            # http://localhost:5173 (proxies /api to :4000)
npm run build
```

### Memory audit (2GB file)

```bash
cd backend
npm run audit:memory   # generates a large CSV, runs the pipeline, samples RSS every 250ms
```

With MongoDB configured, results are persisted to the `upload_audits` collection; results are always written to `backend/tmp/audit-results.json`.

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Liveness + memory stats |
| POST | `/api/uploads` | Multipart CSV upload (streamed to disk) |
| GET | `/api/uploads/:id/sample` | Header + first 1,000 rows (streamed read) |
| PUT | `/api/uploads/:id/mapping` | Save column mapping config |
| POST | `/api/uploads/:id/run` | Execute the streaming ETL pipeline |
