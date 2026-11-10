# Switch-on test failures

Baseline main: `819ec5af0`. Switch enabled locally. Never commit the enabled constant.

This records the full captured baseline. Squeal was still running the full checkpoint when shared fixture repairs began. Final results are pending.

## Switch PR must change

- Run `node packages/mobile/scripts/build-metadata.mjs --write-ios`. It rewrites `packages/mobile/ios/ProductIdentity.xcconfig`. Keep `home/mobile-metadata.test.ts` unchanged. The switch PR must regenerate the checked-in artifact with the constant.

## Captured failures

319 failing checks in 89 files. Fixture and text classifications below describe the repair direction; final confirmation is pending.

### `.github/scripts/release-bump-pr.test.cjs`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- classifyFromEnv requires matching event/live head SHAs, file list, and version stamps: Expected values to be strictly equal:
- bot release bump needs release/v* head, bot author, and manifest-only files: Expected values to be strictly equal:
- manifest-only requires a non-empty allowlisted file set: Expected values to be strictly equal:
- allowlist matches release-finalization staged paths only: alias-cezarion/package.json

### `.github/scripts/release-finalization.test.cjs`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- a bump PR targeting a different base is a conflict, not a second PR: Cannot read properties of undefined (reading 'base')
- a branch created concurrently at the source commit is not fast-forwarded: Command failed: git add packages/*/package.json alias-hsq/package.json pnpm-lock.yaml fatal: pathspec 'alias-hsq/package.json' did not match any files
- a closed unmerged PR is reported for manual recovery without another PR: Cannot set properties of undefined (setting 'state')
- a merged PR whose branch was deleted is reused without resurrecting it: Cannot set properties of undefined (setting 'state')
- maintenance release PR targets the dispatched branch: Cannot read properties of undefined (reading 'base')
- PR permission failure leaves release finalization available and reports each outcome: The input did not match the regular expression /pull-requests: write/. Input:
- conflicting remote contents stay untouched and identify manual recovery: The input did not match the regular expression /conflict/i. Input:
- verbose native CI failure keeps recovery in the bounded summary: The "string" argument must be of type string. Received type undefined (undefined)
- native CI lookup failure does not prevent GitHub Release creation: Expected values to be strictly equal:
- existing bump PR missing native CI reports manual recovery without dispatch: Expected values to be strictly equal:
- App client only creates the PR; native CI and retries use the normal client: Expected values to be strictly equal:
- retry after a pushed branch and denied PR reuses the original commit: '' == true

### `packages/cezar/src/artifacts/cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- shows help successfully without context: expected 'Usage: hsq artifact publish <path>\nP…' to contain 'cez artifact publish'; diff (- Expected, + Received): - cez artifact publish | + Usage: hsq artifact publish <path> | + Publish an immutable local file snapshot from an active task. Returns JSON | + with metadata, a task-relative previ...
- dispatches artifact help before ordinary CLI parsing: Test timed out in 15000ms.

### `packages/cezar/src/automations/automation-cli-boundaries.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- automation CLI input boundaries > prints help with the default output for -h: expected "log" to be called with arguments: [ StringContaining "cez automation" ]
- automation CLI input boundaries > prints help with the default output for help: expected "log" to be called with arguments: [ StringContaining "cez automation" ]

### `packages/cezar/src/automations/schedule-runner.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- ScheduleRunner > a daily asleep for 3 days launches exactly one catch-up and advances from now: expected 'Missed 3 older occurrences while Squa…' to contain 'Missed 3 older occurrences while ceza…'
- ScheduleRunner > skips everything when the latest occurrence is older than 24h: expected [ { seq: 1, …(5) } ] to deeply equal [ ObjectContaining{…} ]; diff (- Expected, + Received): - "reason": StringContaining "3 occurrences while cezar was not running or the machine was asleep", | + "automationId": "nightly", | + "reason": "Missed 3 occurrences while Squawk was not running...
- ScheduleRunner > fires the latest missed occurrence once as catch-up when 2h late: expected 'Caught up the Mon 04:00 occurrence mi…' to contain 'missed while cezar was not running or…'

### `packages/cezar/src/automations/task-template.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- automation task templates > logs a retryable failed row for a reserved receipt no run ever claimed: expected [ { seq: 1, …(6) } ] to deeply equal [ ObjectContaining{…} ]; diff (- Expected, + Received): - "reason": StringContaining "Cezar restarted before run creation completed", | + "automationId": "nightly", | + "reason": "Squawk restarted before run creation completed; explicit retry is avail...

### `packages/cezar/src/cli-dispatch.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- main dispatch > prints the same help and exits 1 for an unknown command without preparing Home: expected "vi.fn()" to be called once with arguments: [ 'unknown command: nonsense\n' ]
- main dispatch > prints help for -h before repo or Home access: expected 'Squawk — local cockpit for AI agent t…' to contain 'cezar — local cockpit for AI agent ta…'; diff (- Expected, + Received): - cezar — local cockpit for AI agent tasks in your repo | + Squawk — local cockpit for AI agent tasks in your repo | + cez start the cockpit (server + GUI) for the...
- main dispatch > prints help for --help before repo or Home access: expected 'Squawk — local cockpit for AI agent t…' to contain 'cezar — local cockpit for AI agent ta…'; diff (- Expected, + Received): - cezar — local cockpit for AI agent tasks in your repo | + Squawk — local cockpit for AI agent tasks in your repo | + cez start the cockpit (server + GUI) for the...

### `packages/cezar/src/config.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- loadConfig machine-wide agent defaults > ignores a machine runner the schema refuses, rather than failing the load: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-machine-home-TkJuzM/config.json
- loadConfig machine-wide agent defaults > degrades to the built-in default when the machine file is corrupt: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-machine-home-DX80x7/config.json
- loadConfig machine-wide agent defaults > merges models per RUNNER, so pinning one does not discard the others: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-machine-home-b2w3YY/config.json
- loadConfig machine-wide agent defaults > NEVER overrules a repo that chose — that is what makes it a default: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-machine-home-6ZeEfX/config.json
- loadConfig machine-wide agent defaults > fills a repo whose config says nothing about the runner: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-machine-home-E4LoCZ/config.json
- loadConfig machine-wide agent defaults > fills a repo that has no config file at all: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-machine-home-17R6OB/config.json
- resolveWorktreeRetention > treats a malformed repo config as unset: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-home-tX595b/config.json
- resolveWorktreeRetention > treats a repo value the schema would refuse as unset, so the workspace seeds it: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-home-2Fjypl/config.json
- resolveWorktreeRetention > falls back to 10 when the workspace default itself is out of bounds: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-home-tJW3V8/config.json
- resolveWorktreeRetention > falls back to 10 when the workspace config is corrupt (unreadable): Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-home-RnYXCb/config.json
- resolveWorktreeRetention > keeps the repo's explicit 0 over the workspace default: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-home-GsLkma/config.json
- resolveWorktreeRetention > keeps a repo value that happens to equal the historical default (10 is not a sentinel): Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-home-zKWyGg/config.json
- resolveWorktreeRetention > keeps the repo's own value, workspace default ignored: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-home-osowHO/config.json
- resolveWorktreeRetention > inherits 0 (unlimited) — the workspace default is a value, not a truthiness test: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-home-nth619/config.json
- resolveWorktreeRetention > inherits it when the repo has no config file at all: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-home-1FJCdD/config.json
- resolveWorktreeRetention > inherits the workspace default when the repo sets nothing: Not a HomeStore file: /tmp/cez-vitest-tmp-rjj3nn/cez-home-hpXrrq/config.json

### `packages/cezar/src/core/agent-model-policy.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- agentModelsLocked > accepts the global workspace flag for every repository: Not a HomeStore file: /tmp/cez-vitest-tmp-Otv1rN/cez-model-policy-home-9By4SM/config.json

### `packages/cezar/src/core/product-env.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- keeps the migration source separate from the destination and the switch-off layout: expected '/new/config' to be '/legacy' // Object.is equality

### `packages/cezar/src/delegation/message-cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- task message command family > refuses wait --peer with --request, --mode or a positional, and a worker wait --peer: expected 'Use hsq message wait --request <UUID>…' to contain 'cez message wait --peer <task-id>'
- task message command family > rejects request resume and worker request waits with concrete replacements: expected 'Use hsq worker resume <worker-id> "<i…' to contain 'cez worker resume'
- task message command family > rejects worker send without kind instead of reporting a null delivery: expected { code: 'invalid_input', …(1) } to deeply equal { code: 'invalid_input', …(1) }; diff (- Expected, + Received): - "error": "Use cez message request; cez worker send was removed.", | + "error": "Use hsq message request; hsq worker send was removed.",
- task message command family > rejects removed worker wait-requests with exit 64 before transport: expected 'Use hsq message wait --request; hsq w…' to contain 'cez message'
- task message command family > rejects removed worker cancel-request with exit 64 before transport: expected 'Use hsq message cancel-request; hsq w…' to contain 'cez message'
- task message command family > rejects removed worker inbox with exit 64 before transport: expected 'Use hsq message inbox; hsq worker inb…' to contain 'cez message'
- task message command family > rejects removed worker conversation with exit 64 before transport: expected 'Use hsq message conversation; hsq wor…' to contain 'cez message'
- task message command family > rejects removed worker reply with exit 64 before transport: expected 'Use hsq message reply; hsq worker rep…' to contain 'cez message'
- task message command family > rejects removed worker follow-up with exit 64 before transport: expected 'Use hsq message follow-up; hsq worker…' to contain 'cez message'
- task message command family > rejects removed worker progress with exit 64 before transport: expected 'Use hsq message progress; hsq worker …' to contain 'cez message'
- task message command family > rejects removed worker send with exit 64 before transport: expected 'Use hsq message request; hsq worker s…' to contain 'cez message'
- task message command family > provides tasks help without transport: expected 'Squawk message — task conversations\n…' to contain 'cez message tasks'; diff (- Expected, + Received): - cez message tasks | + Squawk message — task conversations | +  | + Usage: | + hsq message tasks [--all] [--offset <n>] | +  | + Commands require an active delegation session and retu...
- task message command family > provides cancel-wait help without transport: expected 'Squawk message — task conversations\n…' to contain 'cez message cancel-wait'; diff (- Expected, + Received): - cez message cancel-wait | + Squawk message — task conversations | +  | + Usage: | + hsq message cancel-wait <wait-id> | +  | + Commands require an active delegation session and...
- task message command family > provides wait help without transport: expected 'Squawk message — task conversations\n…' to contain 'cez message wait'; diff (- Expected, + Received): - cez message wait | + Squawk message — task conversations | +  | + Usage: | + hsq message wait --request <UUID> [--request <UUID>...] [--mode one|any|all] [--timeout-seconds <1-1800>] ...
- task message command family > provides cancel-request help without transport: expected 'Squawk message — task conversations\n…' to contain 'cez message cancel-request'; diff (- Expected, + Received): - cez message cancel-request | + Squawk message — task conversations | +  | + Usage: | + hsq message cancel-request <UUID> | +  | + Commands require an active delegation sessi...
- task message command family > provides inbox help without transport: expected 'Squawk message — task conversations\n…' to contain 'cez message inbox'; diff (- Expected, + Received): - cez message inbox | + Squawk message — task conversations | +  | + Usage: | + hsq message inbox | +  | + Commands require an active delegation session and return JSON.
- task message command family > provides conversation help without transport: expected 'Squawk message — task conversations\n…' to contain 'cez message conversation'; diff (- Expected, + Received): - cez message conversation | + Squawk message — task conversations | +  | + Usage: | + hsq message conversation <task-id> [--before <cursor>] | +  | + Commands require an active...
- task message command family > provides reply help without transport: expected 'Squawk message — task conversations\n…' to contain 'cez message reply'; diff (- Expected, + Received): - cez message reply | + Squawk message — task conversations | +  | + Usage: | + hsq message reply <task-id> "<text>" --id <UUID> --request-id <UUID> | +  | + Commands require an active...
- task message command family > provides follow-up help without transport: expected 'Squawk message — task conversations\n…' to contain 'cez message follow-up'; diff (- Expected, + Received): - cez message follow-up | + Squawk message — task conversations | +  | + Usage: | + hsq message follow-up <task-id> "<text>" --id <UUID> --request-id <UUID> | +  | + Commands requi...
- task message command family > provides progress help without transport: expected 'Squawk message — task conversations\n…' to contain 'cez message progress'; diff (- Expected, + Received): - cez message progress | + Squawk message — task conversations | +  | + Usage: | + hsq message progress <task-id> "<text>" --id <UUID> | +  | + Commands require an active delegation...
- task message command family > provides request help without transport: expected 'Squawk message — task conversations\n…' to contain 'cez message request'; diff (- Expected, + Received): - cez message request | + Squawk message — task conversations | +  | + Usage: | + hsq message request <task-id> "<text>" --id <UUID> [--timeout-seconds <1-1800>] | +  | + Commands re...

### `packages/cezar/src/discovery/cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- dispatches discovery before global CLI parsing and needs no controller for help: expected 'hsq discover — inspect the host\'s de…' to contain 'cez discover models'; diff (- Expected, + Received): - cez discover models | + hsq discover — inspect the host's default-account catalog | +  | + Usage: | + hsq discover runners | + hsq discover models --runner <claude|codex|opencode|p...

### `packages/cezar/src/headless-run.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- runHeadless > keeps the review branch and missing-record fallbacks: expected [ [ 'task output' ], …(2) ] to deeply equal [ [ 'task output' ], …(2) ]; diff (- Expected, + Received): - changes ready for review on branch ? — inspect them in the cockpit: npx cezarion", | + changes ready for review on branch ? — inspect them in the cockpit: npx hsq", | - run review — ...
- runHeadless > reports cancelled and exits 1 after ordered teardown: expected "vi.fn()" to be called with arguments: [ Array(1) ]
- runHeadless > reports failed and exits 1 after ordered teardown: expected "vi.fn()" to be called with arguments: [ Array(1) ]
- runHeadless > reports review and exits 0 after ordered teardown: expected "vi.fn()" to be called with arguments: [ Array(1) ]
- runHeadless > reports done and exits 0 after ordered teardown: expected "vi.fn()" to be called with arguments: [ Array(1) ]

### `packages/cezar/src/home-write-guard.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- home write guard with HOME pinned to a sandbox > keeps a remote grant in its checked directory when env changes during mkdir: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-remote-Sjd0cg/remote-settings/4321.json'
- home write guard with HOME pinned to a sandbox > allows sandbox creation outside test runners: expected '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-…' to be '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-…' // Object.is equality
- home write guard with HOME pinned to a sandbox > checks a nested protected path before creating even a sandbox lock for remote disable: ENOENT: no such file or directory, symlink '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-nested-YzkUT4/account/.cezar' -> '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-nested-YzkUT4/sandbox/state/server-instances'
- home write guard with HOME pinned to a sandbox > checks a nested protected path before creating even a sandbox lock for install lock: ENOENT: no such file or directory, symlink '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-nested-mzhsPt/account/.cezar' -> '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-nested-mzhsPt/sandbox/state/server-instances'
- home write guard with HOME pinned to a sandbox > checks a nested protected path before creating even a sandbox lock for restore: ENOENT: no such file or directory, symlink '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-nested-etMyG4/account/.cezar' -> '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-nested-etMyG4/sandbox/state/server-instances'
- home write guard with HOME pinned to a sandbox > checks a nested protected path before creating even a sandbox lock for replace: ENOENT: no such file or directory, symlink '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-nested-nvgyX1/account/.cezar' -> '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-nested-nvgyX1/sandbox/state/server-instances'
- home write guard with HOME pinned to a sandbox > checks a nested protected path before creating even a sandbox lock for write: ENOENT: no such file or directory, symlink '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-nested-rXIZvO/account/.cezar' -> '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-nested-rXIZvO/sandbox/state/server-instances'
- home write guard with HOME pinned to a sandbox > allows unrelated sandbox writes when the protected home has a dangling ancestor: expected '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-…' to be '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-…' // Object.is equality
- home write guard with HOME pinned to a sandbox > allows a fresh sandbox beneath a symlinked temporary ancestor: expected '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-…' to be '/tmp/cez-vitest-tmp-w9SqtU/cez-guard-…' // Object.is equality

### `packages/cezar/src/home/deletion-recovery.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- keeps deletion enforcement for server-instances/named.install.lock without a loader-proven recovery base: Not a HomeStore file: /tmp/cez-vitest-tmp-TzTSLZ/cez-homestore-4R5tjp/config/server-instances/named.install.lock
- keeps deletion enforcement for server-instances/named.json without a loader-proven recovery base: Not a HomeStore file: /tmp/cez-vitest-tmp-TzTSLZ/cez-homestore-74kgON/config/server-instances/named.json
- keeps deletion enforcement for server.install.lock without a loader-proven recovery base: Not a HomeStore file: /tmp/cez-vitest-tmp-TzTSLZ/cez-homestore-fdBoEn/config/server.install.lock
- keeps deletion enforcement for server.json without a loader-proven recovery base: Not a HomeStore file: /tmp/cez-vitest-tmp-TzTSLZ/cez-homestore-2qCtpm/config/server.json
- keeps deletion enforcement for ui-state.json without a loader-proven recovery base: Not a HomeStore file: /tmp/cez-vitest-tmp-TzTSLZ/cez-homestore-j7LsEs/config/ui-state.json

### `packages/cezar/src/home/deprecation.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- keeps the disabled switch and absent legacy env silent: expected "vi.fn()" to not be called at all, but actually been called 1 times

### `packages/cezar/src/home/discovery-isolation.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- applies a same-id linked checkout from the injected Home: Not a HomeStore file: /tmp/cez-vitest-tmp-qgNUkh/cez-discovery-home-XZhgq5/selected/config/config.json
- discovers the injected Home registry, links and install ids, ignoring the ambient Home: Not a HomeStore file: /tmp/cez-vitest-tmp-qgNUkh/cez-discovery-home-qq3mMe/selected/config/config.json

### `packages/cezar/src/home/entry-points.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- restarts through the injected Home current entry after the ambient home changes: expected "vi.fn()" to be called with arguments: [ ObjectContaining{…} ]
- passes the resolved boot home to migrations: expected "vi.fn()" to be called with arguments: [ …(2) ]
- passes the boot Home to both updater services and keeps the legacy dry paths: expected "vi.fn()" to be called with arguments: [ ObjectContaining{…} ]

### `packages/cezar/src/home/exclusive-lock.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- recovers a crash after exclusive publication and before HEAD without an outside flag: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-ViN8gr/cez-homestore-J673LU/config/.versions/server.install.lock/HEAD'

### `packages/cezar/src/home/legacy-recovery.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- creates no legacy watcher with the shipped switch off: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true
- offers only Ignore when the retained base is primitive: expected [ { file: 'config.json', …(4) } ] to deeply equal []; diff (- Expected, + Received): - [] | + [ | + { | + "canImport": false, | + "canRestore": false, | + "detectedAt": "2026-11-10T15:53:57.311Z", | + "file": "config.json", | + "reason": "legacy-change",
- offers only Ignore when the retained base is array: expected [ { file: 'config.json', …(4) } ] to deeply equal []; diff (- Expected, + Received): - [] | + [ | + { | + "canImport": false, | + "canRestore": false, | + "detectedAt": "2026-11-10T15:53:57.069Z", | + "file": "config.json", | + "reason": "legacy-change",
- offers only Ignore when the retained base is null: expected [ { file: 'config.json', …(4) } ] to deeply equal []; diff (- Expected, + Received): - [] | + [ | + { | + "canImport": false, | + "canRestore": false, | + "detectedAt": "2026-11-10T15:53:56.823Z", | + "file": "config.json", | + "reason": "legacy-change",
- offers only Ignore when the retained base is invalid JSON: expected [ { file: 'config.json', …(4) } ] to deeply equal []; diff (- Expected, + Received): - [] | + [ | + { | + "canImport": false, | + "canRestore": false, | + "detectedAt": "2026-11-10T15:53:56.589Z", | + "file": "config.json", | + "reason": "legacy-change",
- offers only Ignore when the retained base is corrupt: expected [ { file: 'config.json', …(4) } ] to deeply equal []; diff (- Expected, + Received): - [] | + [ | + { | + "canImport": false, | + "canRestore": false, | + "detectedAt": "2026-11-10T15:53:56.367Z", | + "file": "config.json", | + "reason": "legacy-change",
- offers only Ignore when the retained base is unreadable: expected [ { file: 'config.json', …(4) } ] to deeply equal []; diff (- Expected, + Received): - [] | + [ | + { | + "canImport": false, | + "canRestore": false, | + "detectedAt": "2026-11-10T15:53:56.128Z", | + "file": "config.json", | + "reason": "legacy-change",
- detects legacy changes only for a committed migrated home and leaves the disabled path dark: expected [ { file: 'config.json', …(4) } ] to deeply equal []; diff (- Expected, + Received): - [] | + [ | + { | + "canImport": true, | + "canRestore": false, | + "detectedAt": "2026-11-10T15:53:54.915Z", | + "file": "config.json", | + "reason": "legacy-change",

### `packages/cezar/src/home/migrate.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- step 6: recopy removes managed files deleted by an older binary: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true
- step 6: recopies an older-binary write before commit, including new and deleted files: expected undefined to match object { hash: null, mtimeMs: null }; diff: - Expected: | + Received:
- steps 4–5: copies every file family and nested backups into the owning private root with HEAD: /tmp/cez-vitest-tmp-2J2V48/cez-homestore-XfZISp/new/state/ui-state.json: expected false to be true // Object.is equality; diff (- Expected, + Received): - true | + false

### `packages/cezar/src/home/migration-cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- keeps migration unregistered and the outside legacy bytes untouched with the shipped switch off: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true

### `packages/cezar/src/home/migration-guards.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- D6: a handled recheck failure is not a staged home; the next boot resumes the migration: expected [Function] to throw an error
- with the default switch off, boot leaves legacy unchanged, migrates nothing, and does not register migrate: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true

### `packages/cezar/src/home/migration-rollback-boot.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- direct server preparation refuses a rolled-back target before its consumers or lease can use it: expected [Function] to throw an error; diff: - Expected: | + Received:

### `packages/cezar/src/home/mobile-metadata.test.ts`

Checked-in switch artifact. See the switch PR list.

- mobile build metadata > keeps the checked-in Xcode configuration in sync with the release switch: expected '// Generated by packages/mobile/scrip…' to be '// Generated by packages/mobile/scrip…' // Object.is equality; diff (- Expected, + Received): - MOBILE_APP_ID = tools.hearsay.squawk.mobile | + MOBILE_APP_ID = tools.hearsay.cezarion.mobile | - MOBILE_TEST_ID_PREFIX = tools.hearsay.squawk |...

### `packages/cezar/src/home/read-process.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- does not spawn during peer-free reads on win32 after preparing its process identity: spawnSync powershell.exe ENOENT

### `packages/cezar/src/home/recovery-cache.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- detects corrupt pinned content when its metadata stays unchanged: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-35hyiZ/cez-homestore-jNuALb/config/.versions/ui-state.json/OUTSIDE'

### `packages/cezar/src/home/recovery-edge.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- publishes acceptance from another process when only its journal changes: Command failed: /home/agent/.nvm/versions/node/v24.22.1/bin/node --import tsx --input-type=module -e const { HomeStore } = await import(process.argv[1]); new HomeStore(process.argv[2]).acceptOutsideWrite(process.argv[3]); packages/cezar/src/home/store.ts /tmp/cez-vitest-tmp-BA7rKZ/cez-homestore-T...
- invalidates cached restore availability when pinned content becomes corrupt: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-BA7rKZ/cez-homestore-o0QI44/config/.versions/ui-state.json/OUTSIDE'
- invalidates cached restore availability when pinned content becomes missing: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-BA7rKZ/cez-homestore-HDdKcv/config/.versions/ui-state.json/OUTSIDE'

### `packages/cezar/src/home/recovery.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- blocks every write method for outside changes to server-instances/named.install.lock until restore or accept: Not a HomeStore file: /tmp/cez-vitest-tmp-OluK13/cez-homestore-cZn4uo/config/server-instances/named.install.lock
- blocks every write method for outside changes to server-instances/named.json until restore or accept: Not a HomeStore file: /tmp/cez-vitest-tmp-OluK13/cez-homestore-WI31MU/config/server-instances/named.json
- blocks every write method for outside changes to server.install.lock until restore or accept: Not a HomeStore file: /tmp/cez-vitest-tmp-OluK13/cez-homestore-wbcHos/config/server.install.lock
- blocks every write method for outside changes to server.json until restore or accept: Not a HomeStore file: /tmp/cez-vitest-tmp-OluK13/cez-homestore-GkW9SQ/config/server.json
- blocks every write method for outside changes to ui-state.json until restore or accept: Not a HomeStore file: /tmp/cez-vitest-tmp-OluK13/cez-homestore-kJ184Q/config/ui-state.json
- shows no recovery banner during an ordinary session: Not a HomeStore file: /tmp/cez-vitest-tmp-OluK13/cez-homestore-QDlgGP/config/ui-state.json

### `packages/cezar/src/home/resolve.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- legacy Home compatibility (release switch off) > finds the downloaded browser in the injected Home cache after the ambient user home changes: expected undefined to be '/home/operator/.cache/cez/chromium/ch…' // Object.is equality; diff: - Expected: | + Received:
- legacy Home compatibility (release switch off) > keeps env-object root semantics for CEZ_HOME=/srv/operator's home: expected '/ignored/config' to be '/srv/operator\'s home' // Object.is equality
- legacy Home compatibility (release switch off) > keeps env-object root semantics for CEZ_HOME=  : expected '/ignored/config' to be ' ' // Object.is equality
- legacy Home compatibility (release switch off) > keeps env-object root semantics for CEZ_HOME=relative/home: expected '/ignored/config' to be 'relative/home' // Object.is equality
- legacy Home compatibility (release switch off) > keeps env-object root semantics for CEZ_HOME=: expected '/ignored/config' to be '/home/operator/.cezar' // Object.is equality
- legacy Home compatibility (release switch off) > keeps env-object root semantics for CEZ_HOME=undefined: expected '/ignored/config' to be '/home/operator/.cezar' // Object.is equality
- legacy Home compatibility (release switch off) > reads only HOME_LOCATING_ENV from the supplied env object: Unexpected env read: XDG_CONFIG_HOME
- legacy Home compatibility (release switch off) > keeps both generated launchers byte for byte: 'override': expected '#!/bin/sh\n# hsq managed install — do…' to be '#!/bin/sh\n# cezar managed install — …' // Object.is equality; diff (- Expected, + Received): - # cezar managed install — do not edit; `cez install` regenerates this file. | + # hsq managed install — do not edit; `hsq install` regenerates t...
- legacy Home compatibility (release switch off) > keeps both generated launchers byte for byte: 'default': expected '#!/bin/sh\n# hsq managed install — do…' to be '#!/bin/sh\n# cezar managed install — …' // Object.is equality; diff (- Expected, + Received): - # cezar managed install — do not edit; `cez install` regenerates this file. | + # hsq managed install — do not edit; `hsq install` regenerates t...
- legacy Home compatibility (release switch off) > preserves every named path and public path helper: 'override': expected { root: '/srv/cockpit/config', …(21) } to deeply equal { root: '/srv/cockpit', …(21) }; diff (- Expected, + Received): - "agentAccounts": "/srv/cockpit/agent-accounts.json", | - "applicationUpdates": "/srv/cockpit/application-updates", | - "backups": "/srv/cockpit/backups", | - "bareSkil...
- legacy Home compatibility (release switch off) > preserves every named path and public path helper: 'default': expected { …(22) } to deeply equal { Object (root, workspaceConfig, ...) }; diff (- Expected, + Received): - "agentAccounts": "/home/operator/.cezar/agent-accounts.json", | - "applicationUpdates": "/home/operator/.cezar/application-updates", | - "backups": "/home/operator/.cezar/backups", | - "ba...
- legacy Home compatibility (release switch off) > keeps the release gate off: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true

### `packages/cezar/src/home/runtime-boundaries.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- passes the selected Home to lazy project contexts: Home.seed requires a test install marker
- passes the selected Home to branch-classification config loading: Home.seed requires a test install marker
- passes the selected Home to boot retention and background branch sweeping: Home.seed requires a test install marker

### `packages/cezar/src/home/runtime-calls.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- applies selected provider preferences to host discovery: Home.seed requires a test install marker
- chooses the selected machine runner for planner and namer: Home.seed requires a test install marker
- uses the selected config and account for task naming: Home.seed requires a test install marker
- uses the selected config and account for planner calls: Home.seed requires a test install marker

### `packages/cezar/src/home/runtime-cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- keeps init command generation inside the CLI home boundary: expected "log" to be called with arguments: [ Array(1) ]
- prints global CLI help without resolving a Home: Test timed out in 30000ms.

### `packages/cezar/src/home/runtime-launch.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- validates accepted worker step pins against the selected model policy: Home.seed requires a test install marker
- validates accepted worker run pins against the selected model policy: Home.seed requires a test install marker
- uses selected accounts when delegation selects a new account: Home.seed requires a test install marker
- uses selected model policy when accepting delegation execution settings: Home.seed requires a test install marker
- resolves the fresh step account from the run context Home: Home.seed requires a test install marker
- keeps launch config, fresh-step and Continue decisions on the selected Home: Home.seed requires a test install marker
- keeps accepted run pins on the selected model policy through RunManager: Home.seed requires a test install marker

### `packages/cezar/src/home/runtime-services.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- keeps HTTP config, accounts and UI writes in the server Home: Home.seed requires a test install marker
- checks the failing account from the observer Home: Home.seed requires a test install marker
- opens a fresh terminal CLI with the selected account: Home.seed requires a test install marker
- validates automation models with the selected default runner: Home.seed requires a test install marker
- describes agent webhooks from the selected registry at launch: Home.seed requires a test install marker
- delivers task webhooks from the selected registry: Home.seed requires a test install marker

### `packages/cezar/src/home/runtime-stores.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- keeps a missing selected store on defaults instead of consulting ambient state: Home.seed requires a test install marker
- binds server identity, registry and config writes to the selected Home: Home.seed requires a test install marker
- lists, registers and removes projects without changing the ambient registry: Home.seed requires a test install marker
- refreshes the semaphore from the selected Home: Home.seed requires a test install marker
- resolves task accounts and runtime auth verification in the selected Home: Home.seed requires a test install marker
- applies selected model policy at start and Continue gates: Home.seed requires a test install marker
- loads machine defaults and retention from the selected Home: Home.seed requires a test install marker

### `packages/cezar/src/home/sandbox.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- creates a test marker and contains all paths, including caches, in its directory: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-1UGuLG/cez-home-sandbox-7OsLRs/install.json'

### `packages/cezar/src/home/split-resolve.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- keeps sandbox filesystem paths native when process.platform is mocked: expected '/tmp/cez-vitest-tmp-MbGKP3/cez-native…' to be '/tmp/cez-vitest-tmp-MbGKP3/cez-native…' // Object.is equality

### `packages/cezar/src/home/write-isolation.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- reads and writes the update channel in the injected Home: Not a HomeStore file: /tmp/cez-vitest-tmp-cMuCWk/cez-home-writes-wYxukB/selected/config/config.json
- imports legacy accounts from the injected Home without writing to the ambient home: Not a HomeStore file: /tmp/cez-vitest-tmp-cMuCWk/cez-home-writes-sbw8Ns/selected/config/config.json
- keeps migration reads, imports, UI state and schemaVersion in the injected Home: Not a HomeStore file: /tmp/cez-vitest-tmp-cMuCWk/cez-home-writes-1oiF8f/selected/config/config.json
- restores agent-accounts.json only in the injected Home: Not a HomeStore file: /tmp/cez-vitest-tmp-cMuCWk/cez-home-writes-fGZBuS/selected/config/agent-accounts.json
- restores config.json only in the injected Home: Not a HomeStore file: /tmp/cez-vitest-tmp-cMuCWk/cez-home-writes-zzGUlY/selected/config/config.json

### `packages/cezar/src/paths.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- an EMPTY CEZ_HOME falls back to the default instead of a relative cwd path: expected false to be true // Object.is equality; diff (- Expected, + Received): - true | + false
- paths > a named instance lives under server-instances/, keyed by slug: expected '/tmp/cez-home-test/state/server-insta…' to be '/tmp/cez-home-test/server-instances' // Object.is equality
- paths > workspace paths honor the CEZ_HOME override: expected '/tmp/cez-home-test/config/config.json' to be '/tmp/cez-home-test/config.json' // Object.is equality
- paths > workspace config/ui-state live directly under the cezar home: expected '/tmp/cez-vitest-tmp-PXCVuk/cez-vitest…' to be '/tmp/cez-vitest-tmp-PXCVuk/cez-vitest…' // Object.is equality
- paths > the default instance keeps the legacy un-suffixed paths: expected '/tmp/cez-home-test/state/server.json' to be '/tmp/cez-home-test/server.json' // Object.is equality
- paths > honors the CEZ_HOME override: expected '/tmp/cez-home-test/config' to be '/tmp/cez-home-test' // Object.is equality
- paths > defaults the Home root to ~/.cezar: expected '/tmp/cez-vitest-tmp-PXCVuk/cez-vitest…' to be '/tmp/cez-vitest-tmp-PXCVuk/cez-vitest…' // Object.is equality

### `packages/cezar/src/preview/agent-cdp-chromium.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- the agent drives the real preview browser (hearsay-tools/cezarion#784) > navigates the page the pane streams, and cannot close the browser: expected [Function] to throw error matching /cezar refuses Browser\.close/ but got 'Browser.close: Squawk refuses Browser…'; diff: - Expected: | + Received:

### `packages/cezar/src/preview/cdp-proxy.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- AgentCdpLink (hearsay-tools/cezarion#784) > refuses Target.sendMessageToTarget, whose session and command sit in params where no guard reads them: expected { Object (id, error) } to deeply equal { Object (id, error) }; diff (- Expected, + Received): - "message": "cezar refuses Target.sendMessageToTarget: use flat sessions (attach with flatten: true).", | + "message": "Squawk refuses Target.sendMessageToTarget: use flat sessions (attach with...
- AgentCdpLink (hearsay-tools/cezarion#784) > refuses Browser.crashGpuProcess, which would end the browser the owner watches: expected [ { id: 5, error: { …(2) } } ] to deeply equal [ { id: 5, error: { …(2) } } ]; diff (- Expected, + Received): - "message": "cezar refuses Browser.crashGpuProcess: the owner's preview pane shares this browser.", | + "message": "Squawk refuses Browser.crashGpuProcess: the owner's preview p...
- AgentCdpLink (hearsay-tools/cezarion#784) > refuses Browser.crash, which would end the browser the owner watches: expected [ { id: 5, error: { …(2) } } ] to deeply equal [ { id: 5, error: { …(2) } } ]; diff (- Expected, + Received): - "message": "cezar refuses Browser.crash: the owner's preview pane shares this browser.", | + "message": "Squawk refuses Browser.crash: the owner's preview pane shares this brow...
- AgentCdpLink (hearsay-tools/cezarion#784) > refuses Browser.close, which would end the browser the owner watches: expected [ { id: 5, error: { …(2) } } ] to deeply equal [ { id: 5, error: { …(2) } } ]; diff (- Expected, + Received): - "message": "cezar refuses Browser.close: the owner's preview pane shares this browser.", | + "message": "Squawk refuses Browser.close: the owner's preview pane shares this brow...

### `packages/cezar/src/preview/host-browser-lifecycle.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- PreviewHost browser lifecycle > shutdown closes the pane with its public close reason: expected [ { code: 1001, …(1) } ] to deeply equal [ { code: 1001, …(1) } ]; diff (- Expected, + Received): - "reason": "cezar is shutting down", | + "reason": "Squawk is shutting down",

### `packages/cezar/src/preview/host.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- PreviewHost > agent CDP connections (hearsay-tools/cezarion#784) > protects the page the pane streams from the agent: expected [ { id: 1, error: { …(2) } } ] to deeply equal [ { id: 1, error: { …(2) } } ]; diff (- Expected, + Received): - "message": "cezar refuses Target.closeTarget on the page the owner's preview pane shows.", | + "message": "Squawk refuses Target.closeTarget on the page the owner's preview pan...

### `packages/cezar/src/project-migration/auto.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- the automatic project move > moves nothing with the release switch off, as shipped: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true
- the automatic project move > makes a request that comes while the project is being prepared wait for the move, never read first: expected [] to deeply equal [ true ]; diff (- Expected, + Received): - [ | - true, | - ] | + []
- the automatic project move > moves an idle legacy project at cockpit start, before the listener, and its task data stays readable: expected undefined to be '/tmp/cez-vitest-tmp-8Bmk8P/cez-projec…' // Object.is equality; diff: - Expected: | + Received:

### `packages/cezar/src/project-migration/engine.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- without a release > keeps the release switch off, starts a migration only behind the release switch, and refuses to run without the fence held by this process: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true
- a project migration (linked checkout: true) > repairs worktrees, rewrites receipts, checkpoints, rows, artifacts and handoffs, and leaves tracked files and other projects alone: expected undefined to be '/tmp/cez-vitest-tmp-toBNyY/cez-projec…' // Object.is equality; diff: - Expected: | + Received:
- a project migration (linked checkout: false) > repairs worktrees, rewrites receipts, checkpoints, rows, artifacts and handoffs, and leaves tracked files and other projects alone: expected undefined to be '/tmp/cez-vitest-tmp-toBNyY/cez-projec…' // Object.is equality; diff: - Expected: | + Received:

### `packages/cezar/src/project-migration/gate.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- migrate-project and the release switch > stays hidden and unusable with the switch off, as shipped, and loads no command module: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true

### `packages/cezar/src/project-migration/recovery.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- early recovery of an unfinished project migration > runs with the release switch off, as shipped: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true

### `packages/cezar/src/remote-settings-cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- cez remote-settings > enable --port grants that cockpit and prints the host-command warning: expected { ok: true, port: 4322, …(3) } to match object { ok: true, port: 4322, …(2) }; diff (- Expected, + Received): - "path": "/tmp/cez-vitest-tmp-XqlvMY/cez-remote-settings-cli-IeBUZj/remote-settings", | + "path": "/tmp/cez-vitest-tmp-XqlvMY/cez-remote-settings-cli-IeBUZj/config/remote-settin...

### `packages/cezar/src/remote-settings.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- remote settings grants > grant nothing when the host file does not exist: expected { grants: [], …(1) } to deeply equal { grants: [], …(1) }; diff (- Expected, + Received): - "path": "/tmp/cez-vitest-tmp-ufPJuQ/cez-remote-settings-5PnC6Q/remote-settings", | + "path": "/tmp/cez-vitest-tmp-ufPJuQ/cez-remote-settings-5PnC6Q/config/remote-settings",

### `packages/cezar/src/self-update/checkouts.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- linked checkouts > apply() builds an unbuilt worktree, then links, activates and restarts into it: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-N7aWZ6/cezar-home/config.json
- linked checkouts > gives two checkouts on the same branch distinct ids, and apply() runs the one picked: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-u03kgF/cezar-home/config.json
- linked checkouts > rebuilds a built checkout with deleted source changes before activating it: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-jixFWK/cezar-home/config.json
- linked checkouts > rebuilds a built checkout with untracked source changes before activating it: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-OK4F4P/cezar-home/config.json
- linked checkouts > rebuilds a built checkout with staged source changes before activating it: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-sL5GwF/cezar-home/config.json
- linked checkouts > rebuilds a built checkout with modified source changes before activating it: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-VWD5pw/cezar-home/config.json
- linked checkouts > labels a worktree by its branch when the run no longer holds a worktree path: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-5iM4AM/cezar-home/config.json
- linked checkouts > lists a repository reached only through a linked task checkout that the recovery moves: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-dM59kP/cezar-home/config.json
- linked checkouts > finishes an unfinished project migration, then lists the worktrees it moved: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-jTmfJI/cezar-home/config.json
- linked checkouts > lists a fenced project's checkouts without reading its run store: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-4FN7kf/cezar-home/config.json
- linked checkouts > labels worktrees with their task, last commit and build age, newest commit first: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-YGpd9q/cezar-home/config.json
- linked checkouts > discovers every worktree of a registered cezar repo, built or not: Not a HomeStore file: /tmp/cez-vitest-tmp-DVmGje/cez-link-BZieEz/cezar-home/config.json

### `packages/cezar/src/self-update/cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- managed version selection > lists managed versions and registry tags without a registry request: expected 'https://registry.npmjs.org/@hearsay-t…' to be 'https://registry.npmjs.org/@wjarka%2F…' // Object.is equality
- managed install instructions > prints the actual home and installed launcher (on PATH: false): expected '\n hsq install — managed layout unde…' to match /run(?:[: ]| \x60)+cezarion/; diff: - Expected: | + Received:
- managed install instructions > prints the actual home and installed launcher (on PATH: true): expected '\n hsq install — managed layout unde…' to match /run(?:[: ]| \x60)+cezarion/; diff: - Expected: | + Received:

### `packages/cezar/src/self-update/installer.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- installing into the managed layout > answers an already installed version without running npm: install finished but the entry file is missing
- installing into the managed layout > moves a finished install into place, writes its manifest and leaves no staging behind: install finished but the entry file is missing

### `packages/cezar/src/self-update/launcher.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- escapes percent paths in Windows named and fallback launchers: paired%PATH%: expected '@echo off\r\nrem # hsq managed instal…' to contain 'if exist "/tmp/cez-vitest-tmp-Slcvdx/…'; diff (- Expected, + Received): - if exist "/tmp/cez-vitest-tmp-Slcvdx/named-launcher-Arc8l3/config/paired%%PATH%%/data/versions/current/node_modules/@wjarka/cezarion/dist/cezarion.js" | + @echo ...
- escapes percent paths in Windows named and fallback launchers: single%: expected '@echo off\r\nrem # hsq managed instal…' to contain 'if exist "/tmp/cez-vitest-tmp-Slcvdx/…'; diff (- Expected, + Received): - if exist "/tmp/cez-vitest-tmp-Slcvdx/named-launcher-Q9dKeX/config/single%%/data/versions/current/node_modules/@wjarka/cezarion/dist/cezarion.js" | + @echo off | ...
- writes all binary launchers and generates Windows named-entry fallback: expected '@echo off\r\nrem # hsq managed instal…' to contain 'if exist "/tmp/cez-vitest-tmp-Slcvdx/…'; diff (- Expected, + Received): - if exist "/tmp/cez-vitest-tmp-Slcvdx/named-launcher-2lXOnJ/data/versions/current/node_modules/@wjarka/cezarion/dist/cezarion.js" | + @echo off | + rem # hsq mana...

### `packages/cezar/src/self-update/service-regressions.test.ts`

Approved product defect: hosted log redaction covers only config root; redact all selected roots.

- managed update review regressions > redacts hosted job logs and errors without changing local diagnostics (trimPaths=true): expected 'npm install --prefix /tmp/cez-vitest-…' not to contain '/tmp/cez-vitest-tmp-2YsVvD/cezar-upda…'; diff (- Expected, + Received): - /tmp/cez-vitest-tmp-2YsVvD/cezar-update-review-i7YXeR | + npm install --prefix /tmp/cez-vitest-tmp-2YsVvD/cezar-update-review-i7YXeR/versions/.staging-0.16.0...
- managed update review regressions > redacts hosted job logs and errors without changing local diagnostics (trimPaths=false): expected 'npm install --prefix /tmp/cez-vitest-…' not to contain '/tmp/cez-vitest-tmp-2YsVvD/cezar-upda…'; diff (- Expected, + Received): - /tmp/cez-vitest-tmp-2YsVvD/cezar-update-review-wmzNcy | + npm install --prefix /tmp/cez-vitest-tmp-2YsVvD/cezar-update-review-wmzNcy/versions/.staging-0.16.0...

### `packages/cezar/src/serve-boot.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- printServeBanner > prints environment details with repo {"branch":"main"}: expected [ …(7) ] to deeply equal [ Array(7) ]; diff (- Expected, + Received): - cezar v1.2.3 — /repo", | + Squawk v1.2.3 — /repo",
- printServeBanner > prints environment details with repo null: expected [ …(7) ] to deeply equal [ Array(7) ]; diff (- Expected, + Received): - cezar v1.2.3 — /repo", | + Squawk v1.2.3 — /repo",
- warnServeBind > prints the exact warning for a public bind: expected "log" to be called with arguments: [ Array(1) ]

### `packages/cezar/src/serve-command.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- serveCommand > leaves update discovery in the background and announces an available version: expected "vi.fn()" to be called with arguments: [ Array(1) ]

### `packages/cezar/src/server-command.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- serverCommand > runs the uninstall engine and reports completion: expected "log" to be called with arguments: [ Array(1) ]
- serverCommand > runs the deploy engine and reports completion: expected "log" to be called with arguments: [ Array(1) ]
- serverCommand > runs the install engine and reports completion: expected "log" to be called with arguments: [ Array(1) ]
- serverCommand > trims a new domain and chooses the next free instance port: expected "log" to be called with arguments: [ Array(1) ]

### `packages/cezar/src/server-install/cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- dry-run uninstalls and reverses the recorded state, leaving the record file: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-VhJXA5/cez-server-cli-home-8l0wY7/server.json'
- an explicit --port wins over the auto-picked loopback port: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-VhJXA5/cez-server-cli-home-DcuEso/server-instances/shop3-example-com.json'
- offers a second instance on an installed host and records it under its slug: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-VhJXA5/cez-server-cli-home-B3n47n/server-instances/shop2-example-com.json'
- dry-run deploys reading the platform from the record: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-VhJXA5/cez-server-cli-home-aRFd4r/server.json'
- dry-run installs ubuntu-vps and records the state: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-VhJXA5/cez-server-cli-home-FreuYt/server.json'

### `packages/cezar/src/server-install/platforms/macosx-migration.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- macOS launchd migration > restores the old job and active plist when the new bootstrap fails: expected 'Unexpected launchd label (expected ai…' to contain 'Could not load'
- macOS launchd migration > rolls back a successful migration and a second rollback does nothing: Cannot read properties of undefined (reading 'to')
- macOS launchd migration > refuses rollback over a changed destination plist without touching its job: Cannot read properties of undefined (reading 'to')
- macOS launchd migration > finishes backup cleanup after rollback already restored the old file and removed the new one: Cannot read properties of undefined (reading 'backup')
- macOS launchd migration > cleans an internally rolled-back migration backup so later credentials can migrate: expected [ { artifact: { …(4) }, …(1) } ] to deeply equal []; diff (- Expected, + Received): - [] | + [ | + { | + "artifact": { | + "kind": "owned", | + "name": "ai.cezar.ngrok", | + "path": "/tmp/cez-vitest-tmp-VXY89I/launchd-migration-wfjV0s/data/LaunchAgents/ai.cezar.ngrok.plist", | + "type": ...
- macOS launchd migration > checks, deploys and uninstalls legacy agents when pre-switch check() recorded created:null: expected false to be true // Object.is equality; diff (- Expected, + Received): - true | + false
- macOS launchd migration > migrates again after rollback and a credential rotation, without a stale backup: Cannot read properties of undefined (reading 'backup')
- macOS launchd migration > makes the switch-off migration a no-op and the dry-run report a preview: expected { moved: [], …(2) } to deeply equal { moved: [], …(2) }; diff (- Expected, + Received): - "errors": [], | + "errors": [ | + { | + "artifact": { | + "kind": "owned", | + "name": "ai.cezar.ngrok", | + "path": "/tmp/cez-vitest-tmp-VXY89I/launchd-migration-MGjf9q/data/LaunchAgents/ai.cezar.n...
- macOS launchd migration > refuses an occupied old rollback path whose bytes differ from the backup: Cannot read properties of undefined (reading 'message')
- macOS launchd migration > proves launcher ownership for [ '/usr/bin/node', …(1) ]: true (line 137): expected [] to have a length of 1 but got +0; diff (- Expected, + Received): - 1 | + 0
- macOS launchd migration > migration refuses an existing foreign ngrok destination: expected 'Unexpected launchd label (expected ai…' to contain 'Destination already exists'
- macOS launchd migration > resumes interrupted rollback with both exact plists present (old loaded: true): Cannot read properties of undefined (reading 'backup')
- macOS launchd migration > proves launcher ownership for [ '/usr/bin/node', …(1) ]: true: expected [] to have a length of 1 but got +0; diff (- Expected, + Received): - 1 | + 0
- macOS launchd migration > migration refuses an existing foreign cockpit destination: expected 'Unexpected launchd label (expected ai…' to contain 'Destination already exists'
- macOS launchd migration > resumes interrupted rollback with both exact plists present (old loaded: false): Cannot read properties of undefined (reading 'backup')
- macOS launchd migration > recognizes our npx launcher when check() left created:null: expected [] to have a length of 1 but got +0; diff (- Expected, + Received): - 1 | + 0
- macOS launchd migration > moves owned old agents, keeps exact private backups and returns ledger rewrites without saving: expected [ { artifact: { …(4) }, …(1) }, …(1) ] to deeply equal []; diff (- Expected, + Received): - [] | + [ | + { | + "artifact": { | + "kind": "owned", | + "name": "ai.cezar.cockpit", | + "path": "/tmp/cez-vitest-tmp-VXY89I/launchd-migration-XBkpsf/data/LaunchAgents/ai.cezar.cockpit.plist", | ...

### `packages/cezar/src/server-install/platforms/macosx-ngrok.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- macosx-ngrok redeploy npx-cache refresh (legacy issue 32) > aborts before kickstart when the npx cache cannot be read: promise resolved "undefined" instead of rejecting; diff: - Expected: | + Received:
- macosx-ngrok redeploy npx-cache refresh (legacy issue 32) > clears the cached cezarion build before kickstart when the agent is an npx launch: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true
- macosx-ngrok redeploy npx-cache refresh (legacy issue 32) > loads the repaired plist on retry after bootstrap failed: promise resolved "undefined" instead of rejecting; diff: - Expected: | + Received:
- macosx-ngrok redeploy npx-cache refresh (legacy issue 32) > repairs an old plist once and recognizes it on the next install check: ENOENT: no such file or directory, lstat '/tmp/cez-vitest-tmp-aadjdS/cez-mac-npx-home-Ld8gPQ/Library/LaunchAgents/tools.hearsay.squawk.cockpit.plist'
- macosx-ngrok review fixes (PR legacy issue 423) > undo removes the agent from static label/path even with created:null: expected false to be true // Object.is equality; diff (- Expected, + Received): - true | + false
- macosx-ngrok review fixes (PR legacy issue 423) > writes the credential-bearing plist 0600: ENOENT: no such file or directory, stat '/tmp/cez-vitest-tmp-aadjdS/cez-mac-fix-i8afzu/Library/LaunchAgents/ai.cezar.ngrok.plist'
- macosx-ngrok > cezarLaunchdPlist embeds the argv, port, workdir and env: expected '<?xml version="1.0" encoding="UTF-8"?…' to contain '<string>ai.cezar.cockpit</string>'; diff (- Expected, + Received): - <string>ai.cezar.cockpit</string> | + <?xml version="1.0" encoding="UTF-8"?> | + <!-- Managed by cezar server-install — do not edit by hand. --> | + <!DOCTYPE plist P...

### `packages/cezar/src/server-install/platforms/ubuntu-vps.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- ubuntu-vps autostart step (dry-run) > records a user-scoped service artifact and writes nothing to disk: expected 'hearsay-squawk.service' to be 'cezar.service' // Object.is equality
- ubuntu-vps redeploy restart verification (legacy issue 430) > uses the named system unit and fails an unchanged timestamp: expected [Function] to throw error matching /cezar-shop\.service.*start timestamp.…/ but got 'cezar.service: start timestamp unchan…'; diff: - Expected: | + Received:
- ubuntu-vps redeploy npx-cache refresh (legacy issue 696) > warns instead of silently skipping an upstream `npx cezar-cli` unit (legacy issue 23): expected 'This service is launched by npx from …' to match /other than cezarion/; diff: - Expected: | + Received:
- serviceExecStart > uses the official npx alias when launched from the ephemeral _npx cache: expected '/n/npx --yes hsq' to be '/n/npx --yes cezarion' // Object.is equality
- serviceExecStart > runs the built entry for a stable checkout/global install: expected '/n/node /pkg/dist/hsq.js' to be '/n/node /pkg/dist/index.js' // Object.is equality
- ubuntu-vps multi-instance artifact paths > a named instance's systemd unit is cezar-<slug>.service: expected 'hearsay-squawk-shop-example-com.servi…' to be 'cezar-shop-example-com.service' // Object.is equality
- ubuntu-vps multi-instance artifact paths > a named instance suffixes the nginx site + htpasswd with its slug: expected [ …(3) ] to include '/etc/nginx/sites-available/cezar-shop…'
- ubuntu-vps multi-instance artifact paths > the default instance records the legacy un-suffixed nginx/htpasswd paths: expected [ …(3) ] to include '/etc/nginx/sites-available/cezar'
- ubuntu-vps HTTP/2 install wiring > SSL uses the named instance site for the TLS listener edit: expected 'cp -p \'/etc/nginx/sites-available/he…' to contain '\'/etc/nginx/sites-available/cezar-sh…'; diff (- Expected, + Received): - '/etc/nginx/sites-available/cezar-shop-example-com' | + cp -p '/etc/nginx/sites-available/hearsay-squawk-shop-example-com' '/etc/nginx/sites-available/hearsay-sq...
- ubuntu-vps HTTP/2 install wiring > SSL step adds HTTP/2 after certbot on older or unknown nginx: vhost was not written
- ubuntu-vps HTTP/2 install wiring > failed or unreadable version probe keeps the proxy vhost parseable: vhost was not written
- ubuntu-vps HTTP/2 install wiring > proxy step uses the nginx -v stderr banner after installing nginx: vhost was not written

### `packages/cezar/src/server-install/server-migrate-switch.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- with the switch off > does not register server-migrate and the platform moves nothing: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true

### `packages/cezar/src/server-install/state.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- server state > the install lock is per-instance — one instance never blocks another: Not a HomeStore file: /tmp/cez-vitest-tmp-d60FV2/cez-state-F9Hh7Y/server-instances/shop-example-com.install.lock
- server state > lock acquisition is atomic (wx) — a pre-existing live lock file always wins: Not a HomeStore file: /tmp/cez-vitest-tmp-d60FV2/cez-state-hvg1FS/server.install.lock
- server state > lock is exclusive against a live foreign pid and reclaims stale: Not a HomeStore file: /tmp/cez-vitest-tmp-d60FV2/cez-state-G86mP7/server.install.lock

### `packages/cezar/src/server/agent-config-api.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- the agent-config API > remote settings administration > disabled again: the next request is refused without a restart: expected 'editing agent config is disabled on t…' to contain 'cez remote-settings enable'

### `packages/cezar/src/server/archive-on-merge-boot.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- uses the verified gh default repository without recovery: {"single":false,"repository":"upstream"}: Cannot read properties of undefined (reading 'archived')
- uses the verified gh default repository without recovery: {"single":false,"repository":"r"}: Cannot read properties of undefined (reading 'archived')

### `packages/cezar/src/server/capabilities.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- resolveCapabilities — settings administration (hearsay-tools/cezarion#2428) > a malformed host file grants nothing: Not a HomeStore file: /tmp/cez-vitest-tmp-fnsThr/cez-caps-home-F1CEWL/remote-settings/4321.json

### `packages/cezar/src/server/config-api.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- the config API > a hosted cockpit cannot write worktreeSetup: expected { Object (error) } to deeply equal { Object (error) }; diff (- Expected, + Received): - "error": "Worktree setup commands are read-only on this remote cockpit. To allow remote edits, run `cez remote-settings enable` on the machine running cezar.", | + "error": "Worktree setup commands ar...

### `packages/cezar/src/server/create-project-api.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- new-project routes > a registration failure after a GitHub warning keeps the warning in the error: expected 200 to be 500 // Object.is equality; diff (- Expected, + Received): - 500 | + 200

### `packages/cezar/src/server/home-recovery-routes.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- reads the cached metadata and sends restore and accept through the shared recovery service: expected "vi.fn()" to be called with arguments: [ { …(23) }, 'config.json', …(2) ]

### `packages/cezar/src/server/project-context-warm.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- ProjectContexts.warmAll > logs a failed build once, keeps going, and caches nothing so the next click retries: expected "warn" to be called 1 times, but got 2 times

### `packages/cezar/src/server/project-migration-fence.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- with the release switch off > offers no migration command and a normal project build writes no fence or journal: expected true to be false // Object.is equality; diff (- Expected, + Received): - false | + true

### `packages/cezar/src/server/providers-api.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- workspace provider API > POST returns 409 plus command when localHandoff is false: expected { …(2) } to deeply equal { …(2) }; diff (- Expected, + Received): - "error": "Run this command on the machine hosting cezar.", | + "error": "Run this command on the machine hosting Squawk.",

### `packages/cezar/src/server/repo-branch-lifecycle.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- branch lifecycle classification (hearsay-tools/cezarion#2268) > a run's PR branch outside cez/* > stays the user's branch unless every part of the evidence holds: expected [ { name: 'fix/y', …(1) } ] to deeply equal [ { name: 'fix/y', …(1) } ]; diff (- Expected, + Received): - "reason": "not a cezar task branch", | + "reason": "not a Squawk task branch",

### `packages/cezar/src/server/run-store-unavailable.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- a project whose run store cannot be opened > another project: 409 with the reason, nothing cached, and the next request after the fix opens it: expected '/tmp/cez-vitest-tmp-wpSalG/cez-unavai…' to match /runs\.db is damaged \(.*\)\. cezar le…/; diff: - Expected: | + Received:

### `packages/cezar/src/server/runs-index-api.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- workspace runs index API > agrees with a cold read on a run this cezar cannot read, and opening it says why (legacy issue 779): expected { Object (error) } to deeply equal { error: StringMatching{…} }; diff (- Expected, + Received): - "error": StringMatching /could not be read by this cezar/, | + "error": "this run could not be read by this Squawk: its record in runs.db does not fit this version (a newer Squawk may have w...

### `packages/cezar/src/server/self-update-api.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- the self-update API > refuses installed link targets and hides them in hosted status: expected false to be true // Object.is equality; diff (- Expected, + Received): - true | + false
- the self-update API > refuses installed local targets and hides them in hosted status: expected false to be true // Object.is equality; diff (- Expected, + Received): - true | + false

### `packages/cezar/src/skills-remote.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- materializeSkillToCache — the per-commit copy for runs without a task worktree (legacy issue 1024) > degrades to null, never a throw, when the cache cannot be written: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-WBHQMt/cez-team-home-AU8yJY/.cache/cez/skill-files'
- materializeSkillToCache — the per-commit copy for runs without a task worktree (legacy issue 1024) > touches a reused commit dir so pruning measures last use, not creation: expected '/tmp/cez-vitest-tmp-WBHQMt/cez-team-h…' to be '/tmp/cez-vitest-tmp-WBHQMt/cez-team-h…' // Object.is equality
- materializeSkillToCache — the per-commit copy for runs without a task worktree (legacy issue 1024) > prunes commit dirs untouched for a week: expected '/tmp/cez-vitest-tmp-WBHQMt/cez-team-h…' to be '/tmp/cez-vitest-tmp-WBHQMt/cez-team-h…' // Object.is equality
- materializeSkillToCache — the per-commit copy for runs without a task worktree (legacy issue 1024) > falls back to the ref when the listed commit is absent or not in the clone: undefined: expected '/tmp/cez-vitest-tmp-WBHQMt/cez-team-h…' to be '/tmp/cez-vitest-tmp-WBHQMt/cez-team-h…' // Object.is equality
- materializeSkillToCache — the per-commit copy for runs without a task worktree (legacy issue 1024) > copies the commit the skill was listed at, not where the ref moved since: expected '/tmp/cez-vitest-tmp-WBHQMt/cez-team-h…' to be '/tmp/cez-vitest-tmp-WBHQMt/cez-team-h…' // Object.is equality
- materializeSkillToCache — the per-commit copy for runs without a task worktree (legacy issue 1024) > copies the whole directory into <cache>/<commit>/<name> and reuses it for the same commit: expected '/tmp/cez-vitest-tmp-WBHQMt/cez-team-h…' to be '/tmp/cez-vitest-tmp-WBHQMt/cez-team-h…' // Object.is equality

### `packages/cezar/src/task-cli/hint.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- startCockpitHint > returns at once and prints whenever a slow discovery answers: expected [ Array(1) ] to deeply equal [ Array(1) ]; diff (- Expected, + Received): - "a cockpit is running at http://127.0.0.1:4350; use \"cez task start\" to run this task there instead", | + "a cockpit is running at http://127.0.0.1:4350; use \"hsq task start\" to run this task there instead",

### `packages/cezar/src/webhooks/cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- cez webhook > prints usage for --help: expected 'hsq webhook — send reports to the pro…' to contain 'cez webhook'; diff (- Expected, + Received): - cez webhook | + hsq webhook — send reports to the project webhooks the owner exposed to agents. | + One JSON object per invocation; exit 0 ok, 1 not delivered, 2 refused or no cockpit, 64 ...
- cez webhook > is dispatched by the CLI entry before the cockpit flags are parsed: expected 'hsq webhook — send reports to the pro…' to contain 'cez webhook'; diff (- Expected, + Received): - cez webhook | + hsq webhook — send reports to the project webhooks the owner exposed to agents. | + One JSON object per invocation; exit 0 ok, 1 not delivered, 2 refused or no cockpit, 64 ...

### `packages/cezar/src/workflows/delegation-integration-spawn-idempotency.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- public delegation completion integration > dedupes a --runner retry of a --backend spawn under the same request id: expected '[hsq] Legacy environment names are se…' to be '' // Object.is equality; diff (- Expected, + Received): + [hsq] Legacy environment names are set: CEZ_AUTONAME, CEZ_CLAUDE_BIN, CEZ_CODEX_BIN, CEZ_DELEGATION_TOKEN, CEZ_DELEGATION_URL, CEZ_DRY_RUN, CEZ_HOME, CEZ_REVIEW_GATE. Use the matchin...

### `packages/cezar/src/workflows/run/check-step-home.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- check steps remove only cockpit home locators with full-env=1: expected '/live/home/config' to be '/live/home' // Object.is equality
- check steps remove only cockpit home locators with full-env=0: expected '/live/home/config' to be '/live/home' // Object.is equality

### `packages/cezar/src/workspace/backup-legacy.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- shows legacy command usage only when the canary is enabled: expected last "log" call to have been called with [ StringNotContaining "backup import" ]; diff (- Expected, + Received): - StringNotContaining "backup import", | + "usage: | + hsq backup list [<file>] | + hsq backup restore <file> [--at <time>] | +  | + Restore the newest backup, or the newest a...
- refuses host CLI ignore by default while the switch is off: expected +0 to be 1 // Object.is equality; diff (- Expected, + Received): - 1 | + 0
- refuses host CLI import by default while the switch is off: expected +0 to be 1 // Object.is equality; diff (- Expected, + Received): - 1 | + 0

### `packages/cezar/src/workspace/backups-home-files.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- keeps backup failures auxiliary for nested file writes: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-bzotPX/cez-homestore-sfhvH2/state/backups'
- restores server.install.lock byte for byte through the CLI helper: Not a HomeStore file: /tmp/cez-vitest-tmp-bzotPX/cez-homestore-IIQ9IA/config/server.install.lock
- restores server-instances/other.json byte for byte through the CLI helper: Not a HomeStore file: /tmp/cez-vitest-tmp-bzotPX/cez-homestore-Lzkbqa/config/server-instances/other.json
- uses the Home backup root for nested files and reads the old named-instance location: Not a HomeStore file: /tmp/cez-vitest-tmp-bzotPX/cez-homestore-Q1jLfk/config/server-instances/config.json
- discovers nested backups after the live files and their directories are removed: Not a HomeStore file: /tmp/cez-vitest-tmp-bzotPX/cez-homestore-ZnqBx1/config/server-instances/other.json
- backs up changed and removed server-instances/other.install.lock under its home-relative key: Not a HomeStore file: /tmp/cez-vitest-tmp-bzotPX/cez-homestore-zbyYsz/config/server-instances/other.install.lock
- backs up changed and removed server-instances/other.json under its home-relative key: Not a HomeStore file: /tmp/cez-vitest-tmp-bzotPX/cez-homestore-VUd9V6/config/server-instances/other.json
- backs up changed and removed server.install.lock under its home-relative key: Not a HomeStore file: /tmp/cez-vitest-tmp-bzotPX/cez-homestore-98gRYU/config/server.install.lock
- backs up changed and removed server.json under its home-relative key: Not a HomeStore file: /tmp/cez-vitest-tmp-bzotPX/cez-homestore-MCpHcR/config/server.json
- backs up changed and removed ui-state.json under its home-relative key: Not a HomeStore file: /tmp/cez-vitest-tmp-bzotPX/cez-homestore-fgBwvX/config/ui-state.json

### `packages/cezar/src/workspace/home-safety.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- cezar home write safety > leaves an existing real-home registry byte-for-byte intact when a leaked write is refused: ENOENT: no such file or directory, open '/tmp/cez-vitest-tmp-oxuYFa/cez-vitest-user-home-lUGNtw/.config/hearsay-squawk/config.json'
- cezar home write safety > refuses a write into the real cezar home while running under vitest: expected '/tmp/cez-vitest-tmp-oxuYFa/cez-vitest…' to be '/tmp/cez-vitest-tmp-oxuYFa/cez-home-s…' // Object.is equality
- cezar home write safety > reads back what the mid-flight write stored, from the same file: [cez] refusing to write home /tmp/cez-vitest-tmp-oxuYFa/cez-home-safety-pinned-UkKcFh/config/config without an install marker; start it through a CLI entry point
- cezar home write safety > keeps a merge-write inside one file when CEZ_HOME moves mid-flight: [cez] refusing to write home /tmp/cez-vitest-tmp-oxuYFa/cez-home-safety-pinned-zpHHjM/config/config without an install marker; start it through a CLI entry point

### `packages/cezar/src/workspace/migrations.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- workspace migrations > an unwritable home degrades with ONE warning and never throws: expected "warn" to be called 1 times, but got 0 times

### `packages/cezar/src/workspace/projects-cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- cezar projects CLI > tag > needs an id: expected 'usage:\n hsq projects [list] …' to contain 'cez projects [list]'; diff (- Expected, + Received): - cez projects [list] | + usage: | + hsq projects [list] list the registered projects | + hsq projects add [<dir>] register a folder (default: --repo, else cwd) | + hsq projects remove|rm <i...
- cezar projects CLI > exits 1 with the usage block on an unknown subcommand: expected 'unknown projects subcommand: frobnica…' to contain 'cez projects [list]'; diff (- Expected, + Received): - cez projects [list] | + unknown projects subcommand: frobnicate | +  | + usage: | + hsq projects [list] list the registered projects | + hsq projects add [<dir>] register a folder ...
- cezar projects CLI > remove > exits 1 for an unknown id and for a missing id argument: expected 'unknown project: nope\nusage:\n hsq …' to contain 'cez projects remove|rm <id>'; diff (- Expected, + Received): - cez projects remove|rm <id> | + unknown project: nope | + usage: | + hsq projects [list] list the registered projects | + hsq projects add [<dir>] register a folder (default...
- cezar projects CLI > list > is the default subcommand and prints id, status and root per project: expected '\n ✓ shop main /tmp/cez-vitest-tmp…' to contain '/tmp/cez-vitest-tmp-HOp8dI/cez-projec…'; diff (- Expected, + Received): - /tmp/cez-vitest-tmp-HOp8dI/cez-projects-cli-crY9sM/config.json | +  | + ✓ shop main /tmp/cez-vitest-tmp-HOp8dI/cez-projects-cli-repos-kwOJGs/shop | +  | + 1 project...

### `packages/cezar/test/e2e/backup-cli.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- backup list and restore work without a cockpit: Not a HomeStore file: /tmp/squeal-1001/tmp/5cf3c7a88d685a8a/cez-backup-cli-EF3adh/agent-accounts.json

### `packages/cezar/test/unit/skills-remote.test.ts`

Fixture assumes legacy layout or shipped output; inspect and repair the fixture or expected text.

- a new process with a stale stamp fetches once and rewrites the stamp (legacy issue 367): stale-stamp fetch must rewrite the stamp
- a new process with a fresh stamp does not git-fetch on first catalog read (legacy issue 367): fresh stamp must suppress fetch in a brand-new process


## Fixed by F5

The coordinator assigned this product defect to F5 after hearsay-tools/cezarion#3177 merges. Keep the assertion enabled.

- `packages/cezar/test/e2e/home-store-cli.test.ts`: `read-only and invalid conditional commands leave a fresh home untouched`, assertion on `projects list`. Reproduce with the constant true, a scratch home that does not exist, and both ambient environment prefixes cleared. The built CLI creates `.locks`, `MOVED.json`, `config`, and `state`; expected no files. `home/entry.ts` prepares migration before write authorization; `home/migration-boot.ts` migrates even with no legacy source. Writer entries may create the new live home; a read-only or invalid command must write nothing.

## Browser, switch on: F6

The coordinator limited F2 browser work to the shared-registry repair and focused smoke. Do not treat these results as full browser validation.

- Initial global setup rejected `.ai/qa/cez-home/config.json` as a HomeStore path. `workspace-registry.ts` now derives the selected file path with `homeFileLocation`.
- Focused smoke later reached `test-env-up.sh` exit 1. `squeal why packages/web/e2e/environment.ts --include-logs` reported no stored result and no run log. The scratch app log showed a listening cockpit; the bootstrap cause could not be read from Squeal.
- Further browser fixtures still seed the legacy config path directly: `worker-relationships.e2e.ts`, `reports.e2e.ts`, `html-report-reader.e2e.ts`, and `html-report-cards.e2e.ts`. These belong to the separate browser slice.
- Requested focused specs: `smoke.e2e.ts`, `project-sidebar.e2e.ts`, `project-order.e2e.ts`; blocked by the shared global setup exit above.

## Validation checkpoint (switch on, revision 44)

The 17 package files have current results. The only failing package assertion is the F5 defect above. The tarball CLI smoke, fake-name release tests, and dual-state release identity tests pass. Four sandbox-repair test files pass. Root lint and typecheck pass. The full Vitest and node:test checkpoint remains in progress; no full-suite pass is claimed.

## Later failures: live marker benchmark guard

- `home/store.test.ts`, `refuses every registry file with a live marker under the actual test process, even with another env`: the Home.seed refusal probe built a split sandbox for explicit legacy paths. Preserve the fixture Home layout in Home.sandbox.
- `home/store.test.ts`, `refuses the project-probe fixture command before it can modify an inherited live home`: expected exit 1, got 0. The benchmark resolved a split home but checked only its config marker. An unmigrated live legacy marker remained at the base. Coordinator approved checking both config and base before any write (request `5862f613-e9df-41a5-b889-41b64de82f1b`). The existing refusal assertion stays enabled. The refusal regression passes with the constant true at Squeal revision 47. The child fixture also sets both home aliases to avoid inheriting another preferred home.

## Later failures: boundary fixtures

`home/boundary.test.ts` had six switch-on failures. The server-instances symlink used the config root, backup symlinks used the legacy backup base, the backup assertion used a config-relative key for state files, and the dangling-backup fixture omitted its split state parent. Use Home kind roots, Home.backups and homePathLocation for these fixtures. Assertions remain enabled. All six checks recovered at Squeal revision 49.

## Later failures: offline project migration reader

Four `project-migration/migrate-project.test.ts` checks expected the moved task but read an empty legacy store after the switch. The migratedTask helper now follows projectPaths(project.root).write. The full switch-on run confirms the selected path.

## Quality measurement limits

The coordinator approved measurement through squeal hold. The third collector run measured 202 of 219 functions, with no exceeded limit (maximum measured complexity 17, CRAP 12). Seventeen functions lacked coverage, including two non-test functions: benchmark-run-store.runChild and browser workspace-registry.sharedFile. A fourth run after adding a real run-store child smoke ended incomplete with `Unexpected end of JSON input` before it emitted measurements. No full quality pass is claimed. The coordinator then stopped further quality runs to prioritize full tests. Vitest test callback coverage may come from CI; unmeasured node:test callback files will be listed in READY.

## Complete switch-on Vitest checkpoint

Full `squeal hold -- npm test -- --maxWorkers=8`: 40 failed, 1582 passed, 2 skipped test files; 255 failed, 26446 passed, 1 expected failure, 14 skipped tests. Duration 921.37 seconds. This records all failures from that run, including fixtures corrected while it ran.

### `packages/cezar/src/delegation/cli.test.ts`

- bundled worker CLI > lists owned workers through the private transport and rejects extra arguments
- bundled worker CLI > prints human family help for -h without a delegation session
- bundled worker CLI > prints human family help for --help without a delegation session
- bundled worker CLI > prints human spawn help before validating required arguments or accessing transport
- bundled worker CLI > prints human inspect help before validating required arguments or accessing transport
- bundled worker CLI > prints human steer help before validating required arguments or accessing transport
- bundled worker CLI > prints human stop help before validating required arguments or accessing transport
- bundled worker CLI > prints human destroy help before validating required arguments or accessing transport
- bundled worker CLI > prints human diff help before validating required arguments or accessing transport
- bundled worker CLI > prints human collect help before validating required arguments or accessing transport
- bundled worker CLI > prints human wait help before validating required arguments or accessing transport
- bundled worker CLI > prints human cancel-wait help before validating required arguments or accessing transport
- bundled worker CLI > prints human resume help before validating required arguments or accessing transport

### `packages/cezar/src/delegation/peer-conversations.test.ts`

- peer conversations > R8 a recipient another cezar process controls is refused with a clear reason, and nothing is written

### `packages/cezar/src/project-migration/migrate-project.test.ts`

- the offline migrate-project > locks an ownerless project for the whole migration, keeps competitors out, and leaves readable migrated tasks
- the offline migrate-project > keeps an interrupted migration blocked, and a retry finishes it
- the offline migrate-project > reports what a dry run completed first when it met an interrupted migration
- the offline migrate-project > refuses while a task is live, lists it with the next step, and migrates once the task ends

### `packages/cezar/src/runs/store-import.test.ts`

- an import that does not complete > is imported again by the next open after a failure inside its transaction
- an older cezar still writing runs.json > holding cockpit.lock: nothing is imported, the user is told to stop it, and the next open imports
- an older cezar still writing runs.json > saving runs.json during the import: nothing is imported, and the next open imports what it saved
- a store that cannot be opened is never an empty one > a database that is not a database: every file stays byte-identical and nothing is created
- a store that cannot be opened is never an empty one > a busy database fails within about one busy timeout, imports nothing, and the next open imports
- a store that cannot be opened is never an empty one > a directory this user cannot write: a permission error naming it
- a store that cannot be opened is never an empty one > a database written by a newer cezar: refused, left as it is

### `packages/cezar/src/server/automations-api.test.ts`

- GitHub automation API > boot re-baselines an idle enabled poll and launches nothing
- GitHub automation API > boot fires a past-due schedule on a project without a remote, once across two boots

### `packages/cezar/src/server/repo-branches-witness.test.ts`

- branch deletion with a controlled mutation lock > branch deletion guard regressions (hearsay-tools/cezarion#2291) > refuses a symbolic alias substituted at the mutation lock

### `packages/cezar/src/server/repo-branches.test.ts`

- the branch classifier (issue 08 §A) > deleteBranches > branch deletion guard regressions (hearsay-tools/cezarion#2291) > returns the exact refusal for each protected or missing branch
- the branch classifier (issue 08 §A) > deleteBranches > branch deletion guard regressions (hearsay-tools/cezarion#2291) > does not mistake a porcelain worktree path for a checked-out branch

### `packages/cezar/src/session-signal-cli.test.ts`

- cezar forwards SIGINT and SIGTERM to agent sessions (hearsay-tools/cezarion#890) > SIGTERM to cez serve alone stops the agent
- cezar forwards SIGINT and SIGTERM to agent sessions (hearsay-tools/cezarion#890) > Ctrl-C on cez run stops the agent and still ends cez by SIGINT
- cezar forwards SIGINT and SIGTERM to agent sessions (hearsay-tools/cezarion#890) > SIGHUP when the terminal closes (hearsay-tools/cezarion#915) > closing the terminal of cez serve stops the agent and leaves the run for recovery
- cezar forwards SIGINT and SIGTERM to agent sessions (hearsay-tools/cezarion#890) > SIGHUP when the terminal closes (hearsay-tools/cezarion#915) > closing the terminal of cez run stops the agent and ends cez by SIGHUP
- cezar forwards SIGINT and SIGTERM to agent sessions (hearsay-tools/cezarion#890) > SIGHUP when the terminal closes (hearsay-tools/cezarion#915) > nohup cez serve survives a hangup and its agent keeps running

### `packages/cezar/src/task-cli/cli.test.ts`

- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects --x before the operation without discovery
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects --wait before the operation without discovery
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects --full before the operation without discovery
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects --timeout-seconds=1 before the operation without discovery
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects duplicate shared flags in [ '--url', 'http://127.0.0.1:1', …(2) ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects duplicate shared flags in [ '--url=one', '--url', 'two', 'list' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects duplicate shared flags in [ Array(4) ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects duplicate shared flags in [ '--repo', 'one', '--repo=two', …(1) ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects duplicate shared flags in [ '--help', 'list', '--help' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects duplicate shared flags in [ '-h', 'list', '--help' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects duplicate shared flags in [ '--help', '-h', 'list' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects missing or option-shaped leading values in [ '--url' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects missing or option-shaped leading values in [ '--url', '--help', 'list' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects missing or option-shaped leading values in [ '--url=--help', 'list' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects missing or option-shaped leading values in [ '--url', '', 'list' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects missing or option-shaped leading values in [ '--url=', 'list' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects missing or option-shaped leading values in [ '--repo' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects missing or option-shaped leading values in [ '--repo', '--help', 'list' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects missing or option-shaped leading values in [ '--repo=--help', 'list' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects missing or option-shaped leading values in [ '--repo', '', 'list' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > rejects missing or option-shaped leading values in [ '--repo=', 'list' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > reports missing operation after [ '--url', 'http://127.0.0.1:1' ]
- cez task > shared flag positions (hearsay-tools/cezarion#554) > reports missing operation after [ '--repo=checkout' ]
- cez task > default output and help (#572, #573, #574) > teaches steer, answer and resume in "send"
- cez task > default output and help (#572, #573, #574) > teaches steer, answer and resume in "--help"
- cez task > send > refuses agent input before discovery with []
- cez task > send > refuses agent input before discovery with ["--resume"]
- cez task > send > refuses agent input before discovery with ["--notify"]
- cez task > send > refuses to reopen a closed session without --resume and names the next command
- cez task > archive, stop, finish, diff, open > notify on a worker is a usage error naming the parent, and subscribes nothing (#635)
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' --'task-file' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' --'request-id' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' --'workflow' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' --'skill' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' --'runner' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' --'backend' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' --'model' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' --'effort' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' --'until' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' --'timeout-seconds' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'list' --'status' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'list' --'limit' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'log' --'since' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'log' --'max-chars' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'log' --'until' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'log' --'timeout-seconds' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'wait' --'mode' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'wait' --'until' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'wait' --'timeout-seconds' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'send' --'text-file' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'notify' --'message' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'notify' --'message-file' needs a string value
- cez task > argument contract (hearsay-tools/cezarion#2352) > start accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > list accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > status accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > log accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > wait accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > send accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > notify accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > stop accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > finish accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > archive accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > unarchive accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > archive-finished accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > diff accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > open accepts help without positionals and rejects values for common flags
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'start' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'list' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'status' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'log' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'wait' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'send' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'notify' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'stop' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'finish' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'archive' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'unarchive' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'archive-finished' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'diff' documents and enforces its positional arguments
- cez task > argument contract (hearsay-tools/cezarion#2352) > 'open' documents and enforces its positional arguments
- cez task > usage > prints help text without discovering a cockpit
- cez task > usage > documents safe task input in ["--help"] (#568)
- cez task > usage > documents safe task input in ["start","--help"] (#568)
- cez task > usage > states the attention contract and the wait default in ["--help"] (#553, #609)
- cez task > usage > states the attention contract and the wait default in ["wait","--help"] (#553, #609)
- cez task > usage > states the attention contract and the wait default in ["start","--help"] (#553, #609)
- cez task > usage > states the attention contract and the wait default in ["status","--help"] (#553, #609)
- cez task > usage > states the attention contract and the wait default in ["list","--help"] (#553, #609)
- cez task > usage > states the attention contract and the wait default in ["log","--help"] (#553, #609)
- cez task > usage > documents the log --follow default in ["--help"] (#931)
- cez task > usage > documents the log --follow default in ["log","--help"] (#931)
- cez task > usage > describes the webhook flags and the notify operation (#589)

### `packages/cezar/src/workflows/agent-profile-wiring.test.ts`

- RunManager agent-profile resolution > adds NOTHING for the default account — the zero-config env is untouched

### `packages/cezar/src/workflows/team-skill-materialize.test.ts`

- team directory skills never land in the main checkout (#1024) > a worktree-off run reads the skill files from the cache, not the main checkout (AC1)
- team directory skills never land in the main checkout (#1024) > a worktree whose agent dirs all link out of it gets the cache copy instead
- team directory skills never land in the main checkout (#1024) > a worktree-off /name opening prompt names the cache copy (#1118)

### `packages/cezar/src/workflows/worker-destroy-orphaned-generation.test.ts`

- worker termination barrier > orphaned generation after a controller crash (#469) > a live foreign controller keeps the generation: nothing is finalized or signalled

### `packages/cezar/src/workspace/backups.test.ts`

- backs up changed config.json once, and skips unchanged writes
- backs up changed agent-accounts.json once, and skips unchanged writes
- prunes in the write: last 20 plus the newest per day within 30 days
- restores pre-change account JSON through the CLI and backs up the replaced version
- keeps config.json.bak recovery and restores an older registry without losing unknown fields
- creates a missing backup directory and warns once for an unusable one without blocking writes
- backs up ui-state and leaves account config directories outside backup scope
- warns when restoring config.json drops invalid snapshot rows
- warns when restoring agent-accounts.json drops invalid snapshot rows
- ignores incomplete or changed snapshots when listing and selecting a restore
- cleans a failed partial staging write without publishing it or blocking the live write
- publishes only completed staging bytes and retries an exclusive publication collision

### `packages/web/src/api/client.test.ts`

- history responses are validated at the boundary (#827) > rejects a /run-summaries/archived answer that is not its shape (#864), never handing the view an array
- history responses are validated at the boundary (#827) > rejects a /workspace/runs-search answer that is not its shape (#864), never handing the view an array
- history responses are validated at the boundary (#827) > rejects a 200 whose page body is the catch-all empty object
- history responses are validated at the boundary (#827) > rejects a 200 whose context body is the catch-all empty object
- new-project calls (spec 2026-10-15-create-new-project) > rejects an owners answer that is not its shape, never handing the dialog owner-less data

### `packages/web/src/components/app-error-boundary.test.tsx`

- AppErrorBoundary > reports the caught error and its component stack to the console

### `packages/web/src/components/app-shell-chrome.test.tsx`

- desktop breadcrumb > names the active view, and Cezarion where no view is active

### `packages/web/src/components/app-shell-container.test.tsx`

- document title wiring > combines the selected project with scoped page context
- document title wiring > falls back to the boot repository name when the registry is unavailable
- document title wiring > keeps global settings and a no-repo task route free of invented project context
- document title wiring > updates after in-app navigation without remounting the shell
- document title wiring > reacts to live project and task title cache updates
- project rail wiring > renders the rail without Add project and All projects when the capability is on

### `packages/web/src/components/app-shell.test.tsx`

- AppShell > explains manual updates beside the version only when a newer release exists

### `packages/web/src/components/home-recovery-banner.test.tsx`

- names the outside-written file and leaves accept available when no restore target is readable
- keeps remote grants read-only even in the local cockpit and gives the host CLI command
- keeps capability-dependent actions unset while health is pending
- keeps capability-dependent actions unset while health is error
- gives host CLI actions for legacy grants with canImport=true
- gives host CLI actions for legacy grants with canImport=false

### `packages/web/src/components/mobile-projects.test.tsx`

- mobile drawer > opens on the identity row, then one row per project, then workspace and global rows

### `packages/web/src/components/project-rail.test.tsx`

- ProjectRail layout > is a labelled nav with the app mark, a mark per project in registry order, and the bottom group
- ProjectRail layout > names the app without a version until health has one
- ProjectRail single-project capability > drops Add project and All projects, and keeps the rest, when the capability is on
- ProjectRail expanded rows (#711) > shows the identity, the Projects label, a labelled Add project and the labelled bottom rows

### `packages/web/src/components/self-update-dialog.test.tsx`

- SelfUpdateDialog > heads the dialog with the version and marks a local build
- SelfUpdateDialog > shows why switching to development failed

### `packages/web/src/components/team-sources-panel.test.tsx`

- TeamSourcesPanel > is read-only on a remote cockpit

### `packages/web/src/components/tools-menu.test.tsx`

- toolsTooltip > is just the cezar version while everything is available
- toolsTooltip > names the missing alternatives as optional while the default runner works
- toolsTooltip > names the default runner when it is the missing one
- toolsTooltip > says so when no agent CLI is present at all
- toolsBlocker > counts every runner the contract knows — a `pi`-only host can start tasks
- ToolsMenu > shows the reference wrench without a warning when every check is available
- ToolsMenu > stays free of warnings while the default runner works and only an optional tool is missing
- ToolsMenu > goes amber when the default runner is the missing one

### `packages/web/src/components/use-application-update.test.tsx`

- preserves actionable state and explains a failed request
- explains manual installation with message undefined
- explains manual installation with message Update this installation manually.

### `packages/web/src/lib/automation-cli.test.ts`

- cliOf > prints a schedule as the add flag form
- cliOf > prints a poll with any-of labels and authors as flags
- cliOf > copies an existing-items choice as a flag
- cliOf > falls back to create --json for what flags cannot say
- Copy as CLI round-trips through a real shell into the cez automation request > a schedule with a hostile prompt
- Copy as CLI round-trips through a real shell into the cez automation request > a prompt that starts with a dash
- Copy as CLI round-trips through a real shell into the cez automation request > --no-autonomous, --enable and a quoted name
- Copy as CLI round-trips through a real shell into the cez automation request > a weekly schedule
- Copy as CLI round-trips through a real shell into the cez automation request > an hourly schedule
- Copy as CLI round-trips through a real shell into the cez automation request > a poll with labels and authors
- Copy as CLI round-trips through a real shell into the cez automation request > a poll including existing matches
- Copy as CLI round-trips through a real shell into the cez automation request > a poll explicitly excluding existing matches
- Copy as CLI round-trips through a real shell into the cez automation request > a poll with a label starting with a dash
- Copy as CLI round-trips through a real shell into the cez automation request > a label event with a changed label
- Copy as CLI round-trips through a real shell into the cez automation request > a poll with exclusions
- Copy as CLI round-trips through a real shell into the cez automation request > a schedule that archives completed tasks
- Copy as CLI round-trips through a real shell into the cez automation request > a poll that merges PRs
- Copy as CLI round-trips through a real shell into the cez automation request > a schedule with both completion controls
- Copy as CLI round-trips through a real shell into the cez automation request > a schedule without workers
- Copy as CLI round-trips through a real shell into the cez automation request > a poll without workers or messaging
- Copy as CLI round-trips through a real shell into the cez automation request > a cockpit-made schedule with a description

### `packages/web/src/lib/use-document-title.test.ts`

- documentTitleOf > formats 'project and page'
- documentTitleOf > formats 'project only'
- documentTitleOf > formats 'page only'
- documentTitleOf > formats 'neither part'
- documentTitleOf > formats 'blank parts'
- documentTitleOf > formats 'empty project'
- useDocumentTitle > updates the existing writer when its truthful inputs change

### `packages/web/src/routes/automations/copy-as-cli-card.test.tsx`

- CopyAsCliCard > prints the line and copies it, saying so
- CopyAsCliCard > once emits --at --tz --latest-start
- CopyAsCliCard > emits --no-workers and --no-messaging when task access is off
- CopyAsCliCard > falls back to the JSON form for what flags cannot say

### `packages/web/src/routes/automations/editor.test.tsx`

- starts task access on and sends an explicit off on create (hearsay-tools/cezarion#2784)
- turns task access back on for an automation saved with it off
- shows Copy as CLI beside both kinds, following the draft
- one-time schedules > choosing Once shows date, time, zone and latest start
- one-time schedules > the summary names the time a DST gap moves the schedule to

### `packages/web/src/routes/new-task-composer.test.tsx`

- the hero surface > defaults task access on and sends an explicit off on create (hearsay-tools/cezarion#2784)

### `packages/web/src/routes/reports.test.tsx`

- Reports shelf > explains loading, empty publication, and errors with Retry

### `packages/web/src/routes/settings/agent-config-section.test.tsx`

- AgentConfigSection > Claude’s MCP group lists the user/local scopes read-only
- AgentConfigSection > renders read-only in hosted mode — no Save button

### `packages/web/src/routes/settings/bookmarklets-section.test.tsx`

- BookmarkletPanel repo-name labels (#422) > stamps the repo name (the sidebar chip basename) into the generic and per-skill labels
- BookmarkletPanel repo-name labels (#422) > falls back to the plain, repo-less label while health is unknown
- BookmarkletPanel repo-name labels (#422) > falls back to the plain label outside a git repository
- BookmarkletPanel project scoping (multi-project spec, step 3.6) > bakes the ACTIVE project's URL prefix and that project's own launch key

### `packages/web/src/routes/settings/provider-settings.test.tsx`

- ProviderSettings > presents discovery truth, enablement, and runtime recovery without hiding diagnostics

### `packages/web/src/routes/settings/worktrees-section.test.tsx`

- Project settings → Worktrees: worktree setup commands (#917) > remote mode names the active host project config, rather than the boot project
- Project settings → Worktrees: worktree setup commands (#917) > a hosted cockpit shows the field read-only
- Project settings → Worktrees: worktree setup commands (#917) > a remote cockpit with remote settings administration edits the field and warns about host commands

### `packages/web/src/routes/task-thread/conversation-presentation.test.ts`

- conversation delivery explanations (hearsay-tools/cezarion#1992) > words an undelivered message by relationship: a parent can resume a worker, nobody resumes a peer

### `packages/web/src/routes/task-thread/preview/preview-states.test.tsx`

- PreviewStates (design 5.1 to 5.18) > 5.14 has no retry or reconnect control, only Close preview and the setups link

### `packages/web/src/routes/task-thread/preview/preview-toolbar.test.tsx`

- PreviewToolbar > an adopted server also shrinks the badge, and says so inside the URL field
- PreviewToolbar > Stop is disabled with the reason on an adopted server
- PreviewToolbar > Escape discards an address draft without navigating and Enter submits the current URL

### `packages/web/src/routes/task-thread/run-header.test.tsx`

- action bar visibility per status (the legacy rules, rendered) > 'queued' → [ 'Notes / handoff', 'Pin task' ]
- action bar visibility per status (the legacy rules, rendered) > 'running' → [ 'Notes / handoff', 'Pin task' ]
- action bar visibility per status (the legacy rules, rendered) > 'waiting' → [ 'Notes / handoff', 'Pin task' ]
- action bar visibility per status (the legacy rules, rendered) > 'review' → [ 'Notes / handoff', 'Open in…', …(3) ]
- action bar visibility per status (the legacy rules, rendered) > 'done' → [ 'Notes / handoff', 'Open in…', …(3) ]
- action bar visibility per status (the legacy rules, rendered) > 'failed' → [ 'Notes / handoff', 'Open in…', …(3) ]
- action bar visibility per status (the legacy rules, rendered) > 'cancelled' → [ 'Notes / handoff', 'Open in…', …(3) ]
- Mark unread (#775) > offers the control for a read, finished run — between Open in… and Pin
- task access settings (hearsay-tools/cezarion#2784) > shows a legacy run without the fields as allowed
- task access settings (hearsay-tools/cezarion#2784) > lets a queued task turn workers off with a scoped PATCH
- task access settings (hearsay-tools/cezarion#2784) > lets a running task turn workers off with a scoped PATCH
- task access settings (hearsay-tools/cezarion#2784) > lets a waiting task turn workers off with a scoped PATCH
- task access settings (hearsay-tools/cezarion#2784) > lets a review task turn workers off with a scoped PATCH
- task access settings (hearsay-tools/cezarion#2784) > lets a done task turn workers off with a scoped PATCH
- task access settings (hearsay-tools/cezarion#2784) > lets a failed task turn workers off with a scoped PATCH
- task access settings (hearsay-tools/cezarion#2784) > lets a cancelled task turn workers off with a scoped PATCH
- task access settings (hearsay-tools/cezarion#2784) > surfaces PATCH errors and keeps the saved setting

### `packages/web/src/routes/task-thread/run-relationships.test.tsx`

- shows a parent parked on Cezar's completion wait, which has no deadline

## Fixed by F9

The coordinator assigned these product defects to F9. Keep both assertions enabled. Fixtures follow projectPaths(root).write and set both dry-run aliases.

- `server/automations-api.test.ts:750`, `GitHub automation API > boot re-baselines an idle enabled poll and launches nothing`: line 752 expects booted.launches to be 0; actual 1.
- `server/automations-api.test.ts:775`, `GitHub automation API > boot fires a past-due schedule on a project without a remote, once across two boots`: line 825 expects the persisted nextRunAt to exceed Date.now(); actual remains the occurrence from three minutes earlier.

Hypothesis: server.ts around 5221 re-baselines automation stores at boot; coordinator.ts:97 caches an AutomationStore opened at projectPaths(projectRoot).write before the boot project moves. The migrated project then uses another path while old handles retain the legacy path.

## Switch-on full checkpoint after fixture repairs

See the exact counts below from the second full run. The two automation boot assertions remain enabled for F9. Typecheck, lint, citations and git diff --check pass at this checkpoint.

```text


 Test Files  1 failed | 1621 passed | 2 skipped (1624)
      Tests  2 failed | 26699 passed | 1 expected fail | 14 skipped (26716)
   Start at  18:44:00
   Duration  1138.20s (transform 75.66s, setup 291.92s, import 806.54s, tests 7522.65s, environment 168.68s)

```

## Switch-on node unit checkpoint

`squeal hold -- npm run test:unit` passed: 137 package unit tests and 1869 root node:test tests, 2006 total; zero failures or cancellations. Package suite earlier had 17 current files with only the F5 read-only fresh-home assertion failing. The switch and generated mobile artifact were then restored to false; the local Squeal package-group configuration was restored.

## Final switch-off local gate

The coordinator waived the local full switch-off Vitest run because other tasks kept host load high. CI will run the complete switch-off suite. The constant, mobile ID artifact, and Squeal configuration are restored to their committed switch-off contents.

- `npm run build`: pass, including check:pack (1957 files, 127 web/dist files).
- Eight changed package files, each through `squeal hold -- npm run test:package -- <path>` sequentially: 65 tests pass, zero failures. Files: application-update, backup-cli, delegation, home-store-cli, package-cli, release-snapshot, release, serve-port.
- Final root lint, typecheck, issue citation check, and diff whitespace check: pass.
- Squeal hold could not acquire its store lock for several calls but still launched the command. Evidence added to hearsay-tools/squeal#162. The commands completed successfully; do not claim the daemon was paused for those calls.
- Changed-file daemon checkpoint: partial, 24 of 129 named files current and passing; 105 pending at that observation. The coordinator waived further waiting. CI covers the rest.

Owner approval: the coordinator obtained approval on 2026-11-10 for the single `packages/cezar/vitest.setup.ts` selector change to `home?.rootOverride ?? home?.root`. No other setup line changed.

Final review cleanup restored original quote style for static test literals without changing their values. The full switch-on run preceded this quote-only cleanup.
