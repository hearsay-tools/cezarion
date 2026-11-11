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
