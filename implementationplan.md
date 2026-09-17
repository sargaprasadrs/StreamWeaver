# StreamWeaver — Implementation Plan

**Project:** StreamWeaver — Memory-Safe Streaming ETL for Massive Datasets
**Team:** Sarga (Lead / Frontend + Coordination) · Chandra (Backend Lead)
**Timeline:** September 21 – October 17, 2026 (Mid-Project Review: Oct 4 · Final Review: Oct 19, 2026)
**Source docs:** PROJECT.pdf (Week 1–4 spec table)

---

## 1. What We Are Building

An enterprise-grade, no-code ETL pipeline. A user uploads a **massive CSV (gigabytes)** through
the browser, visually maps source columns to destination MongoDB fields, optionally writes
inline JavaScript transforms, and watches a **live progress bar** while the backend:

1. Accepts the upload **as a stream** (busboy) — the full file is **never** in RAM.
2. Parses CSV **chunk-by-chunk** with `stream.Transform` classes → JSON objects.
3. Applies **sandboxed** user transforms via `isolated-vm` (e.g., `return value.toUpperCase()`).
4. Buffers records and flushes **`insertMany` / `bulkWrite` every 5,000 docs** into MongoDB.
5. Streams processing metadata (rows processed/sec, % complete, failed rows) to the client
   over **WebSockets**.

**The three "advanced, not tutorial" guarantees:**
1. **Memory safety:** a 2GB upload with server RAM proven ≤ **150MB** via Node.js profiling (mid-review).
2. **UI smoothness:** a **virtualized grid** (react-window) previewing the first 1,000 rows with zero DOM lag.
3. **Safety + scale:** sandboxed user code executing *inside the stream*, and batched bulk ingestion.

---

## 2. Team & Roles (2-person team)

| Member | Role | Core responsibilities | Branch |
|--------|------|----------------------|--------|
| Sarga  | Lead / Frontend + Coordination | GitHub & DevOps, docs, merges, React UI, virtual grid, mapping UI, progress & error UI, memory-audit report | `main` |
| Chandra | Backend Lead | busboy upload streams, `Transform` classes, isolated-vm sandbox, WebSocket broker, MongoDB bulk ingestion, memory profiling | `chandra` |

> With only two people, labels are *focus areas*, not walls: both review every PR, both write
> tests, and both show up to the mid-review and final-review demos.

---

## 3. Timeline at a Glance

| Phase | Dates | Theme | Milestone |
|-------|-------|-------|-----------|
| Week 1 | Sept 21 – 27 | Multipart Streaming & Virtual Grid | Upload streams to disk; grid previews 1,000 rows |
| Week 2 | Sept 28 – Oct 4 | ETL Transform Streams & Mapping UI | CSV→JSON pipeline + mapping board |
| Mid-Review | Oct 3 – 4 | **Memory Audit + UI Performance** | **Mid-Project Review (Oct 4)** |
| Week 3 | Oct 5 – 11 | Sandboxed Execution & Live Progress | isolated-vm transforms + WS progress bar |
| Week 4 | Oct 12 – 17 | Bulk Ingestion & Error Handling UI | 5,000-record bulkWrite flushes; failed-rows panel |
| Final | Oct 19 | **Final Project Review** | Full 2GB demo, end to end |

**Daily standup: 5 PM IST (both members, ~10 min).** Sarga closes with action items.

---

## 4. Tech Stack

- **Frontend:** React (Vite), **react-window** (virtualized grid — smaller & maintained vs react-virtualized), Tailwind or plain CSS, native WebSocket client
- **Backend:** Node.js 20 LTS, Express, **busboy** (true streaming multipart parser — preferred over multer, whose engines add buffering semantics), `stream.Transform` (objectMode), **isolated-vm**, `ws`
- **Database:** MongoDB (Atlas free tier or local), native driver bulk writes (`bulkWrite`, `ordered: false`)
- **Tooling:** Git/GitHub, npm, Postman/curl, MongoDB Compass, `clinic.js` / `process.memoryUsage()` sampling (profiling), React Profiler + Chrome DevTools (UI perf)

---

## 5. High-Level Architecture

