import React, { useCallback, useEffect, useState } from 'react';
import { fetchErrors } from '../../lib/api.js';

const PAGE_SIZE = 50;

/**
 * FailedRowsPanel: tabular view of rows rejected during mapping /
 * validation / transform. Supports reason search and expanding the raw row.
 */
export default function FailedRowsPanel({ uploadId, refreshToken = 0 }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async (p) => {
    setError(null);
    try {
      const body = await fetchErrors(uploadId, p, PAGE_SIZE);
      setData(body);
    } catch (err) {
      setError(err.message);
    }
  }, [uploadId]);

  useEffect(() => {
    setPage(1);
    load(1);
  }, [uploadId, refreshToken, load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const rows = (data && data.rows) || [];
  const filtered = query
    ? rows.filter(
        (r) =>
          String(r.reason || '').toLowerCase().includes(query.toLowerCase()) ||
          String(r.raw || '').toLowerCase().includes(query.toLowerCase())
      )
    : rows;

  const goTo = (p) => {
    const next = Math.min(totalPages, Math.max(1, p));
    setPage(next);
    load(next);
  };

  return (
    <section className="panel">
      <div className="progress-panel__head">
        <h2>Failed rows</h2>
        {data && <span className="chip chip--failed">{data.total} rejected</span>}
      </div>

      {error && <p className="alert alert--error">{error}</p>}

      {data && data.total === 0 && <p className="grid-empty">No failed rows — every record passed.</p>}

      {data && data.total > 0 && (
        <>
          <input
            className="search"
            type="search"
            placeholder="Filter by reason or raw value…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter failed rows"
          />
          <div className="failed-table">
            <div className="failed-table__head">
              <span>Row</span>
              <span>Reason</span>
              <span>Raw</span>
            </div>
            {filtered.map((r) => (
              <React.Fragment key={r.rowIndex}>
                <button
                  type="button"
                  className="failed-table__row"
                  onClick={() => setExpanded(expanded === r.rowIndex ? null : r.rowIndex)}
                >
                  <span className="mono">{r.rowIndex}</span>
                  <span className="failed-reason">{r.reason}</span>
                  <span className="mono ellipsis">{r.raw}</span>
                </button>
                {expanded === r.rowIndex && (
                  <pre className="failed-raw">{r.raw}</pre>
                )}
              </React.Fragment>
            ))}
            {filtered.length === 0 && <p className="grid-empty">No rows match “{query}”.</p>}
          </div>
          <div className="pager">
            <button type="button" className="btn btn--ghost" onClick={() => goTo(page - 1)} disabled={page <= 1}>
              Prev
            </button>
            <span className="pager__label">
              Page {page} of {totalPages}
            </span>
            <button type="button" className="btn btn--ghost" onClick={() => goTo(page + 1)} disabled={page >= totalPages}>
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
