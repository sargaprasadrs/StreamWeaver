const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMB: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
      heapUsedMB: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
    },
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
