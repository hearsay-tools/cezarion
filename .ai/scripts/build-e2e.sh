#!/bin/sh
# Builds the cockpit e2e bundle into an ignored mirror of the server package, so the e2e
# bootstrap never writes `packages/cezar/dist` or `packages/cezar/web/dist`. Those are the
# production build, and a declared input of the packaged-CLI and browser checks: rewriting
# them from a test boot invalidated every slow check and swapped the production bundle for
# an e2e one (hearsay-tools/cezarion#649).
#
#   .ai/qa/build/cezar/dist/       tsc output + the inlined contract (real files)
#   .ai/qa/build/cezar/web/dist/   vite output with VITE_CEZ_E2E=1 (real files)
#   .ai/qa/build/cezar/scripts      -> packages/cezar/scripts       (mock CLIs, helpers)
#   .ai/qa/build/cezar/package.json -> packages/cezar/package.json  ("type": "module", version)
#   .ai/qa/build/cezar/node_modules -> packages/cezar/node_modules  (zod, hono, …)
#
# The server resolves its assets relative to its own module (`resolveWebDir` walks
# `dist/server/../../web`, the mock CLIs sit at `dist/core/../../scripts`), so this mirror
# boots exactly like the package. Dependencies must already be installed.
#
# An optional argument, an absolute path, builds the same mirror there instead
# (qa-fixture.mjs builds into its temporary root). The directory is replaced.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
OUT="$REPO_ROOT/.ai/qa/build/cezar"
# Relative links survive a moved checkout and resolve to this checkout from a lane symlink.
LINK_BASE=../../../../packages/cezar
if [ $# -gt 0 ]; then
  case "$1" in
    /*) OUT=$1 ;;
    *) echo "build-e2e.sh: the output directory must be an absolute path: $1" >&2; exit 2 ;;
  esac
  # Another directory has another depth, and may sit outside this checkout.
  LINK_BASE="$REPO_ROOT/packages/cezar"
fi

rm -rf "$OUT"
mkdir -p "$OUT/web"
for entry in scripts package.json node_modules; do
  ln -s "$LINK_BASE/$entry" "$OUT/$entry"
done

cd "$REPO_ROOT"
# tsc and inline-contract directly rather than the package's `build` script: its prebuild
# rewrites packages/cezar/README.md and its postbuild post-processes packages/cezar/dist.
npm exec -w @wjarka/cezarion -- tsc -p tsconfig.json --outDir "$OUT/dist"
node packages/cezar/scripts/inline-contract.mjs "$OUT/dist"
# VITE_CEZ_E2E=1 is the cockpit e2e mode (hearsay-tools/cezarion#415): it pins useNow and
# every refetchInterval in the bundle, and makes Vite emit the `.cez-e2e-build` marker the
# bootstrap checks.
#
# NODE_ENV=production because Vite derives the bundle's mode from an inherited NODE_ENV, and
# Squeal reaches this script through the e2e project's globalSetup, inside Vitest, which sets
# NODE_ENV=test (hearsay-tools/cezarion#1087). That produced a development bundle: the React dev
# runtime and `import.meta.env.DEV`, so the cockpit started its SharedWorker from the dev-server
# path `/assets/live-worker-*.ts`. The worker failed, every document fell back to finite HTTP
# polling, and `window.__cezLive` never became true. Evidence: Squeal's three red runs of
# task-handoff's #795 test (main 27253ca, worktrees a01dc132 and dadba797) were all served
# such a bundle; the copied main build failed the spec 3/3 with `/run-event-batches` every 2 s
# in the page's resource timing. Reproduced 1/1 by forcing a Vitest-driven rebuild
# (`touch` this file, then `npm exec -- vitest run --config packages/web/e2e/vitest.config.ts`).
# Pinned here, on the bundle step only, so every caller gets the production bundle CI tests.
# Not exported: `pnpm install` before this script must still install devDependencies.
NODE_ENV=production VITE_CEZ_E2E=1 npm run build -w @open-mercato/cezar-web -- --outDir "$OUT/web/dist"