```
┌──────────────────────────── FRONTEND (React) ───────────────────────────┐
│  UploadDropzone (XHR, upload %)                                         │
│  VirtualCsvGrid (react-window — first 1,000 rows preview)               │
│  MappingBoard (source column → Mongo field, type, required)             │
│  TransformEditor (inline JS: return value.toUpperCase())                │
│  ProgressBar + rows/sec ◀──── WebSocket /ws/progress?jobId=…            │
│  FailedRowsPanel (row #, reason, raw line)                              │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ REST
                                 ▼
┌──────────────────────────── BACKEND (Node/Express) ──────────────────────┐
│  POST /api/uploads ──▶ busboy ──▶ file stream ──▶ temp file on disk      │
│  POST /api/uploads/:id/run ──▶ pipeline():                               │
│     fs.ReadStream                                                        │
│       → CsvParseTransform   (chunk → row objects, objectMode)            │
│       → MappingTransform    (source col → dest field + type coercion)    │
│       → SandboxTransform    (isolated-vm user snippet, Week 3)           │
│       → ValidationTransform (mark invalid rows, Week 4)                  │
│       → BatchBuffer         (flush insertMany every 5,000 docs)          │
│  WebSocket broker: rows processed, rows/sec, %, failed count (500ms)     │
└────────────────────────────────┬────────────────────────────────────────┘
                                 ▼
        MongoDB: uploads (job status) · records (bulk ingested) · failed_rows
```

---

## 6. Database Design

### `uploads` (job collection)
```js
{
  _id, originalName, sizeBytes, status: "uploading"|"ready"|"processing"|"completed"|"failed",
  bytesReceived, rowsProcessed, rowsFailed, insertedCount,
  mapping: { sourceCol: { destField, type, required } },
  transformCode: "return value.toUpperCase()",
  peakRssMB, startedAt, finishedAt
}
```
- **Purpose:** one document per upload/job; source of truth for progress + audit trail (incl. peak RAM for the memory audit).

### `records` (bulk-ingested data)
```js
{ _id, uploadId, row: 12345, data: { /* mapped fields */ } }
```
- **Purpose:** the transformed output; written **only** via batched `bulkWrite` (5,000/batch). Index on `{ uploadId: 1, row: 1 }`.

### `failed_rows`
```js
{ _id, uploadId, rowIndex, reason: "…validation error…", raw: "…original line/row…" }
```
- **Purpose:** Week 4 error-handling UI feeds directly off this collection.

---

## 7. API & WebSocket Surface

| Method | Endpoint | Purpose | Owner (primary) |
|--------|----------|---------|-----------------|
| POST | `/api/uploads` | Multipart CSV upload via busboy → streamed to temp file, returns `uploadId` | Chandra |
| GET | `/api/uploads/:id/sample` | Header + first 1,000 rows (streamed read) for the grid preview | Chandra |
| PUT | `/api/uploads/:id/mapping` | Save column mapping config | Chandra |
| POST | `/api/uploads/:id/run` | Start/execute the ETL pipeline for that upload | Chandra |
| GET | `/api/jobs/:id/errors` | Paginated failed rows for the error UI | Chandra |
| GET | `/api/health` | Liveness + memory stats (useful for profiling screenshots) | Chandra |
| WS | `/ws/progress?jobId=` | Live progress: % complete, rows processed/sec, failed count | Chandra |
| All UI wiring, PRs, docs | — | — | Sarga |

---

## 8. Project Structure

```
StreamWeaver/
  backend/
    src/
      server.js
      routes/           uploads.js, jobs.js
      controllers/      uploadController.js, jobController.js
      streams/
        CsvParseTransform.js    # chunk → JSON row objects
        MappingTransform.js     # source col → dest field + coercion
        SandboxTransform.js     # isolated-vm per-row user code
        ValidationTransform.js  # flag invalid rows
        BatchBuffer.js          # flush every 5,000 records
      websocket/progressBroker.js
      services/ingestService.js
      models/ (or db/collections.js)
  frontend/
    src/
      components/
        upload/UploadDropzone.jsx
        grid/VirtualCsvGrid.jsx     # react-window
        mapping/MappingBoard.jsx
        transform/TransformEditor.jsx
        progress/ProgressBar.jsx    # + rows/sec stat
        errors/FailedRowsPanel.jsx
      lib/api.js, lib/ws.js
```

---

## 9. Week-by-Week Implementation Plan

### Week 1 (Sept 21–27) — Multipart Streaming & Virtual Grid
**Goal:** a 100MB+ CSV uploads via stream (RAM flat), and the grid previews its first 1,000 rows.

