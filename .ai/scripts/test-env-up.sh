#!/bin/sh
# om-prepare-test-env: generated entrypoint (contract v2)
# regenerate with: om-prepare-test-env --regenerate
# history:
#   2026-07-14 generated (cold ~40s, warm ~2s) — cezar has no backing services, so
#             the service-provisioning step of the contract is deliberately absent.
#   2026-07-21 detach the app with nohup so non-interactive bootstrap shells do not
#             terminate the healthy server immediately after the script exits.
#   2026-07-21 start a new session when setsid is available; some task runners reap
#             every process left in the bootstrap shell's process group despite nohup.
#   2026-07-30 stop requiring packages/api-client/dist after the contract-workspace
#             migration made the client typecheck-only; server + web are the runtime artifacts.
#   2026-07-30 run npm ci before building and cache-check installed runtime dependencies;
#             fresh worktrees have no workspace links, so tsc otherwise resolves contract
#             imports as missing/unknown and a cached build cannot start without node_modules.
#   2026-07-30 execute the compound preparation chain through sh -c and stop requiring an
#             api-client dist artifact that this source-aliased workspace does not produce.
#   2026-09-03 log every try_reuse bail-out: a refused reuse still exits 0, so silent
#             returns left the next failure undiagnosable (#31).
#   2026-09-03 keep milliseconds in startedAt so find -newermt does not treat
#             files from the boot's own second as changed (#36).
#   2026-10-14 build the e2e bundle into the ignored .ai/qa/build/cezar mirror via
#             build-e2e.sh and boot from there; packages/cezar/dist and web/dist (the
#             production build, a declared Squeal input) are never written by a test boot.
#   2026-10-14 serve an isolated clone (.ai/qa/served/<name>, e2e-served-repo.mjs) instead
#             of the checkout: in the main checkout the live cockpit owns .ai/cezar and
#             refused the server. Drop the old descriptor before a cold boot, so a failed
#             boot reports its own error rather than a dead env's browser notes. A reuse
#             syncs the clone to the checkout's current edits; a moved HEAD cold-boots.
#   2026-10-15 scrub every ambient CEZ_* before boot (hearsay-tools/cezarion#1045): an agent's
#             shell inherits the live cockpit's opt-ins, which CI never sets. Opt-ins are
#             requested with --server-env=CEZ_NAME=value and are part of the reuse key.
set -eu

# ---- project-specific parameters -------------------------------------------
# Everything below the next banner is generic contract logic; tweak only here.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# <root>/.ai/scripts/test-env-up.sh → <root>. Derived from the script's own path so this
# works unchanged inside a git worktree (no `git rev-parse`, no cwd assumption).
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

# Hold the environment through this entire command, before any descriptor/build mutation.
# The second entry registers the shell as well, so a killed supervisor cannot unprotect it.
if [ "${TEST_ENV_LEASE_ENTRY:-}" != "$SCRIPT_DIR/test-env-up.sh" ]; then
  exec node "$SCRIPT_DIR/test-env-lease.mjs" run sh "$SCRIPT_DIR/test-env-up.sh" "$@"
fi
unset TEST_ENV_LEASE_ENTRY
node "$SCRIPT_DIR/test-env-lease.mjs" join "$$"

QA_DIR="$REPO_ROOT/.ai/qa"
ENV_DESCRIPTOR="$QA_DIR/test-env.json"
LOCK_DIR="$QA_DIR/test-env.lock"
CACHE_FILE="$QA_DIR/.build-cache"
APP_LOG="$QA_DIR/test-env-app.log"
BROWSER_DESCRIPTOR=".ai/browsers/agent-browser.md"
BROWSER_LAUNCH_JSON="$QA_DIR/browser-launch.json"
BROWSER_DOCTOR_JSON="$QA_DIR/browser-doctor.json"
# The project the server serves, and every spec that seeds project state writes into
# (descriptor `servedRoot`). A fresh clone per cold boot, so the server's runs, worktrees
# and seeded files never land in this checkout's own .ai/cezar. A local lane is already
# such a clone (e2e-lanes.mjs) and serves itself.
if [ -f "$REPO_ROOT/.git/cezar-e2e-lane.json" ]; then
  SERVED_ROOT=$REPO_ROOT
else
  SERVED_ROOT="$QA_DIR/served/${REPO_ROOT##*/}"
fi

PREFERRED_PORT=4321
HEALTH_PATH="/api/v1/health"
HEALTH_TIMEOUT=${TEST_ENV_HEALTH_TIMEOUT_SECONDS:-180}
if ! node -e 'const s=process.argv[1]; process.exit(/^[1-9][0-9]*$/.test(s) && Number.isSafeInteger(Number(s)) ? 0 : 1)' -- "$HEALTH_TIMEOUT"; then
  echo "TEST_ENV_HEALTH_TIMEOUT_SECONDS must be a positive integer number of seconds" >&2
  exit 2
