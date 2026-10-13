import React from 'react';

function num(n) {
  return typeof n === 'number' ? n.toLocaleString() : '0';
}

/**
 * JobSummary: the post-run report card — ok/failed counts, throughput,
 * batch count, sandbox engine, and the peak RSS memory proof.
 */
export default function JobSummary({ summary }) {
  if (!summary) return null;
  const withinBudget = typeof summary.peakRssMB === 'number' ? summary.peakRssMB <= 150 : false;

  return (
    <section className="panel">
      <h2>Job summary</h2>
      <div className="stat-grid">
        <div className="stat">
          <span className="stat__value">{num(summary.rowsProcessed)}</span>
          <span className="stat__label">rows ok</span>
        </div>
        <div className="stat">
          <span className="stat__value stat__value--bad">{num(summary.rowsFailed)}</span>
          <span className="stat__label">rows failed</span>
        </div>
        <div className="stat">
          <span className="stat__value">{num(summary.insertedCount)}</span>
          <span className="stat__label">records ingested</span>
        </div>
        <div className="stat">
          <span className="stat__value">{num(summary.rowsPerSec)}</span>
          <span className="stat__label">rows / sec</span>
        </div>
        <div className="stat">
          <span className="stat__value">{summary.batches || 0}</span>
          <span className="stat__label">bulkWrite batches</span>
        </div>
        <div className="stat">
          <span className="stat__value">{summary.elapsedMs != null ? `${(summary.elapsedMs / 1000).toFixed(2)} s` : '—'}</span>
          <span className="stat__label">duration</span>
        </div>
        <div className="stat">
          <span className={`stat__value${withinBudget ? '' : ' stat__value--bad'}`}>
            {summary.peakRssMB != null ? `${summary.peakRssMB} MB` : '—'}
          </span>
          <span className="stat__label">peak RSS (budget 150 MB)</span>
        </div>
        {summary.sandboxEngine && (
          <div className="stat">
            <span className="stat__value">{summary.sandboxEngine}</span>
            <span className="stat__label">sandbox engine</span>
          </div>
        )}
      </div>
    </section>
  );
}
