import React, { useEffect, useMemo, useState } from 'react';

const PLACEHOLDER = 'return value.toUpperCase();';

/**
 * TransformEditor: author the per-row JavaScript that runs inside the
 * backend sandbox. Syntax is validated locally (the server is the source
 * of truth for execution and isolation).
 */
export default function TransformEditor({ columns = [], value, onChange }) {
  const [enabled, setEnabled] = useState(Boolean(value && value.code));
  const [code, setCode] = useState((value && value.code) || '');
  const [field, setField] = useState((value && value.field) || '');

  // Derive validity without executing the snippet.
  const syntaxError = useMemo(() => {
    if (!code.trim()) return null;
    try {
      // eslint-disable-next-line no-new-func
      new Function('value', 'row', code);
      return null;
    } catch (err) {
      return err.message;
    }
  }, [code]);

  useEffect(() => {
    if (onChange) {
      onChange(enabled && code.trim() ? { code, field: field || undefined } : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, code, field]);

  return (
    <section className="panel">
      <div className="transform-head">
        <h2>Transform editor</h2>
        <label className="switch">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {enabled ? 'Enabled' : 'Disabled'}
        </label>
      </div>
      <p className="mapping-hint">
        Runs per row inside an isolated sandbox with a timeout. The snippet receives <code>value</code> and the full
        mapped <code>row</code>, and must return the new value.
      </p>

      {enabled && (
        <>
          <label className="field-label">
            Apply to field
            <select value={field} onChange={(e) => setField(e.target.value)}>
              <option value="">(all string fields)</option>
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <textarea
            className={`transform-code${syntaxError ? ' transform-code--error' : ''}`}
            rows={5}
            spellCheck={false}
            value={code}
            placeholder={PLACEHOLDER}
            onChange={(e) => setCode(e.target.value)}
            aria-label="Transform JavaScript"
          />

          {code.trim() && (
            <p className={`transform-status ${syntaxError ? 'transform-status--error' : 'transform-status--ok'}`}>
              {syntaxError ? `Syntax error: ${syntaxError}` : 'Syntax OK'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