fi
# The detached app's watcher (test-env-lease.mjs watch-app) reads both; refuse a bad value here,
# before anything boots (#1448); unset or empty uses the default. 0 minutes turns the idle exit off; a deleted checkout still stops it.
if ! node -e 'const s=process.argv[1]; process.exit(s === "" || /^\d+(\.\d+)?$/.test(s) ? 0 : 1)' -- "${TEST_ENV_IDLE_EXIT_MINUTES:-}"; then
  echo "TEST_ENV_IDLE_EXIT_MINUTES must be a non-negative number of minutes (default 30; 0 turns the idle exit off)" >&2
  exit 2
fi
if ! node -e 'const s=process.argv[1]; process.exit(s === "" || (/^\d+(\.\d+)?$/.test(s) && Number(s) > 0) ? 0 : 1)' -- "${TEST_ENV_WATCH_INTERVAL_SECONDS:-}"; then
  echo "TEST_ENV_WATCH_INTERVAL_SECONDS must be a positive number of seconds (default 30)" >&2
  exit 2
fi
TEST_ENV_CACHE_TTL_SECONDS=${TEST_ENV_CACHE_TTL_SECONDS:-600}

# The preparation chain: install workspace links/dependencies, then build-e2e.sh — server
# `tsc` → .ai/qa/build/cezar/dist/ and `vite build` → .ai/qa/build/cezar/web/dist/, in a
# mirror of the server package that links back to its scripts and node_modules. All are
# required — a fresh worktree has no node_modules, and the server serves the React cockpit
# from <its package>/web/dist (missing it would silently test the fallback hint page).
# The bundle is built with VITE_CEZ_E2E=1, the cockpit e2e mode (#415). The production
# packages/cezar/dist and packages/cezar/web/dist are never written here.
E2E_BUILD_ROOT=.ai/qa/build/cezar
BUILD_COMMAND="pnpm install --frozen-lockfile && sh .ai/scripts/build-e2e.sh"
BUILD_ARTIFACTS="packages/cezar/node_modules/zod/package.json $E2E_BUILD_ROOT/dist/index.js $E2E_BUILD_ROOT/web/dist/index.html"
# Vite emits this marker only under VITE_CEZ_E2E=1: proof the bundle is an e2e one.
E2E_BUILD_MARKER="$REPO_ROOT/$E2E_BUILD_ROOT/web/dist/.cez-e2e-build"
# Fingerprint inputs — a change to any of these invalidates the cached build. Each workspace
# contributes its own sources AND its own manifest: a dependency moved between packages
# changes what gets bundled without touching a single source file.
BUILD_INPUT_PATHS="packages/contract/src packages/contract/package.json packages/cezar/src packages/cezar/package.json packages/cezar/tsconfig.json packages/api-client/src packages/api-client/package.json packages/cezar/scripts/inline-contract.mjs packages/web/src packages/web/public packages/web/index.html packages/web/vite.config.ts packages/web/package.json package.json pnpm-lock.yaml pnpm-workspace.yaml .ai/scripts/test-env-up.sh .ai/scripts/build-e2e.sh"

# No ambient CEZ_* reaches the server (hearsay-tools/cezarion#1045). An agent's shell inherits
# the live cockpit's opt-ins (CEZ_PREVIEW=1, CEZ_AUTOMATIONS=1, …) and its per-task plumbing
# (CEZ_TASK_ID, CEZ_DELEGATION_*, …), so a local boot differed from CI in ways nobody chose.
# Every CEZ_* goes rather than a list of known opt-ins: a list is one new flag away from the
# same leak. A run that wants a flag asks for it with --server-env=CEZ_NAME=value below.
for name in $(node -e 'for (const key of Object.keys(process.env)) if (/^CEZ_\w+$/i.test(key)) console.log(key)'); do
  unset "$name"
done

# CEZ_DRY_RUN=1 swaps the agent CLIs for the bundled mock, so booting needs no
# `claude` login and reaches no network — the whole point for CI/e2e.
export CEZ_DRY_RUN=1

# The real CLI writes workspace state at boot (~/.cezar migrations + project
# registration) — pin CEZ_HOME under .ai/qa so a test boot never touches the
# developer's real ~/.cezar. Kept stable (not per-boot) so the reuse path
# attaches to the same workspace the running instance was booted with.
export CEZ_HOME="$QA_DIR/cez-home"

