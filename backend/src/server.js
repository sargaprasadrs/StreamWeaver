const express = require('express');
const config = require('./config');
const healthRouter = require('./routes/health');
const uploadsRouter = require('./routes/uploads').router;
const { initDb } = require('./db');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/health', healthRouter);
  app.use('/api/uploads', uploadsRouter);

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

async function main() {
  await initDb();

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`StreamWeaver backend listening on http://localhost:${config.port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { createApp, main };