| Day | Tasks | Owner | Deliverable |
|-----|-------|-------|-------------|
| Mon 21 | Backend scaffold (Express, folders, .env.example); repo docs + React scaffold with react-window | Chandra; Sarga | Both scaffolds on `main`/`chandra` |
| Tue 22 | `POST /api/uploads` with busboy → stream to temp file, log bytes received; UploadDropzone with XHR progress | Chandra; Sarga | Streaming upload E2E |
| Wed 23 | Upload limits + abort cleanup + `uploads` job record; dropzone wired to API, error states | Chandra; Sarga | Robust upload path |
| Thu 24 | `GET /api/uploads/:id/sample` (streamed header + first 1,000 rows); VirtualCsvGrid shell (react-window) | Chandra; Sarga | Sample endpoint + grid shell |
| Fri 25 | Sample endpoint edge-case tests; grid data binding, frozen header, polish | Chandra; Sarga | Working preview grid |
| Sat 26 | Integration day: 100MB file E2E, fix bugs | Both | Week 1 demo-able |
| Sun 27 | Docs, refactor, **merge `chandra` → `main` via PR**, README update | Both (Sarga merges) | Week 1 merged |

### Week 2 (Sept 28–Oct 4) — ETL Transform Streams & Mapping UI
**Goal:** file → CSV parse → mapping → row objects, fully streaming; mapping board done.

| Day | Tasks | Owner | Deliverable |
|-----|-------|-------|-------------|
| Mon 28 | `CsvParseTransform` (objectMode; quoted fields, escapes, CRLF, BOM) + tests; MappingBoard skeleton + state model | Chandra; Sarga | Parser transform |
| Tue 29 | `MappingTransform` (config-driven rename + type coercion) + tests; source column list UI from sample endpoint | Chandra; Sarga | Mapping transform |
| Wed 30 | `pipeline()` assembly: file → parse → map → counting sink + metrics; destination-field editor (name, type, required) | Chandra; Sarga | Streaming ETL pipeline |
| Thu 1 | `PUT /:id/mapping` + `POST /:id/run`; mapping preview (before/after rows) | Chandra; Sarga | API-driven runs |
| Fri 2 | Mapping validation (dup targets, unknown cols) + tests; mapping UX polish + unsaved-changes guard | Chandra; Sarga | Mapping board complete |
| Sat 3 | **Memory audit:** 2GB CSV generator, RSS sampler (250ms), run + record peak; **UI perf:** React Profiler pass, DOM node count on grid | Chandra; Sarga | Audit numbers collected |
| Sun 4 | **MID-PROJECT REVIEW:** demo + reports; merge Week 2 | Both | Mid-review passed |

**Mid-review checklist (from PROJECT.pdf):**
- [ ] 2GB file uploaded; profiler output proves server RAM **never exceeds 150MB**
- [ ] Virtualized grid scrolls smoothly, no DOM lag (React Profiler + DevTools trace captured)
- [ ] Team has ≥10 commit days; `main` is up to date and demo-able

### Week 3 (Oct 5–11) — Sandboxed Execution & Live Progress
**Goal:** user JS runs safely *inside* the stream; client sees live progress + rows/sec.

| Day | Tasks | Owner | Deliverable |
|-----|-------|-------|-------------|
| Mon 5 | isolated-vm spike (install, compile + run snippet with timeout & memory limit); TransformEditor skeleton | Chandra; Sarga | Sandbox feasibility proven |
| Tue 6 | `SandboxTransform` (per-job isolate, snippet compiled once, applied per row) + tests | Chandra | Sandboxed transform |
| Wed 7 | Sandbox hardening (timeouts, memory caps, row marked failed on error, stream continues); editor validation + run/stop controls | Chandra; Sarga | Abuser-proof sandbox |
| Thu 8 | WebSocket progress broker (jobId rooms; rows, rows/sec rolling, %, failed; 500ms throttle); WS client + reconnect | Chandra; Sarga | Live metadata streaming |
| Fri 9 | ProgressBar + rows/sec stat + status chip; run endpoint → broker E2E test | Sarga; Chandra | Live progress UI |
| Sat 10 | Integration: 1GB file with sandbox + live progress; bug fixes | Both | Week 3 demo-able |
| Sun 11 | Docs, refactor, **merge Week 3 to `main`**, demo script | Both (Sarga merges) | Week 3 merged |

### Week 4 (Oct 12–17) — Database Bulk Ingestion & Error-Handling UI
**Goal:** records land in MongoDB in 5,000-doc batches; failed rows are visible and explainable.

