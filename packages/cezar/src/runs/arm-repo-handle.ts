import { discoverRepoHandle } from '../server/forge/github.ts';

import type { RunStore } from './store.ts';

const RETRY_DELAYS_MS = [1_000, 5_000] as const;

/**
 * Discover a live store's repository in the background, with at most two retries (#102).
 * Both project contexts and headless runs own an abort signal: shutdown cancels a pending
 * timer or gh process, and late results cannot repair a store whose ownership has ended.
 * Permanent unknown identity and exhausted retries retain the existing unscoped behavior.
 * Successful discovery uses setRepoHandle's existing repair and reference-ownership rules.
 */
export function armRepoHandle(store: RunStore, repoRoot: string, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  const finish = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    signal?.removeEventListener('abort', finish);
  };
  signal?.addEventListener('abort', finish, { once: true });

  const attempt = async () => {
    timer = undefined;
    if (signal?.aborted) return;
    // A future unexpected rejection must not become an unhandled boot failure either.
    const result = await discoverRepoHandle(repoRoot, signal).catch(() => ({ status: 'retryable' as const }));
    if (signal?.aborted) return;
    if (result.status === 'resolved' || result.status === 'unknown') {
      finish();
      store.setRepoHandle(result.status === 'resolved' ? result.handle : null);
      return;
    }
    const delay = RETRY_DELAYS_MS[retries++];
    if (result.status === 'cancelled' || delay === undefined) {
      finish();
      return;
    }
    timer = setTimeout(() => { void attempt().catch(finish); }, delay);
    timer.unref();
  };
  void attempt().catch(finish);
}
