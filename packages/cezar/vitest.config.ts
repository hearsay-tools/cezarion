import { defineConfig } from 'vitest/config'

// The service + CLI suite: Node ESM, no DOM, no bundler. `test/` is deliberately NOT included
// — those are the node:test suites (`npm run test:unit`, `npm run test:package`), which pack
// and install the real tarball and must not run inside the fast unit gate.
export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Pins CEZ_HOME to a per-worker sandbox so no case can write the developer's
    // real ~/.cezar — see the file for the failure it prevents.
    setupFiles: ['./vitest.setup.ts'],
    // The default 5 s is not enough for a test that opens a fresh runs.db under disk-write
    // pressure (hearsay-tools/cezarion#1043). Each such test pays real SQLite fsyncs: creating
    // the database and switching it to WAL, the import backup, and the checkpoint on the last
    // close. strace counted 6-7 per test on average in src/runs and 14-16 in the store suites'
    // reopen tests. hearsay-tools/cezarion#1038 measured store.close(), which is 2 of those
    // fsyncs, at 2.15-2.3 s under 4 writers plus `sync` every 0.5 s: about 1.1 s each.
    // 16 x 1.1 s = 17.6 s. With every fsync delayed by 1.1 s, the two tests the issue names
    // took 12.2 s and 17.7 s, so 30 s leaves room for CPU load on top. Hooks open and close
    // stores too, so they get the same bound. A handful of tests issue 20-80 fsyncs and can
    // still exceed it at that cost. Production keeps its real fsyncs (journal_mode=WAL,
    // synchronous=NORMAL), and so do the tests: run-database.test.ts still pins those pragmas.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
