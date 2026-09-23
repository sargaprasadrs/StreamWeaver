import React, { useEffect, useMemo, useState } from 'react';
import { saveMapping, runPipeline } from '../../lib/api.js';

const TYPES = ['string', 'number', 'boolean', 'date'];

/**
 * Client-side mirror of the backend coercion, used only for the
 * before/after preview. The backend remains the source of truth.
 */
function coercePreview(raw, type) {
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  try {
    switch (type) {
      case 'number': {
        if (s === '') return { error: 'missing' };
        const n = Number(s.replace(/,/g, ''));
        return Number.isFinite(n) ? n : { error: `cannot coerce "${s}"` };
      }
      case 'boolean': {
        const norm = s.toLowerCase();
        if (['true', '1', 'yes', 'y'].includes(norm)) return true;
        if (['false', '0', 'no', 'n'].includes(norm)) return false;
        if (s === '') return { error: 'missing' };
        return { error: `cannot coerce "${s}"` };
      }
      case 'date': {
        if (s === '') return { error: 'missing' };
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? { error: `cannot coerce "${s}"` } : d.toISOString();
      }
      default:
        return s;
    }
  } catch {
    return { error: 'invalid' };
  }
}

function applyMappingToRow(row, columns, mapping) {
  const out = { values: {}, errors: [] };
  for (const [sourceCol, spec] of Object.entries(mapping)) {
    if (!spec || !spec.destField) continue;
    const idx = columns.indexOf(sourceCol);
    const raw = idx >= 0 ? row[idx] : '';
    const value = coercePreview(raw, spec.type || 'string');
    if (value && typeof value === 'object' && value.error) {
      out.errors.push(`${spec.destField}: ${value.error}`);
    } else {
      out.values[spec.destField] = value;
    }
  }
  return out;
}

/**
 * MappingBoard: assign source columns to destination fields with type +
 * required flags, validate, preview the first 10 rows, then save & run.
 */
