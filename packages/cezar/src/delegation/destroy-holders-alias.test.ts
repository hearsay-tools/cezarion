import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ calls: 0, failAt: 0, completed: false, legacyFail: false, legacyHeld: false, single: false, released: false, scanCost: 0,
  unstable: false, failAfterConfirm: false, verifyFailure: false, pending: false, published: [] as unknown[],
  exitMode: '' as string, signalled: false, changedDuringExit: false, statError: '', beforeSignal: false, mappingCalls: 0 }));
vi.mock('node:fs', () => ({
  readdirSync: (path: string) => path === '/proc' ? (state.completed ? [] : state.single ? ['101'] : ['101', '102']) : path === `/proc/${process.pid}/task` ? [String(process.pid)]
    : path.endsWith('/task') ? [path.split('/')[2]] : [],
  opendirSync: (path: string) => {
    if (state.signalled && state.exitMode && path === '/proc/101/fd') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    const names = path === '/proc' ? (state.completed ? [] : state.single ? ['101'] : ['101', '102']) : path === `/proc/${process.pid}/task` ? [String(process.pid)] : [path.split('/')[2]];
    let index = 0;
    return { readSync: () => index < names.length ? { name: names[index++] } : null, closeSync: () => {} };
  },
  readlinkSync: (path: string) => {
    if (state.signalled && state.exitMode && path === '/proc/101/cwd') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return '/unrelated';
  }, lstatSync: () => { if (state.completed) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return {}; },
  readFileSync: () => { if (state.statError && (state.signalled || state.beforeSignal && state.mappingCalls >= 2)) throw Object.assign(new Error('stat unavailable'), { code: state.statError }); return '101 (task) Z 0'; },
}));
vi.mock('../detached-process.ts', () => ({ linuxBootId: () => 'boot', parseProcStat: () => state.exitMode === 'invalid' ? undefined : {},
  exitedStat: () => {
    if (state.signalled && state.exitMode === 'changed') state.changedDuringExit = true;
    return state.signalled && (state.exitMode === 'zombie' || state.exitMode === 'changed');
  },
  processStartToken: (pid: number) => state.completed || (state.signalled && state.exitMode === 'missing') ? undefined
    : state.changedDuringExit || (state.signalled && state.exitMode === 'new') ? 'boot:other' : 'boot:' + pid }));
vi.mock('./linux-proc-evidence.ts', () => ({ readProcEvidence: () => {
  if (state.statError && (state.signalled || state.beforeSignal && state.mappingCalls >= 2)) throw Object.assign(new Error('stat unavailable'), { code: state.statError });
  return Buffer.from('101 (task) Z 0');
} }));
vi.mock('./mount-boundary.ts', () => ({ canonicalResourceRoot: (path: string) => path }));
vi.mock('./linux-mapped-holders.ts', () => ({ mappedHolder: (_pid: number, _roots: string[], budget?: { spend(n: number): void }) => {
  if (state.legacyFail) budget?.spend(200_001);
  state.mappingCalls++;
  return (state.signalled && state.exitMode || state.beforeSignal && state.mappingCalls >= 2) ? 'unreadable' : state.legacyHeld ? 'held' : 'clear';
} }));
vi.mock('./linux-alias-scan.ts', async () => {
  const { AliasBudgetExceeded } = await import('./linux-alias-model.ts');
  return {
    prepareAliasScan: (roots: string[], budget: unknown) => ({ roots, budget }),
    verifyAliasScan: () => {
      if (state.verifyFailure) throw new Error('owning evidence changed');
    },
    scanAliases: (pid: number, _token: string, attempt: { budget: { spend(n: number): void } }, confirmed?: (candidate: unknown) => void, candidate?: () => void) => {
      attempt.budget.spend(state.scanCost);
      if (++state.calls === state.failAt) throw new AliasBudgetExceeded();
      if (state.unstable) {
        candidate?.();
        confirmed?.({ path: '/owned/file', dev: '8:1', ino: BigInt(pid) });
        if (state.failAfterConfirm) throw new AliasBudgetExceeded();
        if (state.verifyFailure) return { outcome: 'held', mappings: [{ path: '/owned/file', dev: '8:1', ino: BigInt(pid) }], links: [] };
        return { outcome: 'unknown', scoped: true, mappings: [], links: [] };
      }
      if (state.released) return { outcome: 'clear', mappings: [], links: [], maps: '', observedLinks: [] };
      return { outcome: 'held', mappings: [{ path: '/owned/' + pid, dev: '8:1', ino: BigInt(pid) }], links: [] };
    },
  };
});

