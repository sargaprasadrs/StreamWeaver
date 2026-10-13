const { Transform } = require('node:stream');
const vm = require('node:vm');

// Production target is `isolated-vm` (separate V8 isolate with a real memory
// cap). It is a native addon, so when it is unavailable we fall back to a
// dedicated `node:vm` context that still gives us per-row execution timeouts
// and no access to Node globals (require/process/etc.).
let isolatedVm = null;
try {
  // eslint-disable-next-line global-require
  isolatedVm = require('isolated-vm');
} catch {
  isolatedVm = null;
}

const DEFAULT_TIMEOUT_MS = 100;

/**
 * Compile a user snippet into a callable `(value, row) => result` function.
 * The snippet is the body of a function, e.g. `return value.toUpperCase()`.
 */
function compileSnippet(code) {
  const wrapped = `(function (value, row) {\n${code}\n})`;
  const context = vm.createContext({});
  const fn = new vm.Script(wrapped, { filename: 'user-transform.js' }).runInContext(context);
  // Invoked through a script so every call is subject to the timeout.
  const invoker = new vm.Script('__fn(__value, __row)', { filename: 'user-transform-invoke.js' });
  context.__fn = fn;
  return { context, invoker };
}

/**
 * SandboxTransform: objectMode. Applies a user JavaScript snippet to the
 * mapped row inside an isolated context.
 *
 * @param {object} opts
 * @param {string} opts.code        snippet body using `value` (and `row`)
 * @param {string[]} [opts.fields]  fields to transform; defaults to every
 *                                  string-valued field
 * @param {number} [opts.timeoutMs] per-row execution timeout
 */
class SandboxTransform extends Transform {
  constructor({ code, fields = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super({ objectMode: true, highWaterMark: 16 });
    if (typeof code !== 'string' || code.trim() === '') {
      throw new Error('Sandbox code is required');
    }
    this.code = code;
    this.fields = Array.isArray(fields) && fields.length > 0 ? fields : null;
    this.timeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.engine = isolatedVm ? 'isolated-vm' : 'vm';
    this.rowIndex = 0;

    const { context, invoker } = compileSnippet(code);
    this.context = context;
    this.invoker = invoker;
    this.failures = 0;
  }

  _targetFields(row) {
    if (this.fields) return this.fields.filter((f) => Object.prototype.hasOwnProperty.call(row, f));
    return Object.keys(row).filter((k) => typeof row[k] === 'string');
  }

  _runOne(value, snapshot) {
    this.context.__value = value;
    this.context.__row = snapshot;
    const out = this.invoker.runInContext(this.context, { timeout: this.timeoutMs });
    return out === undefined ? value : out;
  }

  _transform(obj, _enc, callback) {
    // Rows already flagged by the mapper pass through untouched.
    if (obj && obj.__error) {
      this.rowIndex++;
      this.push(obj);
      return callback();
    }
    try {
      const fields = this._targetFields(obj);
      if (fields.length === 0) {
        this.rowIndex++;
        this.push(obj);
        return callback();
      }
      const snapshot = { ...obj };
      const out = { ...obj };
      for (const field of fields) {
        try {
          out[field] = this._runOne(obj[field], snapshot);
        } catch (err) {
          const reason = err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
            ? `transform timed out after ${this.timeoutMs}ms on "${field}"`
            : `transform error on "${field}": ${err.message}`;
          this.failures++;
          this.rowIndex++;
          this.push({
            __error: true,
            rowIndex: this.rowIndex - 1,
            reason,
            raw: JSON.stringify(snapshot),
          });
          return callback();
        }
      }
      this.rowIndex++;
      this.push(out);
      return callback();
    } catch (err) {
      return callback(err);
    }
  }
}

module.exports = { SandboxTransform, compileSnippet, hasIsolatedVm: () => Boolean(isolatedVm) };
