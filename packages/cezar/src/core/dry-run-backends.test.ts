import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexExecutable } from './codex-app-server-transport.ts';
import { driveSeam } from './harness-parity.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { OmpRunner } from './omp-runner.ts';
import { createRunner } from './runner-factory.ts';
import { CursorRunner } from './cursor-runner.ts';

afterEach(() => vi.unstubAllEnvs());
it('uses bundled Cursor print for a fresh dry run and ACP for a legacy session', async () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_CURSOR_BIN', undefined);
  const dir = mkdtempSync(join(tmpdir(), 'cez-dry-cursor-'));
  try {
    expect(createRunner('cursor')).toBeInstanceOf(CursorRunner);
    const events: Array<{ type: string; sessionTransport?: string }> = [];
    await createRunner('cursor').run({ cwd: dir, userPrompt: 'hello' }, event => events.push(event));
    expect(events.find(event => event.type === 'session')?.sessionTransport).toBe('cursor-print');
    expect(createRunner('cursor', { sessionTransport: 'cursor-acp' })).toBeInstanceOf(CursorRunner);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('selects bundled Codex, OpenCode and OMP mocks in dry runs without host binaries', () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_CODEX_BIN', undefined);
  vi.stubEnv('CEZ_OPENCODE_BIN', undefined);
  vi.stubEnv('CEZ_OMP_BIN', undefined);
  const codex = resolveCodexExecutable();
  const opencode = (new OpencodeServerRunner() as unknown as { bin: string }).bin;
  const omp = (new OmpRunner() as unknown as { bin: string }).bin;
  expect(codex).toMatch(/scripts\/mock-codex-app-server\.mjs$/);
  expect(opencode).toMatch(/scripts\/mock-opencode-serve\.mjs$/);
  expect(omp).toMatch(/scripts\/mock-omp-rpc\.mjs$/);
  expect(existsSync(codex)).toBe(true);
  expect(existsSync(opencode)).toBe(true);
  expect(existsSync(omp)).toBe(true);
});
it('preserves explicit binary overrides during dry runs', () => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_CODEX_BIN', '/configured/codex');
  vi.stubEnv('CEZ_OPENCODE_BIN', '/configured/opencode');
  vi.stubEnv('CEZ_OMP_BIN', '/configured/omp');
  expect(resolveCodexExecutable()).toBe('/configured/codex');
  expect(resolveCodexExecutable('/explicit/codex')).toBe('/explicit/codex');
  expect((new OpencodeServerRunner() as unknown as { bin: string }).bin).toBe('/configured/opencode');
  expect((new OpencodeServerRunner({ bin: '/explicit/opencode' }) as unknown as { bin: string }).bin).toBe('/explicit/opencode');
  expect((new OmpRunner() as unknown as { bin: string }).bin).toBe('/configured/omp');
  expect((new OmpRunner({ bin: '/explicit/omp' }) as unknown as { bin: string }).bin).toBe('/explicit/omp');
});
it('dry-run OpenCode Continue in the same cwd resumes without CEZ_MOCK_ARGS_FILE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cez-dry-opencode-cwd-'));
  const store = join(tmpdir(), `cez-mock-opencode-sessions-${createHash('sha256').update(dir).digest('hex')}.json`);
  try {
    const first = await driveSeam('opencode', 'baseline', { spec: { cwd: dir } });
    expect(first.v1.filter(event => event.type === 'error')).toEqual([]);
    const session = first.v1.find(event => event.type === 'session');
    expect(session).toEqual(expect.objectContaining({ type: 'session', sessionId: expect.stringMatching(/^ses_mock_/) }));
    const sessionId = (session as { sessionId: string }).sessionId;
    const second = await driveSeam('opencode', 'baseline', {
      spec: { cwd: dir, resume: true, sessionId },
    });
    expect(second.v1.filter(event => event.type === 'error')).toEqual([]);
    expect(second.v1.filter(event => event.type === 'note' && String(event.message).includes('no longer exists'))).toEqual([]);
    expect(second.v1.find(event => event.type === 'session')).toEqual(expect.objectContaining({ sessionId }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(store, { force: true });
  }
}, 30_000);
