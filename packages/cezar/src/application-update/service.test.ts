import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationUpdateConflictError, ApplicationUpdateFailureError, ApplicationUpdateService, validateInstalledPackage, type ApplicationUpdateOptions, type RestartPlan } from './service.ts';
import { runOwnedNpm } from './npm-process.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, access: vi.fn(original.access), writeFile: vi.fn(original.writeFile) };
});
vi.mock('./npm-process.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./npm-process.ts')>(), runOwnedNpm: vi.fn(),
}));

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.mocked(access).mockReset(); vi.mocked(writeFile).mockReset(); vi.mocked(runOwnedNpm).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(targetVersion: string | null = '2.0.0', overrides: Partial<ApplicationUpdateOptions> = {}, omit: ('runNpm' | 'armRestart')[] = []) {
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
  const armRestart = vi.fn(async (_plan: RestartPlan): Promise<void> => undefined);
  const options: ApplicationUpdateOptions = { packageRoot: original, launchEntry: join(original, 'dist/index.js'), npmPrefix: prefix, npmCache: cache, home, targetVersion: () => targetVersion ?? undefined, runNpm, armRestart, ...overrides };
  for (const hook of omit) delete options[hook];
  const service = new ApplicationUpdateService(options);
  const statePath = () => join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!, 'state.json');
  return { service, runNpm, armRestart, original, root, home, options, statePath };
}

function changeManifest(path: string, changes: Record<string, unknown>): void {
  const manifestPath = join(path, 'package.json');
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), ...changes }));
}

describe('installed package validation', () => {
  it.each([
    { name: 'other-package' }, { version: '9.9.9' }, { bin: undefined }, { bin: { cez: 'other.js' } },
    { dependencies: undefined }, { dependencies: 'invalid' }, { engines: { node: '^24' } },
  ])('rejects an invalid manifest field %j', (changes) => {
    const { original } = fixture();
    changeManifest(original, changes);
    expect(() => validateInstalledPackage(original, '1.0.0')).toThrow();
  });

  it.each(['dist/index.js', 'web/dist/index.html'])('requires the installed asset %s', (asset) => {
    const { original } = fixture();
    rmSync(join(original, asset));
    expect(() => validateInstalledPackage(original, '1.0.0')).toThrow('assets incomplete');
  });

  it('accepts referenced assets and dependencies at package and installation levels', () => {
    const { original, root } = fixture();
    changeManifest(original, { dependencies: { local: '1', hoisted: '1' }, engines: undefined });
    mkdirSync(join(original, 'node_modules/local'), { recursive: true });
    mkdirSync(join(root, 'prefix/node_modules/hoisted'), { recursive: true });
    mkdirSync(join(original, 'web/dist/assets'), { recursive: true });
    writeFileSync(join(original, 'web/dist/assets/app.js'), 'app');
    writeFileSync(join(original, 'web/dist/assets/app.css'), 'styles');
    writeFileSync(join(original, 'web/dist/index.html'), '<script src="/assets/app.js"></script><link href=\'/assets/app.css\'>');
    expect(() => validateInstalledPackage(original, '1.0.0', join(root, 'prefix'))).not.toThrow();
  });

  it('does not use dependencies from outside the installation', () => {
    const { original, root } = fixture();
    changeManifest(original, { dependencies: { external: '1' } });
    mkdirSync(join(root, 'node_modules/external'), { recursive: true });
    expect(() => validateInstalledPackage(original, '1.0.0', join(root, 'prefix'))).toThrow('runtime dependencies incomplete');
  });

  it('rejects parent traversal even when the referenced file exists', () => {
    const { original } = fixture();
    writeFileSync(join(original, 'web/dist/escape.js'), 'outside assets');
    writeFileSync(join(original, 'web/dist/index.html'), '<script src="/assets/../escape.js"></script>');
    expect(() => validateInstalledPackage(original, '1.0.0')).toThrow('web assets incomplete');
  });
});