FORCE=0
FORCE_REBUILD=0
# The explicit opt-ins, sorted and space-joined: what the server boots with on top of the two
# pins above, and the reuse key (a running env booted with other flags is not this env).
SERVER_ENV=
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --force-rebuild) FORCE_REBUILD=1 ;;
    --server-env=*)
      assignment=${arg#--server-env=}
      name=${assignment%%=*}
      if ! printf '%s\n' "$assignment" | grep -Eq '^CEZ_[A-Z0-9_]+=[^[:space:]]*$' \
        || [ "$name" = CEZ_DRY_RUN ] || [ "$name" = CEZ_HOME ]; then
        echo "invalid --server-env: $assignment (want CEZ_NAME=value, no whitespace; CEZ_DRY_RUN and CEZ_HOME are pinned)" >&2
        exit 2
      fi
      # One assignment per name: the key below is sorted, so CEZ_X=0 CEZ_X=1 and its reverse
      # would share a key while booting different values.
      case " $SERVER_ENV " in
        *" $name="*) echo "invalid --server-env: $name is given twice" >&2; exit 2 ;;
      esac
      export "$assignment"
      SERVER_ENV="$SERVER_ENV $assignment" ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done
set -f
SERVER_ENV=$(node -e 'process.stdout.write([...new Set(process.argv.slice(1))].sort().join(" "))' $SERVER_ENV)
set +f
# Recorded as "none" rather than empty, so a descriptor written before the key existed (and
# possibly booted with ambient opt-ins) never matches and is cold-booted once.
SERVER_ENV_KEY=${SERVER_ENV:-none}

# ---- generic contract logic -------------------------------------------------

mkdir -p "$QA_DIR"

# The shared E2E server also runs Git. Give it an empty config source and a
# deterministic commit identity before boot, independent of the host machine.
: > "$QA_DIR/gitconfig"
export GIT_CONFIG_GLOBAL="$QA_DIR/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME='Cezar Tests'
export GIT_AUTHOR_EMAIL='tests@cezar.invalid'
export GIT_COMMITTER_NAME='Cezar Tests'
export GIT_COMMITTER_EMAIL='tests@cezar.invalid'

log() { echo "[test-env] $*" >&2; }

# Never assume python3 exists — cascade through whatever the machine has.
free_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
  elif command -v python >/dev/null 2>&1; then
    python -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
  elif command -v node >/dev/null 2>&1; then
    node -e 's=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
  else
    awk 'BEGIN{srand();print 20000+int(rand()*20000)}'
  fi
}

port_free() {
  node -e '
    const net = require("net");
    const s = net.createServer();
    s.once("error", () => process.exit(1));
    s.listen(Number(process.argv[1]), "127.0.0.1", () => s.close(() => process.exit(0)));
  ' "$1" 2>/dev/null
}

http_ok() { curl -fsS --max-time "${2:-5}" "$1" >/dev/null 2>&1; }

json_get() { node -e '
  const fs = require("fs");
  try {
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), d);
    if (v !== undefined && v !== null) process.stdout.write(String(v));
  } catch { /* absent or corrupt descriptor → empty, caller treats as stale */ }
' "$1" "$2" 2>/dev/null; }

# ---- 2. lock — one bootstrap at a time --------------------------------------
# The outer test-env lease protects the full invocation. This inner lock serializes
# nested bootstraps belonging to the SAME invocation. Released after bootstrap:
# the server `readFileSync`s its web/dist per request, so a later rebuild under a
# running app is picked up on the next reload instead of corrupting it. The reuse check's
# "source newer than startedAt" test is what keeps a stale build from being tested.
LOCK_HELD=0
release_lock() { [ "$LOCK_HELD" = 1 ] && rm -rf "$LOCK_DIR" 2>/dev/null || true; }
trap release_lock EXIT INT TERM

acquire_lock() {
  waited=0
  while : ; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      LOCK_HELD=1
      printf '{"pid":%s,"source":"test-env-up.sh","acquiredAt":"%s"}\n' \
        "$$" "$(date -u +%FT%TZ)" > "$LOCK_DIR/owner.json"
      return 0
    fi
    owner=$(json_get "$LOCK_DIR/owner.json" pid || true)
    # Owner PID dead → stale lock from a crashed run; remove and retake.
    if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then
      log "removing stale lock (owner pid ${owner:-unknown} is gone)"
      rm -rf "$LOCK_DIR" 2>/dev/null || true
      continue
    fi
    if [ "$waited" -ge 300 ]; then
      log "timed out waiting for the bootstrap lock held by pid $owner"
      exit 1
    fi
    [ "$waited" = 0 ] && log "another bootstrap (pid $owner) is running — waiting"
    sleep 2
    waited=$((waited + 2))
  done
}

