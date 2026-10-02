import { describe, expect, it } from 'vitest';
import {
  previewClientMessageSchema,
  previewResultCodeSchema,
  previewServeRequestSchema,
  previewServeResultSchema,
  previewServerMessageSchema,
  previewServerSchema,
  previewServerStateSchema,
} from './preview.ts';

const SPEC_EXAMPLE = {
  command: 'npm run dev -- --port 5173 --strictPort --host 127.0.0.1',
  port: 5173,
  cwd: 'apps/web',
  label: 'web',
  path: '/members',
};

describe('previewServeRequestSchema', () => {
  it("accepts the spec's example", () => {
    expect(previewServeRequestSchema.parse(SPEC_EXAMPLE)).toEqual(SPEC_EXAMPLE);
  });

  it('needs only a command and a port', () => {
    expect(previewServeRequestSchema.safeParse({ command: 'vite', port: 5173 }).success).toBe(true);
  });

  it.each([
    ['port 0', { ...SPEC_EXAMPLE, port: 0 }],
    ['port 65536', { ...SPEC_EXAMPLE, port: 65536 }],
    ['a fractional port', { ...SPEC_EXAMPLE, port: 5173.5 }],
    ['a string port', { ...SPEC_EXAMPLE, port: '5173abc' }],
    ['an empty command', { ...SPEC_EXAMPLE, command: '' }],
    ['a 1025-char command', { ...SPEC_EXAMPLE, command: 'x'.repeat(1025) }],
    ['an empty label', { ...SPEC_EXAMPLE, label: '' }],
    ['a 49-char label', { ...SPEC_EXAMPLE, label: 'x'.repeat(49) }],
    ['a path without a leading slash', { ...SPEC_EXAMPLE, path: 'members' }],
  ])('rejects %s', (_name, body) => {
    expect(previewServeRequestSchema.safeParse(body).success).toBe(false);
  });

  it('accepts the 1024-char command and the 48-char label limits', () => {
    expect(previewServeRequestSchema.safeParse({ command: 'x'.repeat(1024), port: 1, label: 'y'.repeat(48) }).success).toBe(true);
    expect(previewServeRequestSchema.safeParse({ command: 'x', port: 65535 }).success).toBe(true);
  });
});

describe('previewServeResultSchema', () => {
  it('carries a recovery hint with every result code', () => {
    for (const code of previewResultCodeSchema.options) {
      expect(previewServeResultSchema.safeParse({ ok: code === 'registered' || code === 'replaced', code, message: 'm', hint: 'h' }).success).toBe(true);
    }
    expect(previewServeResultSchema.safeParse({ ok: true, code: 'registered', message: 'm' }).success).toBe(false);
  });

  it('names exactly the spec codes', () => {
    expect([...previewResultCodeSchema.options].sort()).toEqual([
      'cezar_port', 'cwd_outside_worktree', 'headless', 'invalid_input', 'port_held', 'preview_disabled',
      'registered', 'replaced', 'too_many', 'unavailable', 'worktree_missing',
    ]);
  });
});

describe('previewServerSchema', () => {
  const server = { port: 5173, command: 'vite', label: 'vite', registeredAt: '2026-10-02T10:00:00.000Z', answeredAtRegistration: false };

  it('parses a registration with the optional cwd and path left out', () => {
    expect(previewServerSchema.parse(server)).toEqual(server);
  });

  it('rejects a registration without answeredAtRegistration', () => {
    const { answeredAtRegistration: _drop, ...rest } = server;
    expect(previewServerSchema.safeParse(rest).success).toBe(false);
  });
});

describe('previewServerStateSchema', () => {
  it('lists the eight states', () => {
    expect([...previewServerStateSchema.options]).toEqual(['registered', 'starting', 'up', 'stalled', 'exited', 'stopped', 'adopted', 'unavailable']);
  });
});

