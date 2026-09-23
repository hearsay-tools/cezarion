import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationUpdateService, type RestartPlan } from './service.ts';
import { restoreOriginal, type HelperPlan } from './helper.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(layout: 'hoisted' | 'nested' | 'direct' = 'hoisted') {
  const root = mkdtempSync(join(tmpdir(), 'cez-hoisted-recovery-')); roots.push(root);
  const prefix = join(root, 'prefix'), home = join(root, 'home'), cache = join(root, 'cache');
  const outer = join(prefix, 'lib/node_modules', layout === 'direct' ? '@wjarka/cezarion' : 'cezarion');
  const original = layout === 'nested' ? join(outer, 'node_modules/@wjarka/cezarion') : join(prefix, 'lib/node_modules/@wjarka/cezarion');
  mkdirSync(join(original, 'dist'), { recursive: true }); mkdirSync(join(original, 'web/dist'), { recursive: true });
  mkdirSync(outer, { recursive: true });
  writeFileSync(join(original, 'package.json'), JSON.stringify({ name: '@wjarka/cezarion', version: '1.0.0', bin: { cez: 'dist/index.js' }, dependencies: {} }));
  writeFileSync(join(original, 'dist/index.js'), 'original CLI'); writeFileSync(join(original, 'web/dist/index.html'), 'original web');
  if (layout !== 'direct') {
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'cezarion', version: '1.0.0', bin: { cez: 'bin.js' }, dependencies: { '@wjarka/cezarion': '^1.0.0' } }));
    writeFileSync(join(outer, 'bin.js'), 'original alias');
  }
  const runNpm = vi.fn(async (args: string[]) => {
    const stage = args[args.indexOf('--prefix') + 1]!;
    const stagedOuter = join(stage, 'node_modules', layout === 'direct' ? '@wjarka/cezarion' : 'cezarion');
    cpSync(outer, stagedOuter, { recursive: true });
    const stagedScoped = layout === 'nested' ? join(stagedOuter, 'node_modules/@wjarka/cezarion') : join(stage, 'node_modules/@wjarka/cezarion');
    if (layout === 'hoisted') cpSync(original, stagedScoped, { recursive: true });
    for (const path of new Set([stagedOuter, stagedScoped])) {
      const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
      writeFileSync(join(path, 'package.json'), JSON.stringify({ ...pkg, version: '2.0.0' }));
    }
  });
  let restart: RestartPlan | undefined;
  const options = { packageRoot: original, launchEntry: join(outer, layout === 'direct' ? 'dist/index.js' : 'bin.js'),
    npmPrefix: prefix, npmCache: cache, home, targetVersion: () => '2.0.0', runNpm, armRestart: async (plan: RestartPlan) => { restart = plan; } };
  const service = new ApplicationUpdateService(options);
  const recordPath = () => join(home, 'application-updates', readdirSync(join(home, 'application-updates'))[0]!, 'state.json');
  const readRecord = () => JSON.parse(readFileSync(recordPath(), 'utf8'));
  const plan = (): HelperPlan => ({ ...restart!, oldPid: -1, nodeExecutable: process.execPath, nodeArgs: [], cliArgs: [], cwd: root,
    repoRoot: root, host: '127.0.0.1', port: 12345, npmBin: 'npm' });
  return { root, original, outer, service, runNpm, options, recordPath, readRecord, plan };
}

it.each(['hoisted', 'nested', 'direct'] as const)('old %s records cannot falsely promise hoisted recovery', async layout => {
  const f = fixture(layout); await f.service.apply();
  const record = f.readRecord(); delete record.recoveryPackage;
  writeFileSync(f.recordPath(), JSON.stringify(record));
  const resumed = new ApplicationUpdateService(f.options);
  expect(resumed.snapshot().status).toBe(layout === 'hoisted' ? 'error' : 'ready');
  if (layout === 'hoisted') {
    await expect(resumed.restart()).rejects.toThrow('Prepare');
    expect((await resumed.apply()).status).toBe('ready');
  } else expect(readdirSync(join(f.recordPath(), '..')).filter(name => name === 'recovery-package')).toEqual([]);
});

it.each(['missing', 'corrupt', 'wrong version', 'missing CLI', 'foreign path', 'oversized path'] as const)('invalidates hoisted Ready with %s recovery metadata or files', async damage => {
  const f = fixture(); await f.service.apply();
  const record = f.readRecord();
  // The fixed private path is not supplied by a client or stored destination list.
  const backup = join(f.recordPath(), '..', 'recovery-package');
  if (damage === 'missing') rmSync(backup, { recursive: true, force: true });
  if (damage === 'corrupt') writeFileSync(join(backup, 'package.json'), '{');
  if (damage === 'wrong version') writeFileSync(join(backup, 'package.json'), JSON.stringify({ name: '@wjarka/cezarion', version: '2.0.0' }));
  if (damage === 'missing CLI') rmSync(join(backup, 'dist/index.js'));
  if (damage === 'foreign path' || damage === 'oversized path') {
    record.recoveryPackage = damage === 'foreign path' ? f.original : 'x'.repeat(4097);
    writeFileSync(f.recordPath(), JSON.stringify(record));
  }
  expect(new ApplicationUpdateService(f.options).snapshot().status).toBe('error');
  await expect(f.service.restart()).rejects.toThrow('Prepare');
  expect(readFileSync(join(f.original, 'dist/index.js'), 'utf8')).toBe('original CLI');
});

