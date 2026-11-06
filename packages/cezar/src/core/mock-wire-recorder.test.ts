import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const recorder = new URL('../../scripts/mock-wire-recorder.mjs', import.meta.url).href;

describe('optional native wire evidence', () => {
  it('keeps stdout and stderr bytes while recording both channels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wire-recorder-'));
    const file = join(dir, 'wire.ndjson');
    try {
      const script = `const r = await import(${JSON.stringify(recorder)});
        r.installWireRecorder(); process.stdout.write('out\\n'); process.stderr.write('err\\n');`;
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, CEZ_MOCK_WIRE_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(output.toString()).toBe('out\n');
      expect(readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
        { channel: 'stdout', data: 'out\n' }, { channel: 'stderr', data: 'err\n' },
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('records HTTP status, JSON bodies and SSE frames with their channels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wire-http-'));
    const file = join(dir, 'wire.ndjson');
    try {
      const script = `const { createServer } = await import('node:http');
        const r = await import(${JSON.stringify(recorder)});
        const server = createServer((req, res) => {
          r.recordHttpResponse(req, res);
          if (req.url === '/event') {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            res.write('data: hello\\n\\n'); res.end();
          } else { res.writeHead(201); res.end('{"ok":true}'); }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = 'http://127.0.0.1:' + server.address().port;
        await (await fetch(url + '/session')).text();
        await (await fetch(url + '/event')).text();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));`;
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, CEZ_MOCK_WIRE_FILE: file },
      });
      const records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records).toEqual([
        { channel: 'http-response', method: 'GET', path: '/session', status: 201, data: '{"ok":true}' },
        { channel: 'sse', method: 'GET', path: '/event', status: 200, data: 'data: hello\n\n' },
        { channel: 'http-response', method: 'GET', path: '/event', status: 200, data: '' },
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('normalizes repeated identities, timestamps, ports and temporary paths', async () => {
    const { normalizeWire } = await import(recorder) as { normalizeWire(text: string): string };
    const normalized = normalizeWire(JSON.stringify({
      id: 'changing-id', uuid: 'changing-id', created: 1793982000123,
      text: `2026-11-06T12:00:00.123Z http://127.0.0.1:41931 ${tmpdir()}/wire-abc/file pid=1234`,
    }));
    expect(JSON.parse(normalized)).toEqual({
      id: '<id:1>', uuid: '<id:1>', created: '<timestamp>',
      text: '<timestamp> http://127.0.0.1:<port> <tmp> pid=<pid>',
    });
  });
});
