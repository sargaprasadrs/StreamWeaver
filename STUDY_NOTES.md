# StreamWeaver - Comprehensive Study Notes

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Backend Deep Dive](#backend-deep-dive)
4. [Frontend Deep Dive](#frontend-deep-dive)
5. [Data Flow](#data-flow)
6. [Memory Safety & Performance](#memory-safety--performance)
7. [Key Design Patterns](#key-design-patterns)
8. [Testing](#testing)
9. [Deployment & Running](#deployment--running)
10. [Quick Reference](#quick-reference)

## Overview

StreamWeaver is a memory-safe, high-throughput no-code ETL (Extract, Transform, Load) pipeline designed to process massive CSV datasets (GBs in size) without loading them entirely into RAM. It achieves this through:

- **Streaming uploads** - Files streamed directly to disk via Busboy
- **Stream transforms** - Node.js Transform streams for chunk-by-chunk processing
- **Sandboxed execution** - Safe user-defined JavaScript transforms
- **Batched ingestion** - MongoDB bulk writes in 5000-record batches
- **Real-time progress** - WebSocket-based live updates
- **Virtualized UI** - React-window for smooth preview of large datasets

**Tech Stack:** Node.js 20+, Express, MongoDB, React + Vite, WebSockets, react-window

## Architecture

### High-Level Flow
```
Client (React) → HTTP/WebSocket → Express Server → Streaming Pipeline → MongoDB/File Storage
```

The system is split into two main components:
- **Backend** (`backend/`): API server, stream processing pipeline, WebSocket broker
- **Frontend** (`frontend/`): React UI for upload, mapping, transformation, monitoring

### Project Structure
```
StreamWeaver/
├── backend/src/
│   ├── server.js           # Entry point, HTTP + WS setup
│   ├── config.js           # Environment configuration
│   ├── db.js              # MongoDB/file fallback layer
│   ├── pipeline.js        # Main ETL pipeline orchestrator
│   ├── csvReader.js       # CSV parsing utilities
│   ├── validation.js      # Mapping validation
│   ├── controllers/       # Request handlers
│   ├── routes/            # API route definitions
│   ├── streams/           # Transform stream classes
│   │   ├── CsvParseTransform.js
│   │   ├── MappingTransform.js
│   │   └── SandboxTransform.js
│   ├── services/          # Business logic
│   │   └── ingestService.js
│   └── websocket/         # Real-time progress
│       └── progressBroker.js
└── frontend/src/
    ├── App.jsx            # Main app component
    ├── components/        # UI components
    └── lib/              # API & WebSocket clients
```

## Backend Deep Dive

### 1. Server (`server.js`)
- Creates Express app with middleware (JSON body parser, CORS disabled via x-powered-by removal)
- Attaches WebSocket broker to HTTP server
- Ensures upload/output directories exist
- Initializes database connection (MongoDB or file-only mode)
- Error handling with sanitized error messages

### 2. Database Layer (`db.js`)
Implements **dual-mode storage**:
- **MongoDB mode**: If `MONGODB_URI` is set, connects to MongoDB and creates indexes
- **File-only mode**: If no URI, persists to JSON files in `UPLOAD_DIR`

**Collections/Documents:**
- `uploads` - Job metadata (status, mapping, metrics, timestamps). In file mode: `{id}.job.json`
- `records` - Transformed data batches. In file mode: `{id}.records.jsonl`
- `failed_rows` - Rejected rows with reasons. In file mode: `{id}.failed.jsonl`

**Key Functions:**
- `initDb()` - Connects and sets up indexes
- `insertJob()`, `findJob()`, `updateJob()` - CRUD operations with fallback
- `hasDb()` - Checks if MongoDB is connected

### 3. Streaming Upload (`controllers/uploadController.js`)
**Critical for memory safety** - uses Busboy to stream multipart data directly to disk.

**Flow:**
1. Parse multipart request with Busboy (limits: 1 file, max size from config)
2. Validate filename (whitelist: `.csv`, `.tsv`, `.txt`, no path traversal)
3. Stream file chunks to disk using manual pipe with backpressure
4. Handle client disconnects (abort and cleanup temp files)
5. Create job record with status `ready`
6. Return `uploadId`

**Backpressure handling:**
```js
fileStream.on('data', (chunk) => {
  sizeBytes += chunk.length;
  if (!out.write(chunk)) {
    fileStream.pause(); // Pause reading if disk can't keep up
  }
});
out.on('drain', () => {
  fileStream.resume(); // Resume when buffer drains
});
```

### 4. CSV Parsing (`streams/CsvParseTransform.js`)
Custom streaming CSV parser that handles edge cases without buffering entire file.

**Features:**
- **Incremental tokenization** - Processes chunks across boundaries (quotes, newlines)
- **Quote handling** - Double quotes for escaping (`""`)
- **Delimiter detection** - Auto-detects comma, semicolon, tab, pipe from first line
- **BOM stripping** - Handles UTF-8 BOM (`\uFEFF`)
- **Multi-byte UTF-8 safety** - Holds incomplete character bytes across chunks
- **Header emission** - First row emitted as `header` event, normalized (trimmed, defaults for empty names)

**Tokenizer State Machine:**
- Tracks: `inQuotes`, `field`, `row`, buffer for partial data
- Handles CRLF/LF line endings
- Never accumulates more than one field in memory

### 5. Mapping & Transformation (`streams/MappingTransform.js`)
Applies column mapping with type coercion. **Errors don't stop the stream** - bad rows are emitted as error objects.

**Mapping Config:**
```js
{
  sourceColumn: { 
    destField: 'targetName', 
    type: 'string|number|boolean|date', 
    required: true|false 
  }
}
```

**Type Coercion (`coerceValue`):**
- `string`: Trim, default
- `number`: Parse with comma removal, validates finite
- `boolean`: Accepts true/1/yes/y/false/0/no/n (case-insensitive)
- `date`: Validates with `Date`, returns ISO string

**Error Handling:**
- Required fields missing/invalid → error if required, warning if optional
- Pushes `{ __error: true, rowIndex, reason, raw }` for failed rows
- Continues processing rest of stream

### 6. Sandboxed Transforms (`streams/SandboxTransform.js`)
Executes user JavaScript safely within the stream.

**Dual-mode execution:**
1. **Production**: `isolated-vm` (separate V8 isolate with memory limits) - preferred
2. **Fallback**: Node.js `vm` module with context isolation

**Security measures:**
- No access to Node globals (`require`, `process`, `fs`)
- Per-row timeout (default 100ms)
- Runs in isolated context
- Errors on a field mark entire row as failed

**Usage:**
```js
{ transform: { code: 'return value.toUpperCase()', field: 'name' } }
// or applies to all string fields if no field specified
```

**Compilation:**
- Wraps snippet as `(function(value, row) { ${code} })`
- Pre-compiles function and invoker script
- Uses `runInContext` with timeout

### 7. Pipeline Orchestration (`pipeline.js`)
Wires everything together using `stream.pipeline` (promisified).

**Pipeline stages:**
```js
fs.createReadStream(filePath) 
→ CsvParseTransform 
→ MappingTransform 
→ [SandboxTransform (optional)] 
→ Writable sink (batched ingestion)
```

**Sink behavior:**
- **Normal rows**: Buffer in `batch[]`, flush every `batchSize` (default 5000) via `onBatch()`
- **Error rows**: Buffer in `failed[]`, flush every 500 via `onFailed()` (separate from main batches)
- **Progress tracking**: Emits every 500ms with RSS sampling for memory audit
- **Metrics**: rowsProcessed, rowsFailed, insertedCount, batches, elapsedMs, rowsPerSec, peakRssMB

**Key insight:** Only bounded arrays in memory (max ~5500 rows at a time). The file can be 100GB.

### 8. Ingestion Service (`services/ingestService.js`)
Persists data in batches with dual-mode support.

**IngestSession class:**
- `writeBatch(rows)` - Persists transformed records
- `writeFailed(rows)` - Persists failed rows
- `close()` - Flushes and closes file streams

**MongoDB mode:**
```js
await dbh.collection('records').insertMany(docs, { ordered: false });
// docs: [{ uploadId, row: index, data: {...mapped fields...} }]
await dbh.collection('failed_rows').insertMany(docs, { ordered: false });
// docs: [{ uploadId, rowIndex, reason, raw }]
```
`ordered: false` allows partial success on duplicate key errors.

**File mode:**
Appends JSONL to `{uploadId}.records.jsonl` and `{uploadId}.failed.jsonl`

**Pagination:**
`listFailedRows()` supports paginated queries for both modes.

### 9. WebSocket Progress Broker (`websocket/progressBroker.js`)
Real-time updates to clients.

**Features:**
- Room-based: clients join by `jobId` or subscribe to all (`jobId=all`)
- **Throttling**: Progress updates throttled to 500ms per job (prevents flooding)
- **Terminal frames**: `emitTerminal()` bypasses throttle for completed/failed
- **Heartbeat**: Ping/pong every 30s to detect dead connections
- **Auto-reconnect** support on client side

**Message types:**
```js
{ type: 'subscribed', jobId }
{ jobId, status: 'processing', rowsProcessed, rowsPerSec, ... } // throttled
{ jobId, terminal: true, status: 'completed', ... } // unthrottled
```

### 10. API Routes

**Uploads (`routes/uploads.js`):**
- `POST /api/uploads` - Upload file
- `GET /api/uploads/:id` - Job status (no tempPath)
- `GET /api/uploads/:id/sample` - Header + first 1000 rows (streamed)
- `PUT /api/uploads/:id/mapping` - Save mapping + optional transform
- `POST /api/uploads/:id/run` - Execute pipeline
- `GET /api/uploads/:id/errors` - Alias for failed rows

**Jobs (`routes/jobs.js`):**
- `GET /api/jobs/:id` - Job details
- `GET /api/jobs/:id/errors` - Paginated failed rows

**Health (`routes/health.js`):**
- `GET /api/health` - Server status + memory stats

### 11. Validation (`validation.js`)
Validates mapping before saving/execution:
- Must be object with at least one entry
- Each entry needs `destField` (string, non-empty)
- No duplicate destination fields
- Type must be in `['string','number','boolean','date']` if specified
- Source column must exist in CSV header if `columns` provided
- Required destination fields must be mapped if specified

## Frontend Deep Dive

### 1. App Structure (`App.jsx`)
Main orchestrator managing state flow:
1. Upload → load sample preview
2. Configure transform (optional)
3. Configure mapping
4. Run pipeline → subscribe to WebSocket progress
5. Show summary + failed rows on completion

**State:**
- `sample` - Preview data (columns, rows)
- `transform` - Sandbox transform config
- `run` - Active run status and progress data
- `summary` - Final results
- `errorsToken` - Triggers FailedRowsPanel refresh

### 2. Components

**UploadDropzone** (`components/upload/UploadDropzone.jsx`)
- Drag & drop or click to select
- XHR upload with progress tracking
- Validates file type client-side
- Calls `onUploaded({uploadId})` on success

**VirtualCsvGrid** (`components/grid/VirtualCsvGrid.jsx`)
- Uses `react-window` for virtualization
- Only renders visible rows in DOM (smooth scrolling even with 1000 rows)
- Shows truncated indicator if >1000 rows
- Frozen header

**TransformEditor** (`components/transform/TransformEditor.jsx`)
- Code editor for JavaScript snippet
- Specify target field or apply to all strings
- Shows example usage

**MappingBoard** (`components/mapping/MappingBoard.jsx`)
- Maps source columns to destination fields
- Type selection (string/number/boolean/date)
- Required toggle
- Preview before/after
- Validates and saves mapping
- Starts pipeline run

**ProgressBar** (`components/progress/ProgressBar.jsx`)
- Animated progress bar
- Status chip
- Stats grid: rows processed, ingested, failed, rows/sec, batches, peak RSS
- Shows indeterminate progress if percent unknown

**JobSummary** (`components/summary/JobSummary.jsx`)
- Final run statistics
- Duration, throughput, success/failure counts

**FailedRowsPanel** (`components/errors/FailedRowsPanel.jsx`)
- Paginated table of failed rows
- Filter by reason/raw content
- Expandable raw row view
- Auto-refreshes after run completes

### 3. API Client (`lib/api.js`)
REST API wrapper using fetch.

**Functions:**
- `uploadFile(file, onProgress)` - XHR upload with progress
- `fetchSample(uploadId)` - Get preview
- `saveMapping(uploadId, mapping, transform)` - PUT mapping
- `runPipeline(uploadId, transform)` - POST run
- `fetchErrors(uploadId, page, pageSize)` - Get failed rows

### 4. WebSocket Client (`lib/ws.js`)
Handles real-time updates with reconnection.

**`subscribeProgress(jobId, onMessage)`:**
- Connects to `ws://host/ws/progress?jobId=...`
- Auto-reconnects on disconnect (exponential-ish)
- Parses JSON messages
- Returns unsubscribe function

## Data Flow

### Complete Upload-to-Ingest Flow

```mermaid
1. User selects CSV → UploadDropzone uploads via POST /api/uploads (streamed to disk)
2. Server creates job, returns uploadId
3. App fetches preview via GET /api/uploads/:id/sample (reads first 1000 rows)
4. User configures transform in TransformEditor (optional)
5. User maps columns in MappingBoard → PUT /api/uploads/:id/mapping
6. User clicks Run → POST /api/uploads/:id/run
   - Server marks job as 'processing', emits WS event
   - runPipeline() streams file through transforms
   - IngestSession batches writes to DB/files
   - Broker emits throttled progress every 500ms
7. On completion:
   - Server marks job 'completed', emits terminal WS event
   - App shows JobSummary
   - If failures exist, FailedRowsPanel loads paginated errors
```

### Pipeline Data Transformation

**Input:** CSV file on disk
```csv
name,age
ann,30
bob,abc
```

**Stage 1 - CsvParseTransform:** CSV strings → row arrays
```js
[['ann', '30'], ['bob', 'abc']] (after header)
```

**Stage 2 - MappingTransform:** Arrays → objects with coercion
```js
// Mapping: { name: {destField:'person', type:'string'}, age: {destField:'years', type:'number'} }
{ person: 'ann', years: 30 }  // success
{ __error: true, rowIndex: 1, reason: 'years: cannot coerce "abc" to number', raw: 'bob,abc' } // error
```

**Stage 3 - SandboxTransform (if enabled):** Apply user code
```js
{ person: 'ANN', years: 30 } // if code: return value.toUpperCase() on person
```

**Stage 4 - Sink:** Batched to DB/files
- Every 5000 normal rows → `insertMany` to `records` collection
- Every 500 error rows → `insertMany` to `failed_rows` collection

## Memory Safety & Performance

### Memory Guarantees
The system is designed so memory usage is **O(batch_size)**, not O(file_size).

**What's bounded:**
- Upload buffering: 0 (streamed to disk)
- CSV parsing: 1 field max at a time
- Pipeline: 1 row in flight + batch buffer (max 5500 objects)
- Preview: 1000 rows max
- Pagination: 50 rows per page

**Memory audit results (from README):**
- 0.81 GB CSV, 10,000,000 rows
- Peak RSS: **60.6 MB**
- Live heap after GC: ~5 MB
- Throughput: ~79,800 rows/sec
- Budget: ≤150 MB ✓

### Performance Optimizations
1. **Backpressure** - Pause reads when disk/network can't keep up
2. **Batched writes** - `insertMany` with 5000 docs is much faster than individual inserts
3. **ordered: false** - Continues on individual failures
4. **Throttled WebSocket** - 500ms intervals prevent UI thrashing
5. **Virtualized rendering** - Only visible rows in DOM
6. **Stream pipeline** - Uses Node's native streams (efficient, backpressured)
7. **RSS sampling** - Track peak memory during processing

### Profiling
```bash
# Memory audit
cd backend
npm run audit:memory:live
# Runs with --max-old-space-size=96 --expose-gc
```

## Key Design Patterns

### 1. Stream Composition
Using `pipeline()` from `stream/promises` ensures proper cleanup on errors and end-of-stream handling.

### 2. Error Resilience
Errors don't crash the pipeline:
- Malformed CSV → caught and propagated appropriately
- Mapping errors → converted to failed rows, stream continues
- Transform errors → row marked failed, stream continues
- DB errors → handled by `ordered: false` and error propagation

### 3. Dual-Mode Architecture
Every persistence operation checks `hasDb()` and falls back to files. This makes the app demoable without MongoDB.

### 4. Room-Based Pub/Sub
WebSocket broker uses job-specific rooms so multiple clients can watch same job, and clients can watch all jobs.

### 5. Defensive Coding
- Path traversal prevention in uploads
- Filename whitelisting
- No stack traces leaked to clients
- Input validation at multiple layers
- Timeouts on sandboxed code

## Testing

**Framework:** Mocha + Chai + Supertest

**Test suites (85 passing):**
- `csvParser.test.js` - Tokenizer, delimiter detection, BOM, quotes
- `mappingPipeline.test.js` - MappingTransform, coerceValue, full pipeline
- `validation.test.js` - Mapping validation rules
- `uploads.test.js` - API endpoints, upload flow, sample reading
- `streams.extras.test.js` - SandboxTransform, additional cases

**Test setup:**
- Uses temp directories for uploads/outputs
- MongoDB disabled (`MONGODB_URI = ''`) for file-only mode
- Size limit set to 1MB for testing

**Running tests:**
```bash
cd backend
npm test
# or
npx mocha "test/**/*.test.js" --require test/setup.js --timeout 20000
```

## Deployment & Running

### Prerequisites
- Node.js >= 20
- MongoDB (optional, falls back to files)
- npm

### Backend Setup
```bash
cd backend
cp .env.example .env  # Optional
npm install
npm run dev           # Development with watch
npm start             # Production
npm test              # Run tests
```

**Environment variables (`.env`):**
```env
PORT=4000
MONGODB_URI=                # Leave empty for file-only mode
MONGODB_DB=streamweaver
MAX_UPLOAD_BYTES=2147483648 # 2GB
UPLOAD_DIR=./tmp/uploads
OUTPUT_DIR=./tmp/output
SAMPLE_ROW_LIMIT=1000
BATCH_SIZE=5000
RAW_ROW_LIMIT=5000
```

### Frontend Setup
```bash
cd frontend
npm install
npm run dev      # http://localhost:5173 (proxies /api to :4000)
npm run build    # Build for production
npm run preview  # Preview production build
```

**Vite proxy** (configured in `vite.config.js`) forwards `/api` and `/ws` to backend.

### Memory Audit
```bash
cd backend
npm run audit:memory:live
# Generates 10M row CSV, runs pipeline, samples RSS
# Results in tmp/audit-results.json
```

## Quick Reference

### Key Files to Understand
| File | Purpose | Complexity |
|------|---------|------------|
| `pipeline.js` | Orchestrates entire ETL flow | High |
| `CsvParseTransform.js` | Custom CSV tokenizer | High |
| `uploadController.js` | Streaming upload with backpressure | High |
| `SandboxTransform.js` | Secure code execution | High |
| `progressBroker.js` | WebSocket pub/sub with throttling | Medium |
| `ingestService.js` | Dual-mode persistence | Medium |

### API Quick Reference
| Method | Endpoint | Notes |
|--------|----------|-------|
| POST | `/api/uploads` | Multipart upload, returns uploadId |
| GET | `/api/uploads/:id/sample` | First 1000 rows for preview |
| PUT | `/api/uploads/:id/mapping` | Save mapping + transform |
| POST | `/api/uploads/:id/run` | Start ETL pipeline |
| GET | `/api/uploads/:id` | Job status |
| GET | `/api/jobs/:id/errors` | Paginated failures |
| WS | `/ws/progress?jobId=` | Live progress updates |

### Common Patterns
- **Stream creation**: Always use streams for file I/O
- **Backpressure**: Check `write()` return value, pause/resume
- **Error objects**: Use `{ __error: true, ... }` to pass errors through streams
- **Batched operations**: Never write row-by-row to DB
- **Memory checks**: Sample RSS periodically in long-running operations

### Debugging Tips
1. **Check temp files**: Look in `backend/tmp/uploads/` and `backend/tmp/output/`
2. **Monitor memory**: Use `process.memoryUsage()` or run audit script
3. **WebSocket issues**: Check browser console, broker logs
4. **Test with small files first**: Use the test patterns
5. **File-only mode**: Works without MongoDB, great for debugging

---

**Remember:** The core principle is **stream everything, buffer nothing**. Every component is designed around this constraint. If you're adding features, ask yourself: "Could this load large amounts of data into memory?" If yes, redesign it as a stream.
