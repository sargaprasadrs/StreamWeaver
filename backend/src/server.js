const http = require('node:http');
const fs = require('node:fs');
const express = require('express');
const config = require('./config');
const healthRouter = require('./routes/health');
const uploadsRouter = require('./routes/uploads').router;
const jobsRouter = require('./routes/jobs');
const { initDb } = require('./db');
const { createProgressBroker } = require('./websocket/progressBroker');

/** Make sure the runtime working directories exist before first request. */
function ensureDirectories() {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.mkdirSync(config.outputDir, { recursive: true });
}

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // The WebSocket broker is attached to the HTTP server in createServer();
  // routes reach it through app.locals (null in unit tests).
  app.locals.progressBroker = null;

  app.use('/api/health', healthRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/jobs', jobsRouter);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler: no stack traces leak to clients
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
      console.error('[error]', err.message);
    }
    res.status(status).json({ error: err.expose ? err.message : 'Internal server error' });
  });

  return app;
}

/**
 * Wrap the Express app in an HTTP server and attach the WebSocket
 * progress broker. Returns both so callers can close the broker cleanly.
 */
function createServer(app) {
  ensureDirectories();
  const server = http.createServer(app);
  const broker = createProgressBroker(server);
  app.locals.progressBroker = broker;
  server.on('close', () => {
    broker.close().catch(() => {});
  });
  return { server, broker };
}

async function main() {
  ensureDirectories();
  await initDb();

  const app = createApp();
  const { server } = createServer(app);
  server.listen(config.port, () => {
    console.log(`StreamWeaver backend listening on http://localhost:${config.port}`);
    console.log(`WebSocket progress broker at ws://localhost:${config.port}/ws/progress?jobId=<id>`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { createApp, createServer, main };
