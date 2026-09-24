import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationUpdateConflictError, ApplicationUpdateService, validateInstalledPackage } from './service.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(targetVersion: string | null = '2.0.0') {
  const root = mkdtempSync(join(tmpdir(), 'cez-update-service-')); roots.push(root);
  const prefix = join(root, 'prefix'); const cache = join(root, 'cache'); const home = join(root, 'home');
  const original = join(prefix, 'lib/node_modules/@wjarka/cezarion');
  mkdirSync(join(original, 'dist'), { recursive: true });
  mkdirSync(join(original, 'web/dist'), { recursive: true });
  writeFileSync(join(original, 'dist/index.js'), 'old');
  writeFileSync(join(original, 'web/dist/index.html'), 'old');
  writeFileSync(join(original, 'package.json'), JSON.stringify({ name: '@wjarka/cezarion', version: '1.0.0', bin: { cez: 'dist/index.js' }, engines: { node: '>=20' }, dependencies: {} }));
  const runNpm = vi.fn(async (args: string[], _signal?: AbortSignal) => {
    const stage = args[args.indexOf('--prefix') + 1]!;
    const next = join(stage, 'node_modules/@wjarka/cezarion');
    cpSync(original, next, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(next, 'package.json'), 'utf8'));
    pkg.version = '2.0.0';
    writeFileSync(join(next, 'package.json'), JSON.stringify(pkg));
  });
  const armRestart = vi.fn(async (): Promise<void> => undefined);
  const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original, 'dist/index.js'), npmPrefix: prefix, npmCache: cache, home, targetVersion: () => targetVersion ?? undefined, runNpm, armRestart });
  return { service, runNpm, armRestart, original, root, home };
}