# ---- 3. reuse check — attach, don't reboot ----------------------------------
emit() {
  reused=$1
  cat <<EOF
TEST_ENV_STATUS=running
TEST_ENV_BASE_URL=$BASE_URL
TEST_ENV_DESCRIPTOR=.ai/qa/test-env.json
TEST_ENV_REUSED=$reused
BROWSER_PROVIDER=agent-browser
BROWSER_INSTALLED=$BROWSER_INSTALLED
EOF
}

try_reuse() {
  # Every bail-out logs its reason: a refused reuse cold-boots with exit 0, so a
  # caller that only checks TEST_ENV_REUSED would otherwise never learn why (#31).
  [ "$FORCE" = 1 ] && { log "not reusing: --force was passed"; return 1; }
  [ -f "$ENV_DESCRIPTOR" ] || { log "not reusing: no descriptor at $ENV_DESCRIPTOR"; return 1; }
  [ "$(json_get "$ENV_DESCRIPTOR" status)" = running ] || { log "not reusing: descriptor status is not running"; return 1; }
  [ -f "$E2E_BUILD_MARKER" ] || { log "not reusing: cockpit bundle is not an e2e build"; return 1; }

  pid=$(json_get "$ENV_DESCRIPTOR" app.pid)
  url=$(json_get "$ENV_DESCRIPTOR" baseUrl)
  started=$(json_get "$ENV_DESCRIPTOR" startedAt)
  [ "$(json_get "$ENV_DESCRIPTOR" environment.serverEnv)" = "$SERVER_ENV_KEY" ] || { log "not reusing: the requested --server-env set changed (now: $SERVER_ENV_KEY)"; return 1; }
  [ "$(json_get "$ENV_DESCRIPTOR" servedRoot)" = "$SERVED_ROOT" ] && [ -d "$SERVED_ROOT" ] || { log "not reusing: the served project is not $SERVED_ROOT"; return 1; }
  { [ -n "$pid" ] && [ -n "$url" ]; } || { log "not reusing: descriptor has no app pid or base URL"; return 1; }
  # A state file is a claim, not proof: the PID must still be alive…
  kill -0 "$pid" 2>/dev/null || { log "not reusing: app pid $pid is gone"; return 1; }
  # …and the app must actually answer. Health first (deep: reads config + git),
  # then the app shell, which is what the e2e specs actually load.
  http_ok "$url$HEALTH_PATH" || { log "not reusing: $url$HEALTH_PATH is not answering"; return 1; }
  http_ok "$url/" || { log "not reusing: $url/ is not answering"; return 1; }

  # Fresh: within TTL and no tracked source newer than startedAt.
  if [ -n "$started" ]; then
    age=$(node -e 'const t=Date.parse(process.argv[1]);process.stdout.write(String(isNaN(t)?1e9:Math.round((Date.now()-t)/1000)))' "$started")
    [ "$age" -le "$TEST_ENV_CACHE_TTL_SECONDS" ] || { log "descriptor is stale (${age}s old)"; return 1; }
    # BSD find cannot parse the ISO timestamp (including milliseconds) that the
    # descriptor stores. Node compares mtimes directly on every supported host.
    # As with find, absent/unreadable paths and symlinks are skipped.
    newer=$(cd "$REPO_ROOT" && node -e '
      const fs = require("fs"), path = require("path");
      const startedMs = Date.parse(process.argv[1]);
      const walk = (p) => {
        try {
          const st = fs.lstatSync(p);
          if (st.isDirectory()) {
            for (const entry of fs.readdirSync(p)) {
              const newer = walk(path.join(p, entry));
              if (newer) return newer;
            }
          } else if (st.isFile() && st.mtimeMs > startedMs) return p;
        } catch { /* absent or unreadable source */ }
        return "";
      };
      for (const input of process.argv.slice(2)) {
        const newer = walk(input);
        if (newer) { process.stdout.write(newer); break; }
      }
    ' "$started" $BUILD_INPUT_PATHS 2>/dev/null || true)
    [ -z "$newer" ] || { log "source changed since boot ($newer)"; return 1; }
  fi

  # The server reads its project live. Bring the clone to the checkout's current edits, as
  # serving the checkout itself did; a moved HEAD needs a fresh clone, so a cold boot.
  if [ "$SERVED_ROOT" != "$REPO_ROOT" ]; then
    node "$SCRIPT_DIR/e2e-served-repo.mjs" --sync "$REPO_ROOT" "$SERVED_ROOT" || {
      log "not reusing: the served project cannot follow this checkout (HEAD moved, or the sync failed)"
      return 1
    }
  fi

  BASE_URL=$url
  BROWSER_INSTALLED=$(json_get "$ENV_DESCRIPTOR" browser.installed)
  [ "$BROWSER_INSTALLED" = true ] && BROWSER_INSTALLED=1 || BROWSER_INSTALLED=0
  return 0
}

teardown_stale() {
  [ -f "$ENV_DESCRIPTOR" ] || return 0
  pid=$(json_get "$ENV_DESCRIPTOR" app.pid)
  own=$(json_get "$ENV_DESCRIPTOR" startedByThisRepo)
  # Only ever kill what this repo started.
  if [ -n "$pid" ] && [ "$own" = true ] && kill -0 "$pid" 2>/dev/null; then
    log "stopping stale instance (pid $pid)"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  # A cold boot replaces the env, so its descriptor goes now: specs that run after a failed
  # boot must report "no env", not attach to a dead baseUrl or repeat its browser notes.
  rm -f "$ENV_DESCRIPTOR"
}

prepare_served_repo() {
  [ "$SERVED_ROOT" = "$REPO_ROOT" ] && return 0
  log "cloning the served project into $SERVED_ROOT"
  node "$SCRIPT_DIR/e2e-served-repo.mjs" "$REPO_ROOT" "$SERVED_ROOT" >/dev/null || {
    log "cannot prepare the served project at $SERVED_ROOT"
    exit 1
  }
}

# ---- 4. build cache ---------------------------------------------------------
# Node rather than `find | xargs stat`: `stat` takes -c on GNU and -f on BSD, and this
# repo already requires Node 20+ — no reason to guess the flavor.
fingerprint() {
  (cd "$REPO_ROOT" && node -e '
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    const parts = [];
    const walk = (p) => {
      let st;
      try { st = fs.statSync(p); } catch { return; }
      if (st.isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
      else if (st.isFile()) parts.push(`${p}:${st.size}:${Math.floor(st.mtimeMs)}`);
    };
    for (const r of process.argv.slice(1)) walk(r);
    process.stdout.write(crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16));
  ' $BUILD_INPUT_PATHS)
}

artifacts_present() {
  for a in $BUILD_ARTIFACTS; do
    [ -f "$REPO_ROOT/$a" ] || return 1
  done
  return 0
}

ensure_build() {
  # Local parallel lanes link to a single, already-built source checkout. Never build in
  # a lane: it would replace shared symlink targets while other lanes are reading them.
  if [ "${E2E_PREBUILT_ASSETS:-}" = 1 ]; then
    artifacts_present && [ -f "$E2E_BUILD_MARKER" ] || {
      log "prebuilt lane is missing e2e build artifacts"
      exit 1
    }
    log "using prebuilt e2e assets"
    return 0
  fi
  fp=$(fingerprint)
  cached=""
  [ -f "$CACHE_FILE" ] && cached=$(cat "$CACHE_FILE" 2>/dev/null || true)
  if [ "$FORCE_REBUILD" = 0 ] && [ -n "$fp" ] && [ "$fp" = "$cached" ] && artifacts_present && [ -f "$E2E_BUILD_MARKER" ]; then
    log "build cache hit — skipping $BUILD_COMMAND"
    return 0
  fi
  log "building ($BUILD_COMMAND)"
  (cd "$REPO_ROOT" && sh -c "$BUILD_COMMAND" >"$QA_DIR/test-env-build.log" 2>&1) || {
    log "build failed — see .ai/qa/test-env-build.log"
    tail -20 "$QA_DIR/test-env-build.log" >&2 || true
    exit 1
  }
  artifacts_present || { log "build produced no artifacts ($BUILD_ARTIFACTS)"; exit 1; }
  [ -f "$E2E_BUILD_MARKER" ] || { log "build produced no e2e cockpit marker ($E2E_BUILD_MARKER)"; exit 1; }
  printf '%s' "$fp" > "$CACHE_FILE"
}

# ---- browser provider (per .ai/browsers/agent-browser.md: ensure-installed) --
# Never fails the boot: e2e degrades to a loud SKIP when the provider is unavailable,
# and everything else about the environment stays usable.
BROWSER_INSTALLED=0
BROWSER_COMMAND=""
BROWSER_VERSION=unknown
BROWSER_NOTES=""
BROWSER_NAMESPACE=cez-e2e
BROWSER_LAUNCH_ARGS_CSV=""
BROWSER_RUNTIME_TMPDIR=""

# Container Chrome needs `--no-sandbox`; Cezar worktree TMPDIR makes SingletonSocket
# exceed sockaddr_un. Resolve once, pass the same flags/env to doctor and the probe, and
# record the flags for every later invocation. The TMPDIR in the descriptor is THIS boot's
# answer only: a caller reusing the env decides its own (hearsay-tools/cezarion#1090).
# Doctor's own launch test ignores `--args`, so a live `open` probe is what
# decides installed vs "Chrome is present but bootstrap settings were unusable".
resolve_browser_launch() {
  if ! node "$SCRIPT_DIR/resolve-browser-launch.mjs" > "$BROWSER_LAUNCH_JSON" 2>/dev/null; then
    printf '%s\n' '{"inContainer":false,"launchArgs":[],"runtimeEnv":{},"namespace":"cez-e2e"}' > "$BROWSER_LAUNCH_JSON"
  fi
  BROWSER_NAMESPACE=$(json_get "$BROWSER_LAUNCH_JSON" namespace)
  [ -n "$BROWSER_NAMESPACE" ] || BROWSER_NAMESPACE=cez-e2e
  BROWSER_LAUNCH_ARGS_CSV=$(json_get "$BROWSER_LAUNCH_JSON" launchArgs)
  BROWSER_RUNTIME_TMPDIR=$(json_get "$BROWSER_LAUNCH_JSON" runtimeEnv.TMPDIR)
}

persist_browser_launch() {
  node -e '
    const fs = require("fs");
    const [path, csv, tmp, ns] = process.argv.slice(1);
    let j = {};
    try { j = JSON.parse(fs.readFileSync(path, "utf8")); } catch { /* start from empty */ }
    j.launchArgs = csv ? csv.split(",").filter(Boolean) : [];
    j.namespace = ns || j.namespace || "cez-e2e";
    if (tmp) j.runtimeEnv = { TMPDIR: tmp, TMP: tmp, TEMP: tmp };
    fs.writeFileSync(path, JSON.stringify(j) + "\n");
  ' "$BROWSER_LAUNCH_JSON" "$BROWSER_LAUNCH_ARGS_CSV" "$BROWSER_RUNTIME_TMPDIR" "$BROWSER_NAMESPACE"
}

run_browser() {
  if [ -n "$BROWSER_LAUNCH_ARGS_CSV" ]; then
    set -- --args "$BROWSER_LAUNCH_ARGS_CSV" "$@"
  fi
  if [ -n "$BROWSER_NAMESPACE" ]; then
    set -- --namespace "$BROWSER_NAMESPACE" "$@"
  fi
  if [ -n "$BROWSER_RUNTIME_TMPDIR" ]; then
    TMPDIR="$BROWSER_RUNTIME_TMPDIR" TMP="$BROWSER_RUNTIME_TMPDIR" TEMP="$BROWSER_RUNTIME_TMPDIR" \
      "$BROWSER_COMMAND" "$@"
  else
    "$BROWSER_COMMAND" "$@"
  fi
}

chrome_installed_from_doctor() {
  node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const chrome = (j.checks || []).find((c) => c.id === "chrome.installed");
      process.exit(chrome && chrome.status === "pass" ? 0 : 1);
    } catch { process.exit(1); }
  ' "$1"
}

browser_json_success() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        process.exit(j && j.success === true ? 0 : 1);
      } catch { process.exit(1); }
    });
  '
}

