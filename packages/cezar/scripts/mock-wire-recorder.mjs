// Optional wire evidence. Imported only by mocks with CEZ_MOCK_WIRE_FILE set.
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const file = process.env.CEZ_MOCK_WIRE_FILE;
const identities = new Map();
function identity(value) {
  if (!identities.has(value)) identities.set(value, `<id:${identities.size + 1}>`);
  return identities.get(value);
}

/** Keep content and frame boundaries; replace process-local values consistently. */
export function normalizeWire(text) {
  return text
    .replaceAll(process.cwd(), '<cwd>')
    .replace(new RegExp(`${tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^\\s"'<>]+`, 'g'), '<tmp>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, identity)
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/("(?:id|uuid|session_id|sessionID|threadId|turnId|messageID|parentID|call_id|itemId)"\s*:\s*)"([^"]+)"/g,
      (_, prefix, value) => `${prefix}"${identity(value)}"`)
    .replace(/("(?:timestamp|created|updated|start|end)"\s*:\s*)\d{10,}/g, '$1"<timestamp>"')
    .replace(/(127\.0\.0\.1:|localhost:)\d+/g, '$1<port>')
    .replace(/(\/session\/)([^/?\s"']+)/g, (_, prefix, value) => prefix + identity(value))
    .replace(/\bpid[=: ]+\d+/gi, 'pid=<pid>');
}

export function recordWire(channel, data, metadata = {}) {
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ channel, ...metadata, data: normalizeWire(String(data)) })}\n`);
}

/** Capture all stream writes, including help, probes and shutdown diagnostics. */
export function installWireRecorder() {
  for (const channel of ['stdout', 'stderr']) {
    const stream = process[channel];
    const write = stream.write;
    stream.write = function (chunk, ...args) {
      recordWire(channel, Buffer.isBuffer(chunk) ? chunk.toString() : chunk);
      return write.call(this, chunk, ...args);
    };
  }
}

/** Record HTTP status and body without changing flush or completion timing. */
export function recordHttpResponse(req, res) {
  const metadata = () => ({ method: req.method, path: normalizeWire(req.url ?? ''), status: res.statusCode });
  const write = res.write;
  const end = res.end;
  res.write = function (chunk, ...args) {
    recordWire(res.getHeader('content-type') === 'text/event-stream' ? 'sse' : 'http-body', chunk, metadata());
    return write.call(this, chunk, ...args);
  };
  res.end = function (chunk, ...args) {
    recordWire('http-response', chunk ?? '', metadata());
    return end.call(this, chunk, ...args);
  };
}
