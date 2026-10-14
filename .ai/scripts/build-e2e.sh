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
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
OUT="$REPO_ROOT/.ai/qa/build/cezar"

rm -rf "$OUT"
mkdir -p "$OUT/web"
# Relative links survive a moved checkout and resolve to this checkout from a lane symlink.
for entry in scripts package.json node_modules; do
  ln -s "../../../../packages/cezar/$entry" "$OUT/$entry"
done

cd "$REPO_ROOT"
# tsc and inline-contract directly rather than the package's `build` script: its prebuild
# rewrites packages/cezar/README.md and its postbuild post-processes packages/cezar/dist.
npm exec -w @wjarka/cezarion -- tsc -p tsconfig.json --outDir "$OUT/dist"
node packages/cezar/scripts/inline-contract.mjs "$OUT/dist"
# VITE_CEZ_E2E=1 is the cockpit e2e mode (hearsay-tools/cezarion#415): it pins useNow and
# every refetchInterval in the bundle, and makes Vite emit the `.cez-e2e-build` marker the
# bootstrap checks.
VITE_CEZ_E2E=1 npm run build -w @open-mercato/cezar-web -- --outDir "$OUT/web/dist"