it('retains a positive inode when work exhausts immediately after confirmation', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false; state.single = true; state.released = false;
  state.unstable = true; state.failAfterConfirm = true; state.published = [];
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    await expect(reapDestroyHolders(['/owned'], () => {}, 3000,
      { resourceId: 'test', read: () => undefined, write: () => {} })).rejects.toThrow('work exceeds');
    expect(kill).not.toHaveBeenCalled();
    expect((state.published[0] as ReturnType<AliasMappingScope['snapshot']>)[0]?.identities).toEqual([{ dev: '8:1', ino: '101' }]);
  } finally { state.unstable = false; state.failAfterConfirm = false; }
});

it('refuses before target confirmation when scan work exceeds the budget', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false; state.single = true; state.released = false;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  state.scanCost = 200;
  try {
    await expect(reapDestroyHolders(['/owned'], () => {}, 3000,
      { resourceId: 'test', read: () => undefined, write: () => {} }, new AliasWorkBudget(100))).rejects.toThrow('work exceeds');
    expect(state.calls).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  } finally { state.scanCost = 0; }
});

it('retains published inode evidence when owning snapshot verification fails', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false; state.single = true; state.released = false;
  state.unstable = true; state.verifyFailure = true; state.published = [];
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    await expect(reapDestroyHolders(['/owned'], () => {}, 3000,
      { resourceId: 'test', read: () => undefined, write: () => {} })).rejects.toThrow('owning evidence changed');
    expect(kill).not.toHaveBeenCalled();
    expect((state.published[0] as ReturnType<AliasMappingScope['snapshot']>)[0]?.identities).toEqual([{ dev: '8:1', ino: '101' }]);
  } finally { state.unstable = false; state.verifyFailure = false; }
});
vi.mock('./linux-alias-retention.ts', async () => {
  const { AliasMappingScope } = await import('./linux-alias-scope.ts');
  return { aliasRetentionAdapter: () => ({ scope: new AliasMappingScope(), publish: (entries: unknown) => { state.published.push(entries); },
    begin: () => true, finish: () => {}, reconcile: () => state.pending }) };
});

import { reapDestroyHolders } from './destroy-holders.ts';
import { AliasWorkBudget } from './linux-alias-model.ts';
import { AliasMappingScope } from './linux-alias-scope.ts';

afterEach(() => vi.restoreAllMocks());

it.each(['zombie', 'live', 'invalid', 'changed', 'missing', 'new'])('fences scoped unreadable evidence after signal: %s', async mode => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false; state.single = true; state.released = false;
  state.exitMode = mode; state.signalled = false; state.changedDuringExit = false;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { state.signalled = true; state.released = true; return true; });
  try {
    const result = reapDestroyHolders(['/owned'], () => {}, 3000, { resourceId: 'test', read: () => undefined, write: () => {} });
    if (mode === 'zombie' || mode === 'new') await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow('Cannot read evidence');
    expect(kill).toHaveBeenCalledTimes(1);
  } finally { state.exitMode = ''; state.signalled = false; state.changedDuringExit = false; state.released = false; }
});

it.each(['ENOENT', 'EACCES'])('refuses a stat read error after signal: %s', async code => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.single = true; state.released = false;
  state.exitMode = 'zombie'; state.signalled = false; state.statError = code;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { state.signalled = true; state.released = true; return true; });
  try {
    await expect(reapDestroyHolders(['/owned'], () => {}, 3000,
      { resourceId: 'test', read: () => undefined, write: () => {} })).rejects.toThrow('Cannot read evidence');
    expect(kill).toHaveBeenCalledTimes(1);
  } finally { state.exitMode = ''; state.signalled = false; state.statError = ''; state.released = false; }
});

it('refuses a missing stat at the unreadable mapping before signal', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.single = true; state.released = false;
  state.beforeSignal = true; state.mappingCalls = 0; state.statError = 'ENOENT';
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    await expect(reapDestroyHolders(['/owned'], () => {}, 3000,
      { resourceId: 'test', read: () => undefined, write: () => {} })).rejects.toThrow('Cannot read evidence');
    expect(kill).not.toHaveBeenCalled();
  } finally { state.beforeSignal = false; state.statError = ''; }
});

it('refuses deletion when a reopened pending marker has no visible candidate', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false;
  state.single = true; state.released = true; state.pending = true;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    await expect(reapDestroyHolders(['/owned'], () => {}, 3000,
      { resourceId: 'test', read: () => undefined, write: () => {} })).rejects.toThrow('Pending alias scan');
    expect(kill).not.toHaveBeenCalled();
  } finally { state.pending = false; state.released = false; }
});

