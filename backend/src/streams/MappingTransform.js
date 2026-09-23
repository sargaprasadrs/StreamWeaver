const { Transform } = require('node:stream');

const TYPES = new Set(['string', 'number', 'boolean', 'date']);

/**
 * Coerce a raw CSV string to the destination type.
 * Returns { ok, value, reason }.
 */
function coerceValue(raw, type) {
  if (raw === undefined || raw === null) raw = '';
  const s = String(raw).trim();

  switch (type) {
    case 'number': {
      if (s === '') return { ok: false, reason: 'missing number value' };
      const n = Number(s.replace(/,/g, ''));
      if (!Number.isFinite(n)) return { ok: false, reason: `cannot coerce "${s}" to number` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      const norm = s.toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(norm)) return { ok: true, value: true };
      if (['false', '0', 'no', 'n'].includes(norm)) return { ok: true, value: false };
      if (s === '') return { ok: false, reason: 'missing boolean value' };
      return { ok: false, reason: `cannot coerce "${s}" to boolean` };
    }
    case 'date': {
      if (s === '') return { ok: false, reason: 'missing date value' };
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return { ok: false, reason: `cannot coerce "${s}" to date` };
      return { ok: true, value: d.toISOString() };
    }
    case 'string':
    default:
      return { ok: true, value: s };
  }
}

/**
 * MappingTransform: rows (arrays) in, mapped objects out.
 *
 * mapping: { [sourceColumn]: { destField, type, required } }
 *
 * Rows with per-row errors are emitted as { __error: true, rowIndex, reason, raw }
 * so the stream never stops on bad data.
 */
class MappingTransform extends Transform {
  constructor(mapping, options = {}) {
    super({ objectMode: true, highWaterMark: 16 });
    if (!mapping || typeof mapping !== 'object') {
      throw new Error('Mapping config object is required');
    }
    this.mapping = mapping;
    this.columns = options.columns || null;
    this.rowIndex = 0;
  }

  /**
   * Attach the CSV header after the parser discovered it, so source
   * columns resolve by name (index lookup) for subsequent rows.
   */
  setColumns(columns) {
    this.columns = columns;
  }

  _transform(row, _enc, callback) {
    try {
      const out = {};
      const errors = [];

      for (const [sourceCol, spec] of Object.entries(this.mapping)) {
        if (!spec || !spec.destField) continue;
        const idx = this.columns ? this.columns.indexOf(sourceCol) : -1;
        const raw = idx >= 0 ? row[idx] : row[sourceCol];
        const type = TYPES.has(spec.type) ? spec.type : 'string';

        const { ok, value, reason } = coerceValue(raw, type);
        if (!ok) {
          if (spec.required) {
            errors.push(`${spec.destField}: ${reason}`);
            continue;
          }
          errors.push(`${spec.destField}: ${reason} (optional)`);
          continue;
        }
        if (spec.required && (value === '' || value === null || value === undefined)) {
          errors.push(`${spec.destField}: missing required value`);
          continue;
        }
        out[spec.destField] = value;
      }

      if (errors.length > 0) {
        this.push({
          __error: true,
          rowIndex: this.rowIndex,
          reason: errors.join('; '),
          raw: Array.isArray(row) ? row.join(',') : String(row),
        });
      } else {
        this.push(out);
      }
      this.rowIndex++;
      callback();
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = { MappingTransform, coerceValue, TYPES };
