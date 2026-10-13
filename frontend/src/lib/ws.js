/**
 * WebSocket client for the live-progress broker with exponential-backoff
 * reconnect. Returns an unsubscribe function.
 *
 * @param {string} jobId
 * @param {(msg: object) => void} onMessage
 * @param {object} [opts]
 * @param {(status: string) => void} [opts.onStatus] connection status changes
 * @returns {() => void} unsubscribe/close
 */
export function subscribeProgress(jobId, onMessage, { onStatus } = {}) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let timer = null;

  const url = () => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws/progress?jobId=${encodeURIComponent(jobId)}`;
  };

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url());
    ws.onopen = () => {
      attempt = 0;
      if (onStatus) onStatus('open');
    };
    ws.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (closed) return;
      if (onStatus) onStatus('closed');
      timer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 10000));
      attempt += 1;
    };
    ws.onerror = () => {
      if (ws) ws.close();
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (ws) ws.close();
  };
}