it.each([[2, []], [6, [101]]] as const)('stops after budget failure at scan %i', async (failAt, expected) => {
  state.calls = 0; state.failAt = failAt; state.completed = false; state.legacyFail = false; state.single = false; state.released = false;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const retention = { resourceId: 'test', read: () => undefined, write: () => {} };
  await expect(reapDestroyHolders(['/owned'], () => {}, 3000, retention)).rejects.toThrow('work exceeds');
  expect(kill.mock.calls.map(([pid]) => pid)).toEqual(expected);
});

it('preserves holder stop order after complete discovery and fresh checks', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false; state.single = false; state.released = false;
  const stopped: number[] = [];
  vi.spyOn(process, 'kill').mockImplementation(pid => {
    stopped.push(Number(pid));
    if (stopped.length === 2) state.completed = true;
    return true;
  });
  let currentChecks = 0;
  await reapDestroyHolders(['/owned'], () => { currentChecks++; }, 3000,
    { resourceId: 'test', read: () => undefined, write: () => {} });
  expect(stopped).toEqual([101, 102]);
  expect(state.calls).toBe(6);
  expect(currentChecks).toBeGreaterThan(4);
});

it('aborts before signals if the legacy holder scan exhausts the attempt budget', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = true; state.single = false; state.released = false;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  await expect(reapDestroyHolders(['/owned'], () => {}, 3000,
    { resourceId: 'test', read: () => undefined, write: () => {} })).rejects.toThrow('work exceeds');
  expect(state.calls).toBe(0);
  expect(kill).not.toHaveBeenCalled();
});

it('rechecks target evidence after the last asynchronous authorization', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false; state.single = true; state.released = false;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  let checks = 0;
  await reapDestroyHolders(['/owned'], async () => { if (++checks === 6) state.released = true; }, 3000,
    { resourceId: 'test', read: () => undefined, write: () => {} });
  expect(state.released).toBe(true);
  expect(state.calls).toBeGreaterThanOrEqual(2);
  expect(kill).not.toHaveBeenCalled();
});

it('keeps one work budget across repeated discovery sweeps', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false; state.single = true; state.released = false;
  state.scanCost = 60_000;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    await expect(reapDestroyHolders(['/owned'], () => {}, 3000,
      { resourceId: 'test', read: () => undefined, write: () => {} })).rejects.toThrow('work exceeds');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(state.calls).toBe(3);
  } finally { state.scanCost = 0; }
});

it('does not signal a legacy path match without fresh authenticated alias identity', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false; state.single = true; state.released = true;
  state.legacyHeld = true;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    await expect(reapDestroyHolders(['/owned'], () => {}, 1,
      { resourceId: 'test', read: () => undefined, write: () => {} })).rejects.toThrow('Destroy holders remain');
    expect(kill).not.toHaveBeenCalled();
  } finally { state.legacyHeld = false; state.released = false; }
});

it('shares one destroy budget across separate reaper calls', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false; state.single = true; state.released = false;
  state.scanCost = 50_000;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { state.completed = true; return true; });
  const retention = { resourceId: 'test', read: () => undefined, write: () => {} };
  const budget = new AliasWorkBudget();
  try {
    await reapDestroyHolders(['/owned'], () => {}, 3000, retention, budget);
    state.completed = false;
    await expect(reapDestroyHolders(['/owned'], () => {}, 3000, retention, budget)).rejects.toThrow('work exceeds');
    expect(kill).toHaveBeenCalledTimes(1);
  } finally { state.scanCost = 0; }
});

it('durably retains a confirmed inode when its later target snapshot is unstable', async () => {
  state.calls = 0; state.failAt = 0; state.completed = false; state.legacyFail = false; state.single = true; state.released = false;
  state.unstable = true; state.published = [];
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    await expect(reapDestroyHolders(['/owned'], () => {}, 3000,
      { resourceId: 'test', read: () => undefined, write: () => {} })).rejects.toThrow('Cannot verify');
    expect(kill).not.toHaveBeenCalled();
    const entries = state.published[0] as ReturnType<AliasMappingScope['snapshot']>;
    expect(entries[0]?.identities).toEqual([{ dev: '8:1', ino: '101' }]);
    const restarted = new AliasMappingScope();
    restarted.remember(entries[0]!.pid, entries[0]!.token, entries[0]!.identities.map(item => ({ dev: item.dev, ino: BigInt(item.ino) })));
    expect(restarted.recheck(101, 'boot:101', '1-2 r--p 0 08:01 101 /detached/file (deleted)\n', false, [])).toBe('unknown');
  } finally { state.unstable = false; }
});