probe_browser() {
  session="cez-boot-probe-$$"
  out=$(run_browser --session "$session" open about:blank --json 2>/dev/null || true)
  run_browser --session "$session" close --json >/dev/null 2>&1 || true
  printf '%s' "$out" | browser_json_success
}

ensure_browser() {
  resolve_browser_launch
  if command -v agent-browser >/dev/null 2>&1; then
    BROWSER_COMMAND=$(command -v agent-browser)
  else
    CACHE_ROOT=${XDG_CACHE_HOME:-"$HOME/.cache"}
    TOOL_DIR="$CACHE_ROOT/agent-tools/agent-browser"
    mkdir -p "$TOOL_DIR"
    OS=$(uname -s 2>/dev/null || echo unknown)
    ARCH=$(uname -m 2>/dev/null || echo unknown)
    case "$ARCH" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) ARCH=unsupported ;; esac
    case "$OS" in
      Darwin) ASSET="agent-browser-darwin-$ARCH" ;;
      Linux)
        LIBC=linux
        (ldd --version 2>&1 || true) | grep -qi musl && LIBC=linux-musl
        ASSET="agent-browser-$LIBC-$ARCH"
        ;;
      MINGW*|MSYS*|CYGWIN*) ASSET=agent-browser-win32-x64.exe ;;
      *) ASSET=unsupported ;;
    esac
    case "$ASSET" in
      *unsupported*)
        BROWSER_NOTES="unsupported agent-browser target: $OS/$ARCH"
        persist_browser_launch
        return 0 ;;
    esac
    BROWSER_COMMAND="$TOOL_DIR/$ASSET"
    if [ ! -x "$BROWSER_COMMAND" ]; then
      URL="https://github.com/vercel-labs/agent-browser/releases/latest/download/$ASSET"
      TMP="$BROWSER_COMMAND.tmp.$$"
      log "installing agent-browser ($ASSET)"
      if command -v curl >/dev/null 2>&1; then
        curl -fL --retry 3 --connect-timeout 30 --max-time 600 -o "$TMP" "$URL" || {
          BROWSER_NOTES="download failed: $URL"; rm -f "$TMP"; persist_browser_launch; return 0; }
      elif command -v wget >/dev/null 2>&1; then
        wget -T 30 -t 3 -O "$TMP" "$URL" || { BROWSER_NOTES="download failed: $URL"; rm -f "$TMP"; persist_browser_launch; return 0; }
      else
        BROWSER_NOTES="no built-in HTTP downloader is available"; persist_browser_launch; return 0
      fi
      chmod 755 "$TMP"
      mv "$TMP" "$BROWSER_COMMAND"
    fi
  fi

  "$BROWSER_COMMAND" install >/dev/null 2>&1 || true
  doctor_ok=0
  if run_browser doctor --json --offline >"$BROWSER_DOCTOR_JSON" 2>/dev/null; then
    doctor_ok=1
  else
    # Linux Chrome libraries may need root; only try when it costs no prompt.
    if [ "$(uname -s 2>/dev/null || true)" = Linux ]; then
      if [ "$(id -u)" = 0 ]; then
        "$BROWSER_COMMAND" install --with-deps >/dev/null 2>&1 || true
      elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
        sudo -n "$BROWSER_COMMAND" install --with-deps >/dev/null 2>&1 || true
      fi
    fi
    if run_browser doctor --json --offline >"$BROWSER_DOCTOR_JSON" 2>/dev/null; then
      doctor_ok=1
    fi
  fi
  if [ "$doctor_ok" = 1 ]; then
    BROWSER_INSTALLED=1
    BROWSER_VERSION=$(run_browser --version 2>/dev/null || echo unknown)
  elif probe_browser; then
    BROWSER_INSTALLED=1
    BROWSER_VERSION=$(run_browser --version 2>/dev/null || echo unknown)
    BROWSER_NOTES="doctor launch test failed; live launch succeeded"
  else
    case ",$BROWSER_LAUNCH_ARGS_CSV," in
      *,--no-sandbox,*) ;;
      *)
        prior_args=$BROWSER_LAUNCH_ARGS_CSV
        if [ -n "$BROWSER_LAUNCH_ARGS_CSV" ]; then
          BROWSER_LAUNCH_ARGS_CSV="$BROWSER_LAUNCH_ARGS_CSV,--no-sandbox"
        else
          BROWSER_LAUNCH_ARGS_CSV=--no-sandbox
        fi
        if probe_browser; then
          BROWSER_INSTALLED=1
          BROWSER_VERSION=$(run_browser --version 2>/dev/null || echo unknown)
          BROWSER_NOTES="doctor launch test failed; live launch succeeded"
        else
          BROWSER_LAUNCH_ARGS_CSV=$prior_args
        fi
        ;;
    esac
    if [ "$BROWSER_INSTALLED" != 1 ]; then
      if chrome_installed_from_doctor "$BROWSER_DOCTOR_JSON"; then
        BROWSER_NOTES="installed Chrome failed to launch with resolved settings"
      else
        BROWSER_NOTES="live browser launch failed after autonomous install"
      fi
    fi
  fi
  persist_browser_launch
}

