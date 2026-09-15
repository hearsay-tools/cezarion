// Temporary Blacksmith investigation: metadata only, never headers or bodies.
const { subscribe } = require('node:diagnostics_channel');
const sockets = new WeakMap();
const requests = new WeakMap();
let lastTick = Date.now();
setInterval(() => { lastTick = Date.now(); }, 100).unref();
const local = request => {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(request.origin).hostname); }
  catch { return false; }
};
subscribe('undici:client:sendHeaders', ({ request, socket }) => {
  if (!local(request)) return;
  const now = Date.now();
  const previous = sockets.get(socket);
  const metadata = {
    pid: process.pid, method: request.method,
    path: request.path.split('?')[0], port: socket.remotePort,
    reused: Boolean(previous), sincePreviousSendMs: previous ? now - previous.sentAt : null,
    eventLoopGapMs: now - lastTick, sentAt: now,
  };
  sockets.set(socket, metadata);
  requests.set(request, metadata);
  if (!previous) socket.once('close', () => {
    const last = sockets.get(socket);
    console.error('[e2e-socket-close]', JSON.stringify({ ...last, afterSendMs: Date.now() - last.sentAt }));
  });
});
subscribe('undici:request:error', ({ request, error }) => {
  if (!local(request)) return;
  console.error('[e2e-fetch-error]', JSON.stringify({ ...requests.get(request), code: error.code, eventLoopGapAtErrorMs: Date.now() - lastTick }));
});
