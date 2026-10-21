#!/bin/sh
# Runs the cockpit e2e suite: boot (or reuse) the test env, then drive it through the
# configured browser provider. Invoked by `npm run test:e2e` — the dispatcher's UI gate.
#
# Exit codes (documented contract — the pipeline depends on these):
#   0  + TEST_E2E_STATUS=passed   every selected spec passed (filters are not a full gate)
#   0  + TEST_E2E_STATUS=skipped  the browser provider could not be provisioned on this
#                                 machine (no network / unsupported platform / sandbox).
#                                 Loud, greppable, and deliberately non-blocking — a machine
#                                 that cannot run a browser must not masquerade as a failure,
#                                 and must not masquerade as a pass either.
#   non-zero + TEST_E2E_STATUS=failed  a spec failed, or the env could not boot.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

# Hold the environment through this entire command, before any descriptor/build mutation.
# The second entry registers the shell as well, so a killed supervisor cannot unprotect it.
if [ "${TEST_ENV_LEASE_ENTRY:-}" != "$SCRIPT_DIR/e2e.sh" ]; then
  exec node "$SCRIPT_DIR/test-env-lease.mjs" run sh "$SCRIPT_DIR/e2e.sh" "$@"
fi
unset TEST_ENV_LEASE_ENTRY
node "$SCRIPT_DIR/test-env-lease.mjs" join "$$"

skip() {
  cat >&2 <<EOF

################################################################################
# E2E SKIPPED — the UI was NOT verified.
#
# Reason: $1
#
# The agent-browser provider (.ai/browsers/agent-browser.md) could not be
# provisioned here, so no spec ran. This is NOT a pass. Re-run on a machine with
# network access to the GitHub Releases and Chrome-for-Testing hosts.
################################################################################

EOF
  echo "TEST_E2E_STATUS=skipped"
  exit 0
}

# Consume only our bootstrap flags; Vitest owns spec paths, -t, --shard, etc.
# The for loop snapshots the original arguments. Rotate each retained argument
# onto the end of "$@" without flattening quoted patterns or evaluating shell text.
# A literal -- ends wrapper parsing as well as Vitest option parsing.
FORCE=
FORCE_REBUILD=
# --server-env=CEZ_NAME=value opt-ins for the shared server (hearsay-tools/cezarion#1045);
# They are space-joined below, so one carrying whitespace is refused HERE: flattened first, a
# quoted '--server-env=CEZ_X=1 --force-rebuild' would reach test-env-up.sh as two valid flags.
# test-env-up.sh validates the rest of the shape.
SERVER_ENV=
FORWARD_ONLY=0
for arg in "$@"; do
  shift
  if [ "$FORWARD_ONLY" = 1 ]; then
    set -- "$@" "$arg"
    continue
  fi
  case "$arg" in
    --force) FORCE=--force ;;
    --force-rebuild) FORCE_REBUILD=--force-rebuild ;;
    --server-env=*[[:space:]]*)
      echo "invalid --server-env: $arg (no whitespace)" >&2
      echo "TEST_E2E_STATUS=failed" >&2
      exit 2 ;;
    --server-env=*) SERVER_ENV="$SERVER_ENV $arg" ;;
    --) FORWARD_ONLY=1; set -- "$@" "$arg" ;;
    *) set -- "$@" "$arg" ;;
  esac
done

bootstrap() {
  # Function positional parameters are separate from the retained Vitest args.
  set --
  if [ -n "$FORCE" ]; then set -- "$@" "$FORCE"; fi
  if [ -n "$FORCE_REBUILD" ]; then set -- "$@" "$FORCE_REBUILD"; fi
  set -f
  for assignment in $SERVER_ENV; do set -- "$@" "$assignment"; done
  set +f
  sh "$SCRIPT_DIR/test-env-up.sh" "$@"
}

# ---- 1. boot or reuse the environment ---------------------------------------
# The up script is the single source of truth for how this app boots; it also runs the
# provider's ensure-installed operation and records the result in the descriptor.
if ! bootstrap; then
  echo "TEST_E2E_STATUS=failed" >&2
  exit 1
fi

export TEST_ENV_LEASE_BOOTSTRAPPED=1

# ---- 2. gate on the provider ------------------------------------------------
DESCRIPTOR="$REPO_ROOT/.ai/qa/test-env.json"
installed=$(node -e '
  const fs = require("fs");
  try {
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(d.browser && d.browser.installed ? "1" : "0");
  } catch { process.stdout.write("0"); }
' "$DESCRIPTOR" 2>/dev/null || echo 0)

if [ "$installed" != 1 ]; then
  notes=$(node -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write((d.browser && d.browser.notes) || "agent-browser is unavailable");
    } catch { process.stdout.write("no test-env descriptor"); }
  ' "$DESCRIPTOR" 2>/dev/null || echo "agent-browser is unavailable")
  skip "$notes"
fi

# ---- 3. run the specs -------------------------------------------------------
cd "$REPO_ROOT"
# Bypass npm test's unit-project filters while retaining the installed Vitest binary.
if npm exec -- vitest run --config packages/web/e2e/vitest.config.ts "$@"; then
  echo "TEST_E2E_STATUS=passed"
  exit 0
fi
echo "TEST_E2E_STATUS=failed" >&2
exit 1