# ---- 6. app start + health wait ---------------------------------------------
start_app() {
  PORT=$PREFERRED_PORT
  port_free "$PORT" || PORT=$(free_port)
  BASE_URL="http://127.0.0.1:$PORT"

  log "starting cezar on $BASE_URL (CEZ_DRY_RUN=1${SERVER_ENV:+ $SERVER_ENV})"
  # --no-open: a test boot must never hijack the operator's browser.
  # Detach through Node on every host: the cached app survives the caller and is
  # outside the command group retained by a crashed build's lifetime lease.
  APP_PID=$(cd "$REPO_ROOT" && node "$SCRIPT_DIR/test-env-lease.mjs" detach-app "$APP_LOG" \
    "$E2E_BUILD_ROOT/dist/index.js" --port "$PORT" --no-open --repo "$SERVED_ROOT")

  health_started=$(date +%s)
  health_deadline=$((health_started + HEALTH_TIMEOUT))
  while : ; do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      log "the app exited during boot — see .ai/qa/test-env-app.log"
      tail -20 "$APP_LOG" >&2 || true
      exit 1
    fi
    health_now=$(date +%s)
    remaining=$((health_deadline - health_now))
    [ "$remaining" -gt 0 ] || break
    # A slow probe must not spend five extra seconds past the overall deadline.
    probe_timeout=5
    [ "$remaining" -ge 5 ] || probe_timeout=$remaining
    if http_ok "$BASE_URL$HEALTH_PATH" "$probe_timeout"; then
      health_now=$(date +%s)
      if [ "$health_now" -lt "$health_deadline" ]; then
        log "healthy after $((health_now - health_started))s"
        return 0
      fi
      break
    fi
    health_now=$(date +%s)
    [ "$health_now" -lt "$health_deadline" ] || break
    sleep 1
  done
  log "health wait timed out after $((health_now - health_started))s — see .ai/qa/test-env-app.log"
  tail -20 "$APP_LOG" >&2 || true
  kill "$APP_PID" 2>/dev/null || true
  exit 1
}