| Day | Tasks | Owner | Deliverable |
|-----|-------|-------|-------------|
| Mon 12 | `BatchBuffer` (flush `bulkWrite`/`insertMany` every 5,000 or on stream end, `ordered:false`) + tests; FailedRowsPanel skeleton | Chandra; Sarga | Batched ingestion |
| Tue 13 | `ingestService` (indexes, inserted-count metric, transient-error retry); failed-rows API client | Chandra; Sarga | Resilient ingest |
| Wed 14 | `ValidationTransform` (required/type checks → `failed_rows`) + tests; failed-rows table with filter/search | Chandra; Sarga | Error capture E2E |
| Thu 15 | `GET /api/jobs/:id/errors` pagination; job summary view (rows ok/failed, duration, throughput) | Chandra; Sarga | Error UX complete |
| Fri 16 | Full E2E bug fixes; re-run memory audit; perf tuning | Both | Feature-complete |
| Sat 17 | Final freeze: verification, README, commit audit, final merge to `main` | Both | Ready for review |
| Mon 19 | **FINAL PROJECT REVIEW:** 2GB demo (upload → map → sandbox → live progress → bulk ingest → error report) | Both | 🎉 |

---

## 10. Git & Collaboration Workflow (same as NexusFlow)

**One repo, two branches, weekly PR merges.** Never commit directly to `main` (Sarga's docs
commits excepted, by agreement).

- `main` — always shippable; Sarga merges via PR.
- `chandra` — all backend feature work.

### Daily rhythm
```bash
git checkout main && git pull origin main   # start fresh
git checkout chandra                        # (Chandra) or stay on main (Sarga)
# ... do the day's task ...
git add . && git commit -m "feat: short description"
git push origin chandra
```
**Sundays:** Sarga merges `chandra` → `main` via PR; both review.

### Commit message convention (required)
`feat:` · `fix:` · `test:` · `docs:` · `refactor:` · `perf:` · `style:` · `merge:` · `init:`
**Avoid:** `update`, `test`, `.`, `asdf`, empty/auto-generated messages.

### Commit targets (adapted for 2 people)
| Checkpoint | Requirement |
|------------|-------------|
| Week 1     | Each member commits on ≥2 days |
| Week 2     | Team reaches ≥10 commit days (by Oct 4) |
| Weeks 3–4  | Each member commits on ≥2 days/week; no 2+ day gaps |
| Overall    | 20+ consecutive team commit days (Sept 21 → Oct 17); 50+ meaningful commits total |

---

## 11. Rules & Compliance

Same program rules as NexusFlow (PROJECT_INSTRUCTIONS.pdf + Training Guidelines): 100%
session attendance, professional conduct, deadlines, escalate blockers to the trainer.
The standup is where blockers get surfaced — use it.

---

## 12. Risks & Mitigation

| Risk | Mitigation |
|------|------------|
| isolated-vm native build fails on Windows | Spike it on **Day 1 of Week 3** (done above); match Node version to prebuilt binaries; if blocked, escalate to trainer immediately — this is the riskiest dependency |
| Accidental full-file buffering (RAM blowup) | Always `pipeline()` streams (never `.on('data')` accumulation); keep BatchBuffer bounded; memory sampler runs in every test |
| CSV edge cases (quotes, embedded commas/newlines, BOM, CRLF) | Parser test corpus from Week 2 Day 1; never "fix later" |
| WebSocket flooding | Throttle broker emits to 500ms; client renders from latest snapshot |
| Atlas free-tier write limits | `bulkWrite` with `ordered:false`; local MongoDB fallback for the 2GB audit |
| Generating a real 2GB test file | Scripted generator (Week 2 Day 3) — deterministic, re-runnable |
| 2-person bandwidth | Strict scope per the week tables; park ideas in README "Future Work"; no feature creep |

---

## 13. Definition of Done (per deliverable)

- [ ] Committed on the correct branch with a meaningful message
- [ ] Runs locally per README setup guide
- [ ] Peer-reviewed via PR before merge (both of us review everything)
- [ ] Tests for non-trivial logic (parser, mapping, sandbox, batching)
- [ ] Memory assertions where relevant (RSS sampler in the test path)
- [ ] Demo-able in under 2 minutes

---

## 14. First Actions (before/on Sept 21)

1. ✅ `implementationplan.md` + `streamweaver_daily_tasks.txt` shared with Chandra.
2. ✅ `chandra` branch created (mirrors NexusFlow branch naming).
3. ⬜ Sarga: commit these docs to `main`, add Chandra as repo collaborator (Settings → Collaborators).
4. ⬜ Confirm together: MongoDB **Atlas vs local**, Node version (**20 LTS**), standup time (5 PM IST).
5. ⬜ Scaffold `backend/` + `frontend/` per §8; push initial commits on both branches.
6. ⬜ Kick off Week 1 per §9.
