import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolveCodexExecutable } from './codex-app-server-transport.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { OmpRunner } from './omp-runner.ts';

afterEach(() => vi.unstubAllEnvs());
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