it('refuses a read-only hoisted package before staging', async () => {
  const f = fixture(); chmodSync(f.original, 0o555);
  try { await expect(f.service.apply()).rejects.toThrow('not writable'); expect(f.runNpm).not.toHaveBeenCalled(); }
  finally { chmodSync(f.original, 0o755); }
});

it('keeps private snapshots and rejects missing hoisted recovery before changing either root', async () => {
  const f = fixture(); await f.service.apply(); await f.service.restart();
  const record = f.readRecord();
  const backup = join(f.recordPath(), '..', 'recovery-package');
  expect(readFileSync(join(backup, 'dist/index.js'), 'utf8')).toBe('original CLI');
  if (process.platform !== 'win32') expect(statSync(f.recordPath()).mode & 0o777).toBe(0o600);
  rmSync(backup, { recursive: true });
  writeFileSync(join(f.outer, 'bin.js'), 'promoted alias');
  await expect(restoreOriginal(f.plan())).rejects.toThrow();
  expect(readFileSync(join(f.outer, 'bin.js'), 'utf8')).toBe('promoted alias');
  expect(existsSync(record.recovery)).toBe(true);
});

it('does not copy a hoisted package after ownership is lost', async () => {
  const f = fixture(); await f.service.apply(); await f.service.restart();
  const assertOwned = vi.fn(async () => { throw new Error('update lock ownership changed'); });
  writeFileSync(join(f.original, 'dist/index.js'), 'promoted CLI');
  await expect(restoreOriginal(f.plan(), assertOwned)).rejects.toThrow('ownership changed');
  expect(readFileSync(join(f.original, 'dist/index.js'), 'utf8')).toBe('promoted CLI');
  expect(existsSync(f.readRecord().recovery)).toBe(true);
});

it.each(['legacy', 'foreign path', 'corrupt manifest'] as const)('rejects %s hoisted helper metadata before removing either package', async damage => {
  const f = fixture(); await f.service.apply(); await f.service.restart();
  const plan = f.plan();
  if (damage === 'legacy') delete plan.recoveryPackage;
  if (damage === 'foreign path') plan.recoveryPackage = f.original;
  if (damage === 'corrupt manifest') writeFileSync(join(plan.recoveryPackage!, 'package.json'), '{');
  writeFileSync(join(f.outer, 'bin.js'), 'promoted alias');
  writeFileSync(join(f.original, 'dist/index.js'), 'promoted CLI');
  await expect(restoreOriginal(plan)).rejects.toThrow();
  expect(readFileSync(join(f.outer, 'bin.js'), 'utf8')).toBe('promoted alias');
  expect(readFileSync(join(f.original, 'dist/index.js'), 'utf8')).toBe('promoted CLI');
});

it('checks ownership between restoring the alias and removing the hoisted package', async () => {
  const f = fixture(); await f.service.apply(); await f.service.restart();
  writeFileSync(join(f.outer, 'bin.js'), 'promoted alias');
  writeFileSync(join(f.original, 'dist/index.js'), 'promoted CLI');
  await expect(restoreOriginal(f.plan(), async () => {
    if (existsSync(join(f.outer, 'bin.js')) && readFileSync(join(f.outer, 'bin.js'), 'utf8') === 'original alias') {
      throw new Error('update lock ownership changed');
    }
  })).rejects.toThrow('ownership changed');
  expect(readFileSync(join(f.original, 'dist/index.js'), 'utf8')).toBe('promoted CLI');
  expect(readFileSync(join(f.plan().recoveryPackage!, 'dist/index.js'), 'utf8')).toBe('original CLI');
});

it.each(['idle', 'error', 'restarting'] as const)('retains %s state when a later boot discovers npm changed hoisted to nested', async status => {
  const f = fixture(); await f.service.apply(); await f.service.restart();
  const record = f.readRecord();
  record.state.status = status;
  if (status !== 'restarting') { delete record.ownerPid; delete record.claimId; delete record.startedAt; }
  writeFileSync(f.recordPath(), JSON.stringify(record));
  const nested = join(f.outer, 'node_modules/@wjarka/cezarion');
  cpSync(f.original, nested, { recursive: true });
  rmSync(f.original, { recursive: true });
  const resumed = new ApplicationUpdateService({ ...f.options, packageRoot: nested });
  expect(resumed.snapshot()).toEqual(record.state);
});
