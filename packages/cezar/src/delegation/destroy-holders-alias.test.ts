import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ calls: 0, failAt: 0, completed: false, legacyFail: false, legacyHeld: false, single: false, released: false, scanCost: 0 }));
vi.mock('node:fs', () => ({
  readdirSync: (path: string) => path === '/proc' ? (state.completed ? [] : state.single ? ['101'] : ['101', '102']) : path === `/proc/${process.pid}/task` ? [String(process.pid)]
    : path.endsWith('/task') ? [path.split('/')[2]] : [],
  opendirSync: (path: string) => {
    const names = path === '/proc' ? (state.completed ? [] : state.single ? ['101'] : ['101', '102']) : path === `/proc/${process.pid}/task` ? [String(process.pid)] : [path.split('/')[2]];
    let index = 0;
    return { readSync: () => index < names.length ? { name: names[index++] } : null, closeSync: () => {} };
  },
  readlinkSync: () => '/unrelated', lstatSync: () => ({}), readFileSync: () => 'invalid',
}));
vi.mock('../detached-process.ts', () => ({ linuxBootId: () => 'boot', parseProcStat: () => undefined, exitedStat: () => false,
  processStartToken: (pid: number) => state.completed ? undefined : 'boot:' + pid }));
vi.mock('./mount-boundary.ts', () => ({ canonicalResourceRoot: (path: string) => path }));
vi.mock('./linux-mapped-holders.ts', () => ({ mappedHolder: (_pid: number, _roots: string[], budget?: { spend(n: number): void }) => {
  if (state.legacyFail) budget?.spend(200_001);
  return state.legacyHeld ? 'held' : 'clear';
} }));
vi.mock('./linux-alias-scan.ts', async () => {
  const { AliasBudgetExceeded } = await import('./linux-alias-model.ts');
  return {
    prepareAliasScan: (_roots: string[], budget: unknown) => ({ budget }), verifyAliasScan: () => {},
    scanAliases: (pid: number, _token: string, attempt: { budget: { spend(n: number): void } }) => {
      attempt.budget.spend(state.scanCost);
      if (++state.calls === state.failAt) throw new AliasBudgetExceeded();
      if (state.released) return { outcome: 'clear', mappings: [], links: [], maps: '', observedLinks: [] };
      return { outcome: 'held', mappings: [{ path: '/owned/' + pid, dev: '8:1', ino: BigInt(pid) }], links: [] };
    },
  };
});
vi.mock('./linux-alias-retention.ts', async () => {
  const { AliasMappingScope } = await import('./linux-alias-scope.ts');
  return { aliasRetentionAdapter: () => ({ scope: new AliasMappingScope(), publish: () => {} }) };
});

import { reapDestroyHolders } from './destroy-holders.ts';

afterEach(() => vi.restoreAllMocks());

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
