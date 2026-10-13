import React from 'react';

const STATUS_LABELS = {
  uploading: 'Uploading',
  ready: 'Ready',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

function formatNumber(n) {
  return typeof n === 'number' ? n.toLocaleString() : '0';
}

/**
 * Live progress: status chip, animated bar, and throughput stats fed by
 * WebSocket frames from the broker.
 */
export default function ProgressBar({
  status = 'processing',
  percent,
  rowsProcessed = 0,
  insertedCount = 0,
  rowsFailed = 0,
  rowsPerSec = 0,
  peakRssMB,
  batches = 0,
}) {
  const known = typeof percent === 'number' && Number.isFinite(percent);
  const pct = known ? Math.min(100, Math.max(0, Math.round(percent))) : 0;

  return (
    <section className="panel progress-panel">
      <div className="progress-panel__head">
        <h2>Live progress</h2>
        <span className={`chip chip--${status}`}>{STATUS_LABELS[status] || status}</span>
      </div>
      <div className="progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`progress-bar__fill${known ? '' : ' progress-bar__fill--indeterminate'}`} style={known ? { width: `${pct}%` } : undefined} />
      </div>
      <div className="stat-grid">
        <div className="stat">
          <span className="stat__value">{formatNumber(rowsProcessed)}</span>
          <span className="stat__label">rows processed</span>
        </div>
        <div className="stat">
          <span className="stat__value">{formatNumber(insertedCount)}</span>
          <span className="stat__label">records ingested</span>
        </div>
        <div className="stat">
          <span className="stat__value stat__value--bad">{formatNumber(rowsFailed)}</span>
          <span className="stat__label">failed rows</span>
        </div>
        <div className="stat">
          <span className="stat__value">{formatNumber(rowsPerSec)}</span>
          <span className="stat__label">rows / sec</span>
        </div>
        <div className="stat">
          <span className="stat__value">{batches}</span>
          <span className="stat__label">batches flushed</span>
        </div>
        <div className="stat">
          <span className="stat__value">{peakRssMB != null ? `${peakRssMB} MB` : '—'}</span>
          <span className="stat__label">peak RSS</span>
        </div>
      </div>
    </section>
  );
}