describe('persisted application update state', () => {
  it.each(['Update this installation manually.', 'Update was interrupted. Retry Update.',
    'Prepared update is missing. Retry Update.', 'Preparation failed. Retry Update or update manually.',
    'Update failed; previous release was restored. Retry Update.',
    'Update and recovery failed. Reinstall cezarion manually.', 'Update state needs retry.'])
  ('retains the safe recovery message %s', async (message) => {
    const f = fixture();
    await f.service.apply();
    const state = { status: 'error', supported: true, targetVersion: '2.0.0', message };
    writeFileSync(f.statePath(), JSON.stringify({ state }));
    expect(f.service.snapshot()).toEqual(state);
  });

  it.each(['2.0.0', '12.34.56', '2.0.0-beta.1-A', '2.0.0-Z', '2.0.0-a', '2.0.0-9'])('retains valid advertised version %s', async (targetVersion) => {
    const f = fixture();
    await f.service.apply();
    const state = { status: 'idle', supported: true, targetVersion };
    writeFileSync(f.statePath(), JSON.stringify({ state }));
    expect(f.service.snapshot()).toEqual(state);
  });

  it.each(['.0.0', '2..0', '2.0.', 'a.0.0', '2.a.0', '2.0.a', '2x0.0', '2.0x0',
    'x2.0.0', '2.0.0x', '2.0.0-', '2.0.0-foo_bar', '2.0.0-foo bar', '2.0.0-é'])
  ('rejects invalid persisted version %s', async (targetVersion) => {
    const f = fixture();
    await f.service.apply();
    writeFileSync(f.statePath(), JSON.stringify({ state: { status: 'idle', supported: true, targetVersion } }));
    expect(f.service.snapshot().message).toBe('Update state needs retry.');
  });

  it.each([
    { state: { status: 'idle', supported: false } },
    { state: { status: 'idle', supported: true, message: 'untrusted message' } },
    { state: { status: 'idle', supported: true, targetVersion: '2.0.0; command' } },
    { stage: '/other/stage' }, { recovery: '/other/recovery' },
    { recoveryPackage: '/other/recovery-package' }, { binLinks: '/other/bin-links.json' },
  ])('rejects each unsafe persisted field independently: %j', async (changes) => {
    const f = fixture();
    await f.service.apply();
    const record = JSON.parse(readFileSync(f.statePath(), 'utf8'));
    writeFileSync(f.statePath(), JSON.stringify({ ...record, ...changes }));
    expect(new ApplicationUpdateService(f.options).snapshot()).toEqual({
      status: 'error', supported: true, message: 'Update state needs retry.',
    });
    await expect(f.service.restart()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    expect(f.armRestart).not.toHaveBeenCalled();
  });

  it.each(['stage', 'recovery', 'targetVersion', 'stage directory', 'recovery directory'])
  ('invalidates a prepared update with missing %s', async (missing) => {
    const f = fixture();
    await f.service.apply();
    const record = JSON.parse(readFileSync(f.statePath(), 'utf8'));
    if (missing === 'targetVersion') delete record.state.targetVersion;
    else if (missing === 'stage directory') rmSync(record.stage, { recursive: true });
    else if (missing === 'recovery directory') rmSync(record.recovery, { recursive: true });
    else delete record[missing];
    writeFileSync(f.statePath(), JSON.stringify(record));
    expect(f.service.snapshot()).toEqual({ status: 'error', supported: true, message: 'Prepared update is missing. Retry Update.' });
    await expect(f.service.restart()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    expect(f.armRestart).not.toHaveBeenCalled();
  });

  it.each(['preparing', 'restarting'] as const)('expires %s after its deadline and keeps it valid at the boundary', async (status) => {
    const f = fixture();
    await f.service.apply();
    await f.service.restart();
    const record = JSON.parse(readFileSync(f.statePath(), 'utf8'));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    record.state.status = status;
    record.startedAt = now - (status === 'preparing' ? 180_000 : 360_000);
    writeFileSync(f.statePath(), JSON.stringify(record));
    expect(f.service.snapshot().status).toBe(status);
    record.startedAt--;
    writeFileSync(f.statePath(), JSON.stringify(record));
    expect(f.service.snapshot().message).toBe('Update state needs retry.');
  });

  it.each([undefined, 2147483647])('reports an interrupted preparation with owner PID %s', async (ownerPid) => {
    const f = fixture();
    await f.service.apply();
    const record = JSON.parse(readFileSync(f.statePath(), 'utf8'));
    record.state.status = 'preparing'; record.ownerPid = ownerPid; record.startedAt = Date.now();
    writeFileSync(f.statePath(), JSON.stringify(record));
    expect(f.service.snapshot()).toEqual({ status: 'error', supported: true, message: 'Update was interrupted. Retry Update.' });
  });

  it('rejects a recent Restarting state without a claim', async () => {
    const f = fixture();
    await f.service.apply();
    const record = JSON.parse(readFileSync(f.statePath(), 'utf8'));
    record.state.status = 'restarting'; record.ownerPid = process.pid; record.startedAt = Date.now();
    writeFileSync(f.statePath(), JSON.stringify(record));
    expect(f.service.snapshot().message).toBe('Update state needs retry.');
  });

  it.each([undefined, 0])('requires a start time for a claimed restart: %s', async (startedAt) => {
    const f = fixture();
    await f.service.apply(); await f.service.restart();
    const record = JSON.parse(readFileSync(f.statePath(), 'utf8'));
    record.startedAt = startedAt;
    writeFileSync(f.statePath(), JSON.stringify(record));
    expect(f.service.snapshot().message).toBe('Update state needs retry.');
  });
});

describe('application update lifecycle', () => {
  it.each([undefined, 'fixture-npm'])('uses the owned npm process with executable %s and the installation cache', async (npmBin) => {
    const f = fixture('2.0.0', { npmBin }, ['runNpm']);
    vi.mocked(runOwnedNpm).mockImplementation(async (_command, args) => { await f.runNpm(args); });
    expect((await f.service.apply()).status).toBe('ready');
    expect(runOwnedNpm).toHaveBeenCalledWith(npmBin ?? 'npm', f.runNpm.mock.calls[0]![0],
      expect.objectContaining({ npm_config_cache: f.options.npmCache }), expect.any(AbortSignal));
  });

  it('handles denied filesystem access even when the installation has write mode bits', async () => {
    const f = fixture();
    vi.mocked(access).mockRejectedValueOnce(new Error('permission denied'));
    await expect(f.service.apply()).rejects.toMatchObject({ status: 409 });
    expect(f.runNpm).not.toHaveBeenCalled();
    expect(f.service.snapshot().status).toBe('error');
  });

  it.each(['locked', 'unlocked'])('keeps the foreign record when ownership changes during %s error persistence', async (where) => {
    const f = fixture();
    await f.service.apply();
    const idle = JSON.stringify({ state: { status: 'idle', supported: true } });
    writeFileSync(f.statePath(), idle);
    const write = vi.mocked(writeFile).getMockImplementation()!;
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      await write(...args);
      if (!String(args[1]).includes('"status":"error"')) return;
      const lock = join(f.statePath(), '..', 'operation.lock');
      renameSync(lock, join(f.statePath(), '..', 'stolen-lock')); mkdirSync(lock);
    });
    if (where === 'locked') f.runNpm.mockRejectedValueOnce(new Error('install failed'));
    else chmodSync(f.original, 0o555);
    try {
      await expect(f.service.apply()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
      const persisted = JSON.parse(readFileSync(f.statePath(), 'utf8'));
      expect(persisted.state.status).toBe(where === 'locked' ? 'preparing' : 'idle');
      expect(f.service.snapshot().status).toBe(where === 'locked' ? 'error' : 'idle');
    } finally { chmodSync(f.original, 0o755); }
  });

  it('retains the preparing state if its record disappears during npm staging', async () => {
    const f = fixture();
    const install = f.runNpm.getMockImplementation()!;
    f.runNpm.mockImplementationOnce(async args => {
      rmSync(f.statePath());
      expect(f.service.snapshot()).toEqual({ status: 'preparing', supported: true, targetVersion: '2.0.0' });
      await install(args);
    });
    expect((await f.service.apply()).status).toBe('ready');
  });

  it('keeps an explicit preparation conflict without replacing it with an error state', async () => {
    const f = fixture();
    const conflict = new ApplicationUpdateConflictError('installation claimed elsewhere');
    f.runNpm.mockRejectedValueOnce(conflict);
    await expect(f.service.apply()).rejects.toBe(conflict);
    expect(f.service.snapshot().status).toBe('preparing');
  });

  it('refuses a different target while Restart is already claimed', async () => {
    const f = fixture();
    await f.service.apply(); await f.service.restart();
    const newer = new ApplicationUpdateService({ ...f.options, targetVersion: () => '3.0.0' });
    await expect(newer.apply()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    expect(newer.snapshot()).toEqual({ status: 'restarting', supported: true, targetVersion: '2.0.0' });
    expect(f.runNpm).toHaveBeenCalledTimes(1);
  });

  it('classifies a cancelled npm operation as a conflict and notifies its subscriber', async () => {
    const f = fixture();
    const listener = vi.fn();
    f.service.onStateChange(listener);
    f.runNpm.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    await expect(f.service.apply()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    expect(f.service.snapshot().status).toBe('error');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])('rejects invalid or older targets before preparation (dryRun=%s)', async (dryRun) => {
    for (const target of [null, '1.0.0', '0.9.9', '2.0', 'x2.0.0', '2x0.0', '2.0.0x', '2.0.0-']) {
      const f = fixture(target, { dryRun });
      await expect(f.service.apply()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
      expect(f.service.snapshot()).toEqual({ status: 'idle', supported: true });
      expect(f.runNpm).not.toHaveBeenCalled();
    }
  });

  it('keeps unsupported installations manual, including Restart', async () => {
    const f = fixture();
    const service = new ApplicationUpdateService({ ...f.options, npmPrefix: join(f.root, 'other-prefix') });
    expect(service.snapshot()).toEqual({ status: 'idle', supported: false, message: 'Update this installation manually.' });
    await expect(service.apply()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    await expect(service.restart()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    expect(f.runNpm).not.toHaveBeenCalled();
    expect(f.armRestart).not.toHaveBeenCalled();
  });

  it('notifies subscribers at each transition and hands off once after the response', async () => {
    const onChange = vi.fn(), listener = vi.fn(), handoff = vi.fn();
    const f = fixture('2.0.0', { onChange, handoff });
    f.service.onStateChange(listener);
    f.service.afterResponse();
    expect(handoff).not.toHaveBeenCalled();
    await f.service.apply();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(f.runNpm.mock.calls[0]?.[0]).toEqual(['install', '--prefix', join(f.statePath(), '..', 'stage'),
      '--engine-strict', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-online', '--fetch-retries=1', '@wjarka/cezarion@2.0.0']);
    const restarting = await f.service.restart();
    expect(restarting).toEqual({ status: 'restarting', supported: true, targetVersion: '2.0.0' });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(handoff).not.toHaveBeenCalled();
    f.service.afterResponse(); f.service.afterResponse();
    expect(handoff).toHaveBeenCalledTimes(1);
    expect((await f.service.apply()).status).toBe('restarting');
    expect(f.runNpm).toHaveBeenCalledTimes(1);
  });

  it('requires preparation in dry run and notifies when simulated restart finishes', async () => {
    const onChange = vi.fn(), listener = vi.fn(), handoff = vi.fn();
    const f = fixture('2.0.0', { dryRun: true, onChange, handoff });
    f.service.onStateChange(listener);
    await expect(f.service.restart()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    await f.service.apply(); await f.service.restart();
    f.service.afterResponse(); f.service.afterResponse();
    expect(f.service.snapshot()).toEqual({ status: 'idle', supported: true });
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(handoff).not.toHaveBeenCalled();
  });

  it('keeps a preparation retryable when the restart helper is unavailable', async () => {
    const f = fixture('2.0.0', {}, ['armRestart']);
    await f.service.apply();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.service.restart()).rejects.toMatchObject({ status: 503 });
      expect(f.service.snapshot().status).toBe('ready');
    }
    expect(f.armRestart).not.toHaveBeenCalled();
  });

  it.each(['claim', 'state'])('does not undo a foreign %s after helper acknowledgement', async (changed) => {
    const handoff = vi.fn();
    const f = fixture('2.0.0', { handoff });
    await f.service.apply();
    let foreign = '';
    f.armRestart.mockImplementationOnce(async () => {
      const record = JSON.parse(readFileSync(f.statePath(), 'utf8'));
      if (changed === 'claim') record.claimId = '00000000-0000-4000-8000-000000000001';
      else record.state.status = 'idle';
      foreign = JSON.stringify(record);
      writeFileSync(f.statePath(), foreign);
    });
    await expect(f.service.restart()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    expect(readFileSync(f.statePath(), 'utf8')).toBe(foreign);
    f.service.afterResponse();
    expect(handoff).not.toHaveBeenCalled();
  });

  it.each(['ready', 'preparing', 'restarting'])('keeps another %s record after an unlocked writability failure', async (status) => {
    const f = fixture();
    await f.service.apply(); await f.service.restart();
    const record = JSON.parse(readFileSync(f.statePath(), 'utf8'));
    record.state.status = status;
    const stored = JSON.stringify(record);
    writeFileSync(f.statePath(), stored);
    const service = new ApplicationUpdateService({ ...f.options, targetVersion: () => '3.0.0' });
    chmodSync(f.original, 0o555);
    try {
      await expect(service.apply()).rejects.toBeInstanceOf(ApplicationUpdateFailureError);
      expect(readFileSync(f.statePath(), 'utf8')).toBe(stored);
    } finally { chmodSync(f.original, 0o755); }
  });

  it('reports contention while trying to record an unlocked preparation failure', async () => {
    const f = fixture('2.0.0', { lockWaitMs: 10 });
    await f.service.apply();
    writeFileSync(f.statePath(), JSON.stringify({ state: { status: 'idle', supported: true } }));
    mkdirSync(join(f.statePath(), '..', 'operation.lock'));
    chmodSync(f.original, 0o555);
    try {
      // Real lock contention exercises the filesystem protocol; the lock stays owned throughout the call.
      await expect(f.service.apply()).rejects.toBeInstanceOf(ApplicationUpdateConflictError);
    } finally { chmodSync(f.original, 0o755); }
    expect(f.runNpm).toHaveBeenCalledTimes(1);
    expect(f.service.snapshot().status).toBe('idle');
  });

  it('reports storage failure if the error record cannot replace a directory', async () => {
    const f = fixture();
    f.runNpm.mockImplementationOnce(async () => {
      rmSync(f.statePath()); mkdirSync(f.statePath());
      throw new Error('install failed');
    });
    await expect(f.service.apply()).rejects.toMatchObject({ status: 503 });
    expect(f.service.snapshot().status).toBe('error');
  });

  it('backs up the whole npx root without recording global command links', async () => {
    const f = fixture();
    const installRoot = join(f.root, 'cache/_npx/abc123');
    const packageRoot = join(installRoot, 'node_modules/@wjarka/cezarion');
    cpSync(f.original, packageRoot, { recursive: true });
    writeFileSync(join(installRoot, 'package.json'), JSON.stringify({ _npx: { packages: ['@wjarka/cezarion'] } }));
    writeFileSync(join(installRoot, 'marker'), 'whole installation');
    const service = new ApplicationUpdateService({ ...f.options, packageRoot, launchEntry: join(packageRoot, 'dist/index.js') });
    expect((await service.apply()).status).toBe('ready');
    await service.restart();
    const plan = f.armRestart.mock.calls[0]![0];
    expect(plan.installation.kind).toBe('npx');
    expect(plan.oldVersion).toBe('1.0.0'); expect(plan.targetVersion).toBe('2.0.0');
    expect(readFileSync(join(plan.recovery, 'marker'), 'utf8')).toBe('whole installation');
    expect(plan.binLinks).toBeUndefined();
  });
});

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
    // Preparing precedes npm entry. Wait for the release closure, not that earlier state.
    // Delay proof: hearsay-tools/cezarion#2114, comment 6486640412 (old 1 failed; fixed 1 passed; 27 skipped / 28).
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: HANG_GUARD_MS });
    expect(service.snapshot().status).toBe('preparing');
    const other = new ApplicationUpdateService({ packageRoot: original, launchEntry: join(original, 'dist/index.js'),
      npmPrefix: join(root, 'prefix'), npmCache: join(root, 'cache'), home, targetVersion: () => '2.0.0', runNpm });
    const second = other.apply();
    release();
    expect((await first).status).toBe('ready');
    expect((await second).status).toBe('ready');
    expect(runNpm).toHaveBeenCalledTimes(1);
  });

  it.each(['{', 'null', '42', '[]', '{}', '{"state":null}', '{"state":{"status":"ready","supported":true},"ownerPid":"bad"}'])
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
    await vi.waitFor(() => expect(armRestart).toHaveBeenCalledTimes(1), { timeout: HANG_GUARD_MS });
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
    await vi.waitFor(() => expect(service.snapshot().status).toBe('preparing'), { timeout: HANG_GUARD_MS });
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
