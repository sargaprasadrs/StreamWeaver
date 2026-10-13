const { WebSocketServer } = require('ws');

const THROTTLE_MS = 500;

/**
 * WebSocket progress broker.
 *
 * Clients connect to `/ws/progress?jobId=<id>` (or `jobId=all` to watch
 * everything). The broker groups sockets into rooms per job, broadcasts
 * throttled progress frames (at most one every 500ms per job) and
 * un-throttled terminal frames.
 */
function createProgressBroker(server) {
  const wss = new WebSocketServer({ server, path: '/ws/progress' });
  const rooms = new Map(); // jobId -> Set<ws>
  const lastEmit = new Map(); // jobId -> timestamp

  function join(jobId, ws) {
    if (!rooms.has(jobId)) rooms.set(jobId, new Set());
    rooms.get(jobId).add(ws);
    if (jobId !== 'all') {
      if (!rooms.has('all')) rooms.set('all', new Set());
      rooms.get('all').add(ws);
    }
  }

  function leave(jobId, ws) {
    const set = rooms.get(jobId);
    if (set) set.delete(ws);
    if (jobId !== 'all') {
      const all = rooms.get('all');
      if (all) all.delete(ws);
    }
  }

  function broadcast(jobId, payload) {
    const frame = JSON.stringify(payload);
    const targets = new Set([...(rooms.get(jobId) || []), ...(rooms.get('all') || [])]);
    for (const ws of targets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(frame);
      }
    }
  }

  wss.on('connection', (ws, req) => {
    let jobId = 'all';
    try {
      const url = new URL(req.url, 'http://localhost');
      jobId = url.searchParams.get('jobId') || 'all';
    } catch {
      // keep default
    }
    ws.jobId = jobId;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    join(jobId, ws);
    ws.send(JSON.stringify({ type: 'subscribed', jobId }));

    ws.on('close', () => leave(jobId, ws));
    ws.on('error', () => leave(jobId, ws));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }
  }, 30000);

  /**
   * Emit a progress frame for a job. Throttled to one frame per 500ms
   * unless `force` is set (used for terminal/completed frames).
   */
  function emitProgress(jobId, payload, { force = false } = {}) {
    const now = Date.now();
    const last = lastEmit.get(jobId) || 0;
    if (!force && now - last < THROTTLE_MS) return false;
    lastEmit.set(jobId, now);
    broadcast(jobId, { jobId, ...payload });
    return true;
  }

  function emitTerminal(jobId, payload) {
    lastEmit.set(jobId, Date.now());
    broadcast(jobId, { jobId, terminal: true, ...payload });
  }

  function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => wss.close(resolve));
  }

  return { wss, emitProgress, emitTerminal, close, rooms };
}

module.exports = { createProgressBroker, THROTTLE_MS };