describe('application update preparation', () => {
  it('stages the advertised release and keeps the original unchanged until Restart', async () => {
    const { service, original, runNpm } = fixture();
    expect((await service.apply()).status).toBe('ready');
    expect(JSON.parse(readFileSync(join(original, 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect(service.snapshot().targetVersion).toBe('2.0.0');
    expect(runNpm).toHaveBeenCalledTimes(1);
  });

  it('joins concurrent Apply requests and persists ready state', async () => {
    const { service, runNpm, original, home, root } = fixture();
    await Promise.all([service.apply(), service.apply()]);
    expect(runNpm).toHaveBeenCalledTimes(1);
    const resumed = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original, 'dist/index.js'), npmPrefix: join(root, 'prefix'), npmCache: join(root, 'cache'), home, targetVersion: () => '2.0.0', runNpm });
    expect(resumed.snapshot().status).toBe('ready');
  });

  it('reuses a valid ready preparation after a lost Apply response', async () => {
    const { service, runNpm } = fixture();
    await service.apply();
    expect((await service.apply()).status).toBe('ready');
    expect(runNpm).toHaveBeenCalledTimes(1);
  });

  it('discards cached Restarting when optional state is deleted and lets Apply prepare again', async () => {
    const { service, home, runNpm } = fixture();
    await service.apply();
    await service.restart();
    expect(service.snapshot().status).toBe('restarting');
    const statePath = join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!, 'state.json');
    rmSync(statePath);
    expect(service.snapshot().status).toBe('idle');
    expect((await service.apply()).status).toBe('ready');
    expect(runNpm).toHaveBeenCalledTimes(2);
  });

  it('claims Restart once across separate services for the same installation', async () => {
    const { service, original, root, home, runNpm, armRestart } = fixture();
    await service.apply();
    const other = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original, 'dist/index.js'),
      npmPrefix: join(root, 'prefix'), npmCache: join(root, 'cache'), home, targetVersion: () => '2.0.0', runNpm, armRestart });
    const results = await Promise.allSettled([service.restart(), other.restart()]);
    expect(armRestart).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('releases its durable claim when helper acknowledgement fails', async () => {
    const { service, armRestart } = fixture();
    await service.apply();
    armRestart.mockRejectedValueOnce(new Error('helper exited before acknowledgement'));
    await expect(service.restart()).rejects.toThrow('helper exited');
    expect(service.snapshot().status).toBe('ready');
    expect((await service.restart()).status).toBe('restarting');
    expect(armRestart).toHaveBeenCalledTimes(2);
  });

  it('re-reads a completed preparation after waiting on another service lock', async () => {
    const { service, original, root, home, runNpm } = fixture();
    const install = runNpm.getMockImplementation()!;
    let release!: () => void;
    runNpm.mockImplementationOnce(async (args: string[]) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await install(args);
    });
    const first = service.apply();
    await vi.waitFor(() => expect(service.snapshot().status).toBe('preparing'));
    const other = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original, 'dist/index.js'),
      npmPrefix: join(root, 'prefix'), npmCache: join(root, 'cache'), home, targetVersion: () => '2.0.0', runNpm });
    const second = other.apply();
    release();
    expect((await first).status).toBe('ready');
    expect((await second).status).toBe('ready');
    expect(runNpm).toHaveBeenCalledTimes(1);
  });

  it.each(['null', '42', '[]', '{}', '{"state":null}', '{"state":{"status":"ready","supported":true},"ownerPid":"bad"}'])
  ('salvages malformed optional state %s without breaking boot or health', async (contents) => {
    const { service, original, root, home, runNpm } = fixture();
    await service.apply();
    const statePath = join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!, 'state.json');
    writeFileSync(statePath, contents);
    const resumed = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original, 'dist/index.js'),
      npmPrefix: join(root, 'prefix'), npmCache: join(root, 'cache'), home, targetVersion: () => '2.0.0', runNpm });
    expect(resumed.snapshot().status).toBe('error');
    expect(resumed.snapshot().supported).toBe(true);
  });

  it('expires a live PID preparation whose bounded operation deadline elapsed', async () => {
    const { service, home } = fixture();
    await service.apply();
    const statePath = join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!, 'state.json');
    const record = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(statePath, JSON.stringify({ ...record, state: { status: 'preparing', supported: true, targetVersion: '2.0.0' },
      ownerPid: process.pid, startedAt: Date.now() - 181_000 }));
    expect(service.snapshot().status).toBe('error');
  });

  it('fails preparation when staged version is wrong or web assets are absent', async () => {
    const { service, runNpm } = fixture();
    runNpm.mockImplementationOnce(async (args: string[]) => {
      const next = join(args[args.indexOf('--prefix') + 1]!, 'node_modules/@wjarka/cezarion');
      mkdirSync(join(next, 'dist'), { recursive: true });
      writeFileSync(join(next, 'package.json'), JSON.stringify({ name: '@wjarka/cezarion', version: '1.0.0', bin: { cez: 'dist/index.js' }, dependencies: {} }));
      writeFileSync(join(next, 'dist/index.js'), '');
    });
    await expect(service.apply()).rejects.toThrow();
    expect(service.snapshot().status).toBe('error');
  });

  it('does not run npm without an advertised target', async () => {
    const { service, runNpm } = fixture(null);
    // No valid advertised target: an older or unparseable version cannot be installed.
    await expect(service.apply()).rejects.toThrow();
    expect(runNpm).not.toHaveBeenCalled();
  });

  it('arms only one helper for simultaneous Restart requests', async () => {
    const { service, armRestart } = fixture();
    await service.apply();
    let release!: () => void;
    armRestart.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = service.restart();
    await expect(service.restart()).rejects.toThrow();
    await vi.waitFor(() => expect(armRestart).toHaveBeenCalledTimes(1));
    release();
    expect((await first).status).toBe('restarting');
    expect(armRestart).toHaveBeenCalledTimes(1);
  });

  it('dry run exercises Ready and Restarting from a source checkout without npm or process exit', async () => {
    const { root, home, original } = fixture();
    const runNpm = vi.fn(async () => undefined);
    const armRestart = vi.fn(async () => undefined);
    const handoff = vi.fn();
    const service = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(root, 'source/cli.js'),
      npmPrefix: join(root, 'other-prefix'), npmCache: join(root, 'cache'), home, targetVersion: () => '2.0.0',
      runNpm, armRestart, handoff, dryRun: true });
    expect((await service.apply()).status).toBe('ready');
    expect((await service.restart()).status).toBe('restarting');
    service.afterResponse();
    expect(service.snapshot().status).toBe('idle');
    expect(runNpm).not.toHaveBeenCalled();
    expect(armRestart).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
  });

  it('does not expose or use tampered persisted paths and messages', async () => {
    const { service, original, root, home, runNpm } = fixture();
    await service.apply();
    const statePath = join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!, 'state.json');
    const stored = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(statePath, JSON.stringify({ ...stored,
      state: { status: 'ready', supported: true, targetVersion: '2.0.0', message: '/private/token' },
      recovery: '/tmp/other-recovery' }));
    const resumed = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original, 'dist/index.js'),
      npmPrefix: join(root, 'prefix'), npmCache: join(root, 'cache'), home, targetVersion: () => '2.0.0', runNpm });
    expect(resumed.snapshot().status).toBe('error');
    expect(JSON.stringify(resumed.snapshot())).not.toContain('/private/token');
    await expect(resumed.restart()).rejects.toThrow();
  });

  it('refuses a non-writable original before invoking npm', async () => {
    const { service, original, runNpm } = fixture();
    chmodSync(original, 0o555);
    try {
      await expect(service.apply()).rejects.toThrow();
      expect(runNpm).not.toHaveBeenCalled();
      expect(service.snapshot().status).toBe('error');
    } finally { chmodSync(original, 0o755); }
  });

  it('rejects a staged web shell whose referenced assets are missing', () => {
    const { original } = fixture();
    const manifest = JSON.parse(readFileSync(join(original, 'package.json'), 'utf8')) as Record<string, unknown>;
    manifest.version = '2.0.0';
    writeFileSync(join(original, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(original, 'web/dist/index.html'), '<script src="/assets/missing.js"></script>');
    expect(() => validateInstalledPackage(original, '2.0.0')).toThrow();
  });

  it('rejects a staged package whose declared runtime dependency is missing', () => {
    const { original } = fixture();
    const manifest = JSON.parse(readFileSync(join(original, 'package.json'), 'utf8')) as Record<string, unknown>;
    manifest.version = '2.0.0'; manifest.dependencies = { 'absent-runtime': '^1.0.0' };
    writeFileSync(join(original, 'package.json'), JSON.stringify(manifest));
    expect(() => validateInstalledPackage(original, '2.0.0')).toThrow('runtime dependencies incomplete');
  });

  it('invalidates Ready when staged package is replaced before Restart', async () => {
    const { service, home, armRestart } = fixture();
    await service.apply();
    const statePath = join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!, 'state.json');
    const record = JSON.parse(readFileSync(statePath, 'utf8')) as { stage: string };
    const staged = join(record.stage, 'node_modules/@wjarka/cezarion/package.json');
    const pkg = JSON.parse(readFileSync(staged, 'utf8')) as Record<string, unknown>;
    pkg.version = '9.9.9'; writeFileSync(staged, JSON.stringify(pkg));
    expect(service.snapshot().status).toBe('error');
    await expect(service.restart()).rejects.toThrow();
    expect(armRestart).not.toHaveBeenCalled();
  });

  it('reports an unwritable update home without running npm', async () => {
    const { service, home, runNpm } = fixture();
    writeFileSync(home, 'blocked');
    await expect(service.apply()).rejects.toThrow('Update storage is not writable');
    expect(runNpm).not.toHaveBeenCalled();
  });

  it('does not overwrite another process’s in-progress update after lock contention', async () => {
    const { service, original, root, home, runNpm } = fixture();
    const install = runNpm.getMockImplementation()!;
    let release!: () => void;
    runNpm.mockImplementationOnce(async (args: string[]) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await install(args);
    });
    const first = service.apply();
    await vi.waitFor(() => expect(service.snapshot().status).toBe('preparing'));
    const other = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original, 'dist/index.js'),
      npmPrefix: join(root, 'prefix'), npmCache: join(root, 'cache'), home, targetVersion: () => '2.0.0',
      runNpm, lockWaitMs: 50 });
    await expect(other.apply()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    release();
    expect((await first).status).toBe('ready');
    expect(other.snapshot().status).toBe('ready');
  }, 20_000);

  it('aborts active staging after lock loss and exposes a retryable state', async () => {
    const { service, home, runNpm } = fixture();
    runNpm.mockImplementationOnce(async (_args, signal) => {
      const updateDir = join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!);
      const lock = join(updateDir, 'operation.lock');
      rmSync(lock, { recursive: true }); mkdirSync(lock);
      const { utimesSync } = await import('node:fs');
      utimesSync(lock, 1, 1);
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    });
    await expect(service.apply()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    expect(service.snapshot().status).toBe('error');
  }, 4000);

  it('does not overwrite a foreign state record when npm times out after lock loss', async () => {
    const { service, home, runNpm } = fixture();
    const foreign = JSON.stringify({ foreignOwner: true });
    let statePath = '';
    runNpm.mockImplementationOnce(async (_args, signal) => {
      const updateDir = join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!);
      statePath = join(updateDir, 'state.json');
      const lock = join(updateDir, 'operation.lock');
      const { renameSync, utimesSync } = await import('node:fs');
      renameSync(lock, join(updateDir, 'stolen-lock')); mkdirSync(lock); utimesSync(lock, 1, 1);
      writeFileSync(statePath, foreign);
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('npm operation timed out');
    });
    const result = await service.apply().catch((error: unknown) => error);
    expect(readFileSync(statePath, 'utf8')).toBe(foreign);
    expect(result).toBeInstanceOf(ApplicationUpdateConflictError);
  }, 4000);

  it('persists an ordinary npm timeout as a recoverable error while retaining the lock', async () => {
    const { service, runNpm } = fixture();
    runNpm.mockRejectedValueOnce(new Error('npm operation timed out'));
    await expect(service.apply()).rejects.toThrow('Application update preparation failed');
    expect(service.snapshot().status).toBe('error');
  });
});
