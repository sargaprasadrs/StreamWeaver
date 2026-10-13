const os = require('node:os');
const path = require('node:path');

// Test environment must be set before any module (notably src/config.js) is
// required, otherwise defaults get cached and the env overrides are ignored.
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `sw-test-${Date.now()}`);
process.env.OUTPUT_DIR = path.join(os.tmpdir(), `sw-out-${Date.now()}`);
process.env.MAX_UPLOAD_BYTES = String(1024 * 1024);
process.env.SAMPLE_ROW_LIMIT = '1000';
process.env.MONGODB_URI = '';
