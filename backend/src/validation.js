const { TYPES } = require('./streams/MappingTransform');

/**
 * Validate a mapping config before it is persisted or executed.
 *
 * mapping: { [sourceColumn]: { destField, type, required } }
 *
 * Returns { valid, errors: [{ field, message }] }
 */
function validateMapping(mapping, options = {}) {
  const errors = [];
  const availableColumns = options.columns || null;

  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return { valid: false, errors: [{ field: 'mapping', message: 'Mapping must be an object' }] };
  }

  const entries = Object.entries(mapping);
  if (entries.length === 0) {
    return { valid: false, errors: [{ field: 'mapping', message: 'Mapping must contain at least one column' }] };
  }

  const seenDest = new Map();
  for (const [sourceCol, spec] of entries) {
    if (!spec || typeof spec !== 'object') {
      errors.push({ field: sourceCol, message: 'Mapping entry must be an object' });
      continue;
    }
    if (!spec.destField || typeof spec.destField !== 'string' || !spec.destField.trim()) {
      errors.push({ field: sourceCol, message: 'destField is required' });
      continue;
    }
    const dest = spec.destField.trim();
    if (seenDest.has(dest)) {
      errors.push({
        field: sourceCol,
        message: `Duplicate destination field "${dest}" (also mapped from "${seenDest.get(dest)}")`,
      });
    } else {
      seenDest.set(dest, sourceCol);
    }
    if (spec.type !== undefined && !TYPES.has(spec.type)) {
      errors.push({ field: sourceCol, message: `Invalid type "${spec.type}" (allowed: string, number, boolean, date)` });
    }
    if (availableColumns && !availableColumns.includes(sourceCol)) {
      errors.push({ field: sourceCol, message: `Unknown source column "${sourceCol}"` });
    }
  }

  if (options.requiredFields) {
    for (const req of options.requiredFields) {
      const mapped = [...seenDest.keys()];
      if (!mapped.includes(req)) {
        errors.push({ field: req, message: `Required destination field "${req}" is not mapped` });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateMapping };
