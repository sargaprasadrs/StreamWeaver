# StreamWeaver

High-throughput no-code ETL pipeline for processing massive datasets using Node.js Streams, React virtualization, secure sandboxed transformations, WebSockets, and MongoDB bulk operations.

## Status

- **Week 1 (done):** streaming multipart uploads (busboy → temp file, never fully in RAM), upload job records with size limits and abort cleanup, streamed CSV sample endpoint (header + first 1,000 rows), and a virtualized preview grid (react-window).
- **Week 2 (done):** CsvParseTransform + MappingTransform (objectMode), streaming ETL pipeline with metrics, mapping validation, mapping/run endpoints, MappingBoard UI with preview, and a 2GB memory-audit harness.
- **Week 3 (done):** sandboxed per-row transforms (`SandboxTransform` — isolated-vm-compatible; `node:vm` fallback with per-row timeouts), WebSocket live-progress broker (`/ws/progress?jobId=`), TransformEditor, live ProgressBar + rows/sec.
- **Week 4 (done):** `BatchBuffer` (5,000-record flushes) + `IngestService` (MongoDB `insertMany`/`failed_rows`; JSONL file fallback), failed-row capture, paginated errors API, FailedRowsPanel + JobSummary UI.

## Memory audit (mid-review proof)

```
node --expose-gc --max-old-space-size=96 --max-semi-space-size=4 \
  scripts/memoryAudit.js --file tmp/audit-live.csv --gc
```

Latest run — **0.81 GB CSV, 10,000,000 rows**:

| Metric | Value |
|--------|-------|
| Peak RSS (250ms sampler) | **60.6 MB** |
| Live heap after GC | ~5 MB (bounded batch only) |
| Throughput | ~79,800 rows/sec |
| Budget | ≤ 150 MB |
| Within budget | **Yes** |

> V8 lazily reserves heap pages, so the audit runs with a heap cap
> (`--max-old-space-size=96`) that the deployed server also uses — the ETL
> pipeline's true live footprint is a handful of megabytes regardless of input size.

## Project Structure

```
StreamWeaver/
  backend/            Node.js 20+ / Express API
    src/server.js     app entry (HTTP server + WS progress broker)
    src/routes/       health.js, uploads.js, jobs.js
    src/controllers/  uploadController.js (busboy streaming upload)
    src/streams/      CsvParseTransform, MappingTransform, SandboxTransform, BatchBuffer
    src/pipeline.js   read → parse → map → [sandbox] → batched ingest sink
    src/websocket/    progressBroker.js (jobId rooms, 500ms throttle)
    src/services/     ingestService.js (Mongo bulk / JSONL fallback)
    test/             mocha + chai + supertest suites
  frontend/           React (Vite) UI
    src/components/   UploadDropzone, VirtualCsvGrid, MappingBoard,
                      TransformEditor, ProgressBar, JobSummary, FailedRowsPanel
    src/lib/          api.js (REST) + ws.js (reconnecting WS client)
  scripts/            memory audit + CSV generator
```

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Liveness + memory stats |
| POST | `/api/uploads` | Multipart CSV upload (streamed to disk) |
| GET | `/api/uploads/:id` | Job status + metrics |
| GET | `/api/uploads/:id/sample` | Header + first 1,000 rows (streamed read) |
| PUT | `/api/uploads/:id/mapping` | Save mapping (+ optional transform) |
| POST | `/api/uploads/:id/run` | Execute the streaming ETL pipeline |
| GET | `/api/uploads/:id/errors` | Paginated failed rows (alias) |
| GET | `/api/jobs/:id/errors` | Paginated failed rows |
| WS | `/ws/progress?jobId=` | Live progress: rows, rows/sec, %, failed count |

## Pipeline

```
fs.ReadStream → CsvParseTransform → MappingTransform
             → SandboxTransform (optional user JS, per-row timeout)
             → BatchBuffer (flush every 5,000) → IngestService
```

Failed/coercion/transform-error rows are emitted as `{ __error, rowIndex, reason, raw }`
and persisted to MongoDB `failed_rows` (or a JSONL file in file-only mode).

## Getting Started

### Backend

```bash
cd backend
cp .env.example .env   # optional; defaults work without MongoDB
npm install
npm run dev            # http://localhost:4000
npm test               # mocha test suite
```

Environment (see `backend/.env.example`): `PORT`, `MONGODB_URI` (leave blank for file-only mode), `MAX_UPLOAD_BYTES` (default 2GB), `UPLOAD_DIR`, `OUTPUT_DIR`, `BATCH_SIZE` (default 5000), `SAMPLE_ROW_LIMIT` (default 1000).

### Frontend

```bash
cd frontend
npm install
npm run dev            # http://localhost:5173 (proxies /api to :4000)
npm run build
```

### Memory audit (large file)

```bash
cd backend
npm run audit:memory:live   # generates ~0.8 GB CSV, runs the pipeline, samples RSS every 250ms
```

With MongoDB configured, results are persisted to the `upload_audits` collection; results are always written to `backend/tmp/audit-results.json`.