# ---- 7. descriptor write ----------------------------------------------------
write_descriptor() {
  SINGLE_PROJECT=false
  [ "${CEZ_SINGLE_PROJECT:-}" = 1 ] && SINGLE_PROJECT=true
  node -e '
    const fs = require("fs");
    const [out, baseUrl, port, pid, cmd, bInstalled, bCmd, bVer, bNotes, desc, singleProject, platform, launchPath, servedRoot, serverEnv] = process.argv.slice(1);
    let launch = {};
    try { launch = JSON.parse(fs.readFileSync(launchPath, "utf8")); } catch { /* resolver absent */ }
    const browser = {
      provider: "agent-browser",
      installed: bInstalled === "1",
      command: bCmd,
      version: bVer,
      descriptor: desc,
      notes: bNotes,
      launchArgs: Array.isArray(launch.launchArgs) ? launch.launchArgs : [],
      namespace: launch.namespace || "cez-e2e",
    };
    if (launch.runtimeEnv && Object.keys(launch.runtimeEnv).length) browser.runtimeEnv = launch.runtimeEnv;
    fs.writeFileSync(out, JSON.stringify({
      version: 1,
      runId: "cezar-" + new Date().toISOString().slice(0, 10) + "-" + pid,
      status: "running",
      mode: "prod",
      baseUrl,
      servedRoot,
      startedByThisRepo: true,
      startScript: ".ai/scripts/test-env-up.sh",
      stopScript: ".ai/scripts/test-env-down.sh",
      app: { startCommand: cmd, port: Number(port), healthPath: "/api/v1/health", pid: Number(pid) },
      services: [],
      credentials: [],
      environment: { singleProject: singleProject === "true", serverEnv },
      browser,
      testRunner: { name: "other", config: "packages/web/e2e/vitest.config.ts" },
      platform,
      startedAt: new Date().toISOString(),
      notes: "Booted from the VITE_CEZ_E2E=1 build in .ai/qa/build/cezar (never packages/cezar/dist) after pnpm install --frozen-lockfile with CEZ_DRY_RUN=1, so workspace links/runtime dependencies are present, the agent CLIs are mocked, and no agent login/network is needed. Serves servedRoot, an isolated clone of this checkout. No backing services. Stop with .ai/scripts/test-env-down.sh. App log: .ai/qa/test-env-app.log.",
    }, null, 2) + "\n");
  ' "$ENV_DESCRIPTOR" "$BASE_URL" "$PORT" "$APP_PID" \
    "${SERVER_ENV:+$SERVER_ENV }CEZ_DRY_RUN=1 CEZ_HOME=.ai/qa/cez-home node $E2E_BUILD_ROOT/dist/index.js --port $PORT --no-open --repo $SERVED_ROOT" \
    "$BROWSER_INSTALLED" "$BROWSER_COMMAND" "$BROWSER_VERSION" "$BROWSER_NOTES" "$BROWSER_DESCRIPTOR" \
    "$SINGLE_PROJECT" "$(uname -s 2>/dev/null | grep -qi Linux && { grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null && echo wsl2 || echo linux; } || echo darwin)" \
    "$BROWSER_LAUNCH_JSON" "$SERVED_ROOT" "$SERVER_ENV_KEY"
}

# ---- main -------------------------------------------------------------------
acquire_lock

if try_reuse; then
  log "reusing the healthy instance at $BASE_URL"
  emit 1
  exit 0
fi

teardown_stale
ensure_browser
ensure_build
prepare_served_repo
start_app
write_descriptor
emit 0