export default function MappingBoard({ uploadId, columns, rows, onRunComplete }) {
  const [mapping, setMapping] = useState({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState(null);
  const [errors, setErrors] = useState([]);
  const [savedMapping, setSavedMapping] = useState(null);

  // Seed the board with identity mappings once the sample arrives.
  useEffect(() => {
    if (!columns || columns.length === 0) return;
    setMapping((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const seeded = {};
      columns.forEach((col) => {
        seeded[col] = { destField: col.trim().replace(/\s+/g, '_').toLowerCase(), type: 'string', required: false };
      });
      return seeded;
    });
  }, [columns]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const activeMapping = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(mapping).filter(([, spec]) => spec && spec.destField && spec.destField.trim() !== '')
      ),
    [mapping]
  );

  const localErrors = useMemo(() => {
    const errs = [];
    const seen = new Map();
    for (const [src, spec] of Object.entries(activeMapping)) {
      const dest = spec.destField.trim();
      if (seen.has(dest)) {
        errs.push(`Duplicate destination field "${dest}" (also from "${seen.get(dest)}")`);
      } else {
        seen.set(dest, src);
      }
    }
    if (Object.keys(activeMapping).length === 0) {
      errs.push('Map at least one column before saving.');
    }
    return errs;
  }, [activeMapping]);

  const previewRows = useMemo(() => {
    if (!rows || rows.length === 0) return [];
    return rows.slice(0, 10).map((row) => applyMappingToRow(row, columns, activeMapping));
  }, [rows, columns, activeMapping]);

  const updateEntry = (sourceCol, patch) => {
    setMapping((prev) => ({
      ...prev,
      [sourceCol]: { ...prev[sourceCol], ...patch },
    }));
    setDirty(true);
    setMessage(null);
  };

  const onSave = async () => {
    setErrors([]);
    setMessage(null);
    if (localErrors.length > 0) {
      setErrors(localErrors);
      return;
    }
    setSaving(true);
    try {
      await saveMapping(uploadId, activeMapping);
      setSavedMapping(activeMapping);
      setDirty(false);
      setMessage({ kind: 'ok', text: 'Mapping saved.' });
    } catch (err) {
      const details = err.details && err.details.length > 0
        ? err.details.map((d) => `${d.field}: ${d.message}`)
        : [err.message];
      setErrors(details);
    } finally {
      setSaving(false);
    }
  };

  const onRun = async () => {
    setErrors([]);
    setMessage(null);
    if (dirty && localErrors.length === 0) {
      const ok = window.confirm('You have unsaved mapping changes. Save and run now?');
      if (ok) {
        try {
          await saveMapping(uploadId, activeMapping);
          setSavedMapping(activeMapping);
          setDirty(false);
        } catch (err) {
          setErrors(err.details ? err.details.map((d) => `${d.field}: ${d.message}`) : [err.message]);
          return;
        }
      } else {
        return;
      }
    }
    if (localErrors.length > 0) {
      setErrors(localErrors);
      return;
    }
    setRunning(true);
    try {
      const result = await runPipeline(uploadId);
      setMessage({
        kind: 'ok',
        text: `Completed: ${result.rowsProcessed} rows ok, ${result.rowsFailed} failed, ${result.rowsPerSec} rows/sec, peak RSS ${result.peakRssMB} MB`,
      });
      if (onRunComplete) onRunComplete(result);
    } catch (err) {
      setErrors([err.message || 'Pipeline run failed']);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="panel">
      <h2>Mapping board</h2>
      <p className="mapping-hint">
        Map source columns to destination fields. Types are coerced during the run; required fields fail the row when
        missing.
      </p>

      <div className="mapping-grid">
        <div className="mapping-grid__head">
          <span>Source column</span>
          <span>Destination field</span>
          <span>Type</span>
          <span>Required</span>
        </div>
        {columns.map((col) => (
          <div key={col} className="mapping-grid__row">
            <code className="mapping-src" title={col}>
              {col}
            </code>
            <input
              type="text"
              value={mapping[col] ? mapping[col].destField : ''}
              placeholder="—"
              onChange={(e) => updateEntry(col, { destField: e.target.value })}
              aria-label={`Destination field for ${col}`}
            />
            <select
              value={mapping[col] ? mapping[col].type : 'string'}
              onChange={(e) => updateEntry(col, { type: e.target.value })}
              aria-label={`Type for ${col}`}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label className="mapping-required">
              <input
                type="checkbox"
                checked={mapping[col] ? mapping[col].required : false}
                onChange={(e) => updateEntry(col, { required: e.target.checked })}
              />
              required
            </label>
          </div>
        ))}
      </div>

      {errors.length > 0 && (
        <div className="alert alert--error" role="alert">
          {errors.map((e, i) => (
            <p key={i} style={{ margin: '2px 0' }}>
              {e}
            </p>
          ))}
        </div>
      )}
      {message && (
        <div className={`alert ${message.kind === 'ok' ? 'alert--ok' : 'alert--error'}`}>{message.text}</div>
      )}
      {dirty && <p className="mapping-dirty">● Unsaved changes</p>}

      <div className="mapping-actions">
        <button type="button" className="btn btn--primary" onClick={onSave} disabled={saving || running}>
          {saving ? 'Saving…' : 'Save mapping'}
        </button>
        <button type="button" className="btn" onClick={onRun} disabled={saving || running}>
          {running ? 'Running pipeline…' : 'Run pipeline'}
        </button>
      </div>

      {previewRows.length > 0 && (
        <div className="mapping-preview">
          <h3>Preview (first {previewRows.length} rows)</h3>
          <div className="mapping-preview__cols">
            <div className="mapping-preview__pane">
              <h4>Before (raw CSV)</h4>
              <table>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 10).map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci}>{cell === null || cell === undefined ? '' : String(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mapping-preview__pane">
              <h4>After (mapped)</h4>
              <table>
                <tbody>
                  {previewRows.map((out, ri) => (
                    <tr key={ri} className={out.errors.length > 0 ? 'preview-row--error' : ''}>
                      <td>
                        {Object.keys(out.values).length === 0 && out.errors.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          Object.entries(out.values).map(([k, v]) => (
                            <div key={k}>
                              <strong>{k}</strong>: {String(v)}
                            </div>
                          ))
                        )}
                        {out.errors.map((e, ei) => (
                          <div key={ei} className="preview-error-text">
                            {e}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
