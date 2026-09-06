import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` so the mock fn exists before the hoisted `vi.mock` factory closes over it.
const discoverRepoHandleMock = vi.hoisted(() => vi.fn());
// The forge module shells out to `gh`. Mocking it is the whole point of this file: what is under
// test is the WRAPPER's contract — background, never throwing — not the lookup itself, which has
// its own coverage in `server/forge/github.test.ts`.
vi.mock('../server/forge/github.ts', () => ({
  discoverRepoHandle: (...args: unknown[]) => discoverRepoHandleMock(...args),
}));

import { armRepoHandle } from './arm-repo-handle.ts';

import type { RunStore } from './store.ts';

/**
 * `armRepoHandle` is the safety wrapper around the #945 repo lookup, and both of its call sites
 * are fire-and-forget — so a regression here is invisible to every other suite and surfaces only
 * as a boot that dies on a machine without `gh`. `AGENTS.md` makes that the rule it breaks:
 * "a missing dependency, an absent peer, a read-only home: degrade to a smaller working cockpit,
 * never fail the boot."
 */
describe('armRepoHandle (#945)', () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); discoverRepoHandleMock.mockReset(); });
  /** Just enough store to observe the one call this module makes. */
  const fakeStore = () => {
    const setRepoHandle = vi.fn();
    return { store: { setRepoHandle } as unknown as RunStore, setRepoHandle };
  };

  /** Let the promise chain inside `armRepoHandle` settle without the caller awaiting it. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('hands a resolved handle to the store', async () => {
    discoverRepoHandleMock.mockResolvedValue({ status: 'resolved', handle: { owner: 'open-mercato', name: 'cezar' } });
    const { store, setRepoHandle } = fakeStore();

    armRepoHandle(store, '/repo');
    await settle();

    expect(discoverRepoHandleMock).toHaveBeenCalledWith('/repo', undefined);
    expect(setRepoHandle).toHaveBeenCalledWith({ owner: 'open-mercato', name: 'cezar' });
  });

  it('passes a null handle through — "unknown" is a first-class answer, not a failure', async () => {
    // No `gh`, no remote, a non-git root, hosted mode. The store must be told, so it settles into
    // the unscoped (pre-#945) behavior rather than waiting forever for a handle.
    discoverRepoHandleMock.mockResolvedValue({ status: 'unknown' });
    const { store, setRepoHandle } = fakeStore();

    armRepoHandle(store, '/repo');
    await settle();

    expect(setRepoHandle).toHaveBeenCalledWith(null);
  });

  it('swallows a rejection instead of taking the boot down with it', async () => {
    // `discoverRepoHandle` classifies failures rather than throwing for the ordinary cases, so this is
    // belt-and-braces — which is exactly why it needs a test: without one, the `.catch` reads as
    // deletable, and deleting it turns any future throw into an unhandled rejection during boot.
    vi.useFakeTimers();
    discoverRepoHandleMock.mockRejectedValue(new Error('gh exploded'));
    const { store, setRepoHandle } = fakeStore();

    expect(() => armRepoHandle(store, '/repo')).not.toThrow();
    await vi.runAllTimersAsync();

    expect(setRepoHandle).not.toHaveBeenCalled(); // unscoped, exactly as before #945
  });

  it('returns synchronously — boot never waits on the `gh` spawn', async () => {
    // The property both call sites depend on: a slow lookup must not delay opening a store.
    let release: (value: unknown) => void = () => {};
    discoverRepoHandleMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { store, setRepoHandle } = fakeStore();

    expect(armRepoHandle(store, '/repo')).toBeUndefined();
    expect(setRepoHandle).not.toHaveBeenCalled(); // still pending — and the caller already moved on

    release({ status: 'resolved', handle: { owner: 'open-mercato', name: 'cezar' } });
    await settle();
    expect(setRepoHandle).toHaveBeenCalledWith({ owner: 'open-mercato', name: 'cezar' });
  });
});
