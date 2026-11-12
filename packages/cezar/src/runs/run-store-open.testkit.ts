import { RunStore, type RunStorePersistence } from './store.ts';

/**
 * The test stores whose persistence a test can observe or fail. Kept apart from
 * `run-store.testkit.ts`, which loads no store at run time, so a test that only seeds or reads
 * `runs.db` does not re-run on every store edit (hearsay-tools/cezarion#3242).
 */

const persistenceAdapters = new WeakMap<RunStore, { persist: RunStorePersistence }>();

/** Open with a per-store adapter that tests can observe or fail without spying on internals. */
export function openTestRunStore(dataDir: string, opts?: Parameters<typeof RunStore.open>[1]): RunStore {
  const adapter = { persist: ((changes, transaction) => transaction(changes)) as RunStorePersistence };
  const store = RunStore.open(dataDir, { ...opts, persist: (changes, transaction) => adapter.persist(changes, transaction) });
  persistenceAdapters.set(store, adapter);
  return store;
}

export function runPersistence(store: RunStore): { persist: RunStorePersistence } {
  const adapter = persistenceAdapters.get(store);
  if (!adapter) throw new Error('Open the test store with openTestRunStore');
  return adapter;
}

/**
 * The process dies right after the store's next commit: that commit lands and every later one
 * throws. A test then crashes the store (`crashStore`) and reads what a reopened store finds, so
 * an outcome split over two commits, or left to the debounced save, goes missing from the row.
 */
export function crashAfterNextCommit(store: RunStore): void {
  const adapter = runPersistence(store);
  const commit = adapter.persist;
  let landed = false;
  adapter.persist = (changes, transaction) => {
    if (landed) throw new Error('the process died after its previous commit');
    landed = true;
    return commit(changes, transaction);
  };
}