describe('previewClientMessageSchema', () => {
  it.each([
    [{ t: 'open', target: { port: 5173 } }],
    [{ t: 'open', target: { url: 'http://localhost:5173/x' } }],
    [{ t: 'run', port: 5173 }],
    [{ t: 'stop', port: 5173 }],
    [{ t: 'keepWaiting', port: 5173 }],
    [{ t: 'resize', w: 390, h: 844 }],
    [{ t: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 }],
    [{ t: 'mouse', type: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: 120 }],
    [{ t: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', modifiers: 0, vk: 65, commands: ['selectAll'] }],
    [{ t: 'insertText', text: 'héllo' }],
    [{ t: 'nav', url: 'localhost:5173' }],
    [{ t: 'back' }],
    [{ t: 'forward' }],
    [{ t: 'reload' }],
    [{ t: 'reload', ignoreCache: true }],
    [{ t: 'dialogResult', accept: true, text: 'x' }],
    [{ t: 'ack' }],
    [{ t: 'ping', ts: 1 }],
    [{ t: 'download' }],
    [{ t: 'cancelDownload' }],
    [{ t: 'retryBrowser' }],
  ])('accepts %j', (message) => {
    expect(previewClientMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each([
    ['an unknown message type', { t: 'eval', expression: '1' }],
    ['an unknown mouse type', { t: 'mouse', type: 'mouseTeleport', x: 1, y: 1 }],
    ['an unknown key type', { t: 'key', type: 'char', key: 'a' }],
    ['an unknown mouse button', { t: 'mouse', type: 'mousePressed', x: 1, y: 1, button: 'back' }],
    ['an open with neither port nor url', { t: 'open', target: {} }],
    ['a port outside 1..65535', { t: 'run', port: 0 }],
    ['a non-numeric coordinate', { t: 'mouse', type: 'mouseMoved', x: 'a', y: 1 }],
    ['a missing t', { port: 5173 }],
  ])('rejects %s', (_name, message) => {
    expect(previewClientMessageSchema.safeParse(message).success).toBe(false);
  });

  it('clamps resize to 100..4000', () => {
    expect(previewClientMessageSchema.parse({ t: 'resize', w: 5, h: 99999 })).toEqual({ t: 'resize', w: 100, h: 4000 });
    expect(previewClientMessageSchema.parse({ t: 'resize', w: 1440, h: 900 })).toEqual({ t: 'resize', w: 1440, h: 900 });
  });
});

describe('previewServerMessageSchema', () => {
  const server = { port: 5173, command: 'vite', label: 'vite', registeredAt: '2026-10-02T10:00:00.000Z', answeredAtRegistration: false };

  it.each([
    [{ t: 'state', stage: 'chromium-missing', installCommand: 'sudo apt install chromium', canDownload: false }],
    [{ t: 'state', stage: 'downloading', received: 10, total: 100 }],
    [{ t: 'state', stage: 'download-failed', error: 'offline', installCommand: 'brew install chromium' }],
    [{ t: 'state', stage: 'sandbox-failed', stderrTail: 'No usable sandbox' }],
    [{ t: 'state', stage: 'browser-exited', stderrTail: '', serverUp: true }],
    [{ t: 'state', stage: 'browser-exited', signal: 'SIGKILL', stderrTail: '', serverUp: false }],
    [{ t: 'state', stage: 'needs-approval', server, wasRunning: false }],
    [{ t: 'state', stage: 'server-starting', server, attempt: 3, startedAt: '2026-10-02T10:00:00.000Z', logTail: ['> vite', 'building deps'] }],
    [{ t: 'state', stage: 'server-starting', server, attempt: 0, startedAt: '2026-10-02T10:00:00.000Z', logTail: [] }],
    [{ t: 'state', stage: 'server-stalled', server, logTail: 'waiting' }],
    [{ t: 'state', stage: 'server-exited', server, exitCode: 1, logTail: 'boom' }],
    [{ t: 'state', stage: 'server-exited', server, exitCode: null, logTail: '' }],
    [{ t: 'state', stage: 'server-stopped', server, reason: 'idle', lastUrl: 'http://localhost:5173/' }],
    [{ t: 'state', stage: 'worktree-removed' }],
    [{ t: 'state', stage: 'worktree-removed', server }],
    [{ t: 'state', stage: 'loading', step: 'frame' }],
    [{ t: 'state', stage: 'streaming', adopted: true }],
    [{ t: 'url', url: 'http://localhost:5173/' }],
    [{ t: 'cursor', cursor: 'pointer' }],
    [{ t: 'dialog', type: 'prompt', message: 'name?', defaultPrompt: 'x', origin: 'http://localhost:5173' }],
    [{ t: 'replaced', by: 'tab-2' }],
    [{ t: 'pong', ts: 1 }],
    [{ t: 'downloadProgress', received: 1, total: 2 }],
  ])('accepts %j', (message) => {
    expect(previewServerMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each([
    ['an unknown state stage', { t: 'state', stage: 'connection-lost' }],
    ['an unknown loading step', { t: 'state', stage: 'loading', step: 'dns' }],
    ['an unknown stop reason', { t: 'state', stage: 'server-stopped', server, reason: 'crash', lastUrl: '' }],
    ['a starting state without its log tail', { t: 'state', stage: 'server-starting', server, attempt: 1, startedAt: '2026-10-02T10:00:00.000Z' }],
    ['an unknown message type', { t: 'cdp', method: 'Runtime.evaluate' }],
  ])('rejects %s', (_name, message) => {
    expect(previewServerMessageSchema.safeParse(message).success).toBe(false);
  });
});
