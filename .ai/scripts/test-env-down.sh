#!/bin/sh
# om-prepare-test-env: generated entrypoint (contract v2)
# regenerate with: om-prepare-test-env --regenerate
# history:
#   2026-07-14 generated — mirrors test-env-up.sh; no services to remove, so this
#             only stops the app PID this repo started and marks the descriptor stopped.
#   2026-10-25 stop the app's whole process group through test-env-lease.mjs stop-app, only
#             when its recorded start identity still matches (hearsay-tools/cezarion#1717).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

# Hold the environment through this entire command, before any descriptor/build mutation.
# The second entry registers the shell as well, so a killed supervisor cannot unprotect it.
if [ "${TEST_ENV_LEASE_ENTRY:-}" != "$SCRIPT_DIR/test-env-down.sh" ]; then
  exec node "$SCRIPT_DIR/test-env-lease.mjs" run sh "$SCRIPT_DIR/test-env-down.sh" "$@"
fi
unset TEST_ENV_LEASE_ENTRY
node "$SCRIPT_DIR/test-env-lease.mjs" join "$$"
QA_DIR="$REPO_ROOT/.ai/qa"
ENV_DESCRIPTOR="$QA_DIR/test-env.json"

log() { echo "[test-env] $*" >&2; }

[ -f "$ENV_DESCRIPTOR" ] || { log "no descriptor — nothing to stop"; exit 0; }

# Only ever stop what this repo started, and only the recorded incarnation; safe to run twice.
# An app that would not stop keeps its descriptor running, so down can try again.
node "$SCRIPT_DIR/test-env-lease.mjs" stop-app 10000

node -e '
  const fs = require("fs");
  const f = process.argv[1];
  try {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    d.status = "stopped";
    fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
  } catch { /* leave a corrupt descriptor alone — up will treat it as stale */ }
' "$ENV_DESCRIPTOR"

rm -rf "$QA_DIR/test-env.lock" 2>/dev/null || true
echo "TEST_ENV_STATUS=stopped"
