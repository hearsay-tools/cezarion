# Rebrand and a home layout that tests cannot clobber

Status: proposal, waiting for owner acceptance (2026-11-06).

Owner decisions so far (2026-11-06):

- Name: open. The owner's working name is **Squawk** (Hearsay bird; aviation transponder code;
  "keep agents on the radar"; parrot logo with pilot goggles). See section 2.1.
- Delivery: all phases ship together in one release. P0 is not released on its own.
- Per-project dir: read both `.ai/cezar/` and the new dir; an opt-in `migrate-project` moves it.
- Desktop and mobile bundle IDs: change them too (section 4.1).

## 1. Incident and root cause

On 2026-11-06 between 10:55:53 and 10:59:15 Europe/Warsaw, a process wrote test fixtures
into the live `~/.cezar` on apptension-host:

| Leaked file | Writer |
| --- | --- |
| `config.json` → `{"disabledProviders":["opencode"]}` | upstream `packages/cezar/src/workflows/agent-fallback-run.test.ts:265` |
| `agent-accounts.json` (accounts `second`, `third`), `claude-second/`, `claude-third/` | upstream `agent-fallback-run.test.ts:39-48` (`registerAccounts`) |
| `tracker-connections/aaaa….env` (0 bytes) | upstream `packages/cezar/src/feature-telemetry.test.ts:80` |
| `~/Library/LaunchAgents/ai.cezar.ngrok.plist` | upstream `server-install/platforms/macosx-ngrok.ts:18` (`homedir()`) |
| `tmp/agent/` (353 dirs) | upstream agent temp fallback under the home |

"Upstream" is `open-mercato/cezar` at `origin/main` `aad51073`, checked out in the registered
project `/home/agent/projects/open-mercato-cezar`.

The chain:

1. **The live home path is in every task shell.** The user unit
   `~/.config/systemd/user/cezar.service` sets `Environment=CEZ_HOME=/home/agent/.cezar`.
   `buildChildEnv` forwards every non-secret `CEZ_*` variable to agent sessions
   (`packages/cezar/src/core/agent-env.ts:402`). So each agent shell has
   `CEZ_HOME=/home/agent/.cezar`.
2. **An agent ran a foreign copy of the test suite in that shell.** Task `acda9628`
   (audit-agent-readiness on the `open-mercato-cezar` project) made a temp worktree of
   upstream `origin/main` at 09:54:39Z and ran `probe.sh`: `npm ci`, `typecheck`, `npm test`,
   `test:unit`, `build`, `test:package`. The writes match the `npm test` (Vitest) window.
3. **Upstream's sandbox accepts an inherited home.** Upstream `vitest.setup.ts` pins
   `CEZ_HOME` only `if (!process.env.CEZ_HOME)`. It does not scrub inherited `CEZ_*` values
   and does not pin `HOME`. With the inherited value, the "sandbox" was the live home.
4. **The write guard cannot see this class.** `assertCezarHomeWriteIsSandboxed`
   (`packages/cezar/src/paths.ts:37`) runs only inside product writers, not in test code
   that calls `writeFileSync(join(cezarHomeDir(), …))`. It compares against
   `join(homedir(), '.cezar')`, which in our suite is the pinned fake `HOME`, so it never
   matches the real home. It returns early when the caller passes an env object without
   `VITEST`. And it lives in each copy of the code, so a foreign copy has its own rules.

Our own suite was not the writer: `packages/cezar/vitest.setup.ts` scrubs every `CEZ_*`
variable and pins `HOME`. The defect that we own is step 1, plus a home location that
every old or foreign copy of the code also resolves by default (`~/.cezar`).

## 2. New name

Checks done 2026-11-06: unscoped npm, GitHub user/org, Homebrew formula, Debian
command-not-found, DNS NS records (no NS record means "probably free"; a registrar check is
still needed), and a web search for products with the same name.

| Candidate | npm | GitHub | brew / apt | Domains (.com/.dev/.sh/.ai) | Same-name products |
| --- | --- | --- | --- | --- | --- |
| **Ostlery** (recommended) | free | no account | free / free | taken / free? / free? / free? | none found |
| Drovery | free | no account | free / free | taken / free? / free? / free? | Indian shopping app on Google Play |
| Cezarion (finish the fork name) | ours (`cezarion` 0.17.0) | our repo `hearsay-tools/cezarion` | free / free | taken / free? / free? / free? | none; the historic figure |

Rejected: Castra, Decurion, Legatio (each is already an AI-agent orchestrator or gateway);
Cohort, Praetor, Tribune, Consul, Quaestor, Tessera, Agentry, Tasklane (npm or product
collisions); Paddock, Tiller, Corral, Bosun, Helmsman, Wrangler (npm or brew collisions).

*Ostlery* is an old word for an inn's stable yard: the place where travellers' horses get a
stall, food and care, and leave ready. Each task gets its own stall (worktree) and leaves
through the review gate. Its weakness: the word is rare, so people must learn the spelling.

*Cezarion* is the lowest-cost option. The safety fix in sections 3 and 4 does not depend on
the name: any name other than `cezar` moves the live install away from what upstream and old
builds resolve.

### 2.1 Squawk (owner's working name)

Checks done 2026-11-06:

| Surface | Result |
| --- | --- |
| CLI `squawk` | Taken in our field. `sbdchd/squawk` (Postgres migration linter, 1.2k stars, active today) installs a `squawk` binary through npm `squawk-cli`, pip and others. `Jack-Lin-DS-AI/squawk` (Claude Code monitor, Homebrew tap) also installs `squawk`. |
| Same-name agent tools | `Jack-Lin-DS-AI/squawk` (Claude Code loop monitor), `goriparthi/squawk` (Claude Code approval dock), `studypilot/squawk` (review comments for agents, `squawk watch`), Sqwakie (multi-agent live view). All small. |
| npm | unscoped `squawk` taken; `@hearsay-tools/squawk` available to us |
| GitHub | `squawk` is a user account; `hearsay-tools/squawk` free |
| Domains | `squawk.com/.dev/.sh/.ai/.io/.app` all registered; `hearsay.tools` is registered (ours, per the app IDs), so `squawk.hearsay.tools` works |
| Short CLI | `sqk` and `sqwk` free in Homebrew and Debian |

Rules if Squawk is chosen:

- Brand "Hearsay Squawk"; package `@hearsay-tools/squawk`; repo `hearsay-tools/squawk`;
  site `squawk.hearsay.tools`.
- The binary must not be a bare `squawk`: a Postgres user would get one tool shadowing the
  other on `PATH`. Use `hsquawk` or `sqk` (decision open).
- The home dirs must not be a bare `squawk` either: another `squawk` could use
  `~/.config/squawk`, which is the clobber class this spec removes. Use
  `~/.config/hearsay-squawk` (and the same for state, data, cache, runtime).
- Env prefix `SQUAWK_` is shared with nobody we found, but `HSQ_` or `HEARSAY_SQUAWK_` is
  safer for the same reason. Proposed: `SQUAWK_`, because env vars reach only our children.

### What gets renamed (shown for Ostlery)

| Surface | Now | After | Old name during the deprecation window |
| --- | --- | --- | --- |
| npm package | `@wjarka/cezarion`, alias `cezarion` | `@hearsay-tools/ostlery`, alias `ostlery` | last `cezarion` release depends on the new package and prints a notice; then `npm deprecate` |
| CLI binary | `cezarion`, `cez` | `ostlery`, short `osl` (free in brew and Debian) | `cez` and `cezarion` work and print one notice to stderr, never to JSON stdout |
| Env vars | 144 `CEZ_*` names in source, 85 in `.env.example` | `OSTLERY_*` | `CEZ_*` read as fallback; the new name wins; one boot warning lists the old names that are set |
| Per-project dir | `.ai/cezar/` (505 files mention it) | `.ai/ostlery/` | see decision 3 |
| Home | `~/.cezar`, `~/.cache/cez` | section 3 layout | read once by the migration, then a canary |
| GitHub repo | `hearsay-tools/cezarion` | `hearsay-tools/ostlery` (GitHub redirects) | old citations stay valid; the citation checker accepts both |
| Docs | README, AGENTS.md, docs/, specs | new name; specs and ADRs keep history | — |
| Desktop / mobile ids | `tools.hearsay.cezarion`, `tools.hearsay.cezarion.mobile` | unchanged (see decision 4); display name changes | — |
| launchd labels | `ai.cezar.cockpit`, `ai.cezar.ngrok` (same as upstream) | `tools.hearsay.ostlery.cockpit`, `tools.hearsay.ostlery.ngrok` | migration unloads the old label only if its plist points at our binary |
| systemd / nginx | `cezar.service`, `cezar-<slug>.service`, site `cezar-<slug>` | `ostlery.service`, `ostlery-<slug>.service`, site `ostlery-<slug>` | server migration swaps them, with rollback |

## 3. New home layout and live-install protection

### Layout

Resolved once, at the process entry point, from the platform. No setting is required.

| Kind | Holds | Linux | macOS | Windows |
| --- | --- | --- | --- | --- |
| config | `config.json` (registry, settings), `agent-accounts.json`, `remote-settings/`, secrets, `install.json` marker | `$XDG_CONFIG_HOME/ostlery` (`~/.config/ostlery`) | `~/Library/Application Support/Ostlery/config` | `%APPDATA%\Ostlery` |
| state | `ui-state.json`, `server.json`, `server-instances/`, `backups/`, migration log | `$XDG_STATE_HOME/ostlery` (`~/.local/state/ostlery`) | `~/Library/Application Support/Ostlery/state` | `%LOCALAPPDATA%\Ostlery\state` |
| data | managed install `versions/`, `bin/` | `$XDG_DATA_HOME/ostlery` (`~/.local/share/ostlery`) | `~/Library/Application Support/Ostlery/data` | `%LOCALAPPDATA%\Ostlery\data` |
| cache | skills cache (now `~/.cache/cez`), `dry-cache/`, `dry-prefix/` | `$XDG_CACHE_HOME/ostlery` | `~/Library/Caches/Ostlery` | `%LOCALAPPDATA%\Ostlery\cache` |
| runtime | locks, sockets, agent temp fallback (now `~/.cezar/tmp/agent`) | `$XDG_RUNTIME_DIR/ostlery`, else `<state>/run` | `$TMPDIR/ostlery` | `%LOCALAPPDATA%\Ostlery\run` |

`OSTLERY_HOME=<dir>` keeps a one-root layout (`<dir>/config`, `state`, `data`, `cache`,
`run`) for containers, tests and hosts that want one directory.

### How a live install is told apart from a test or dev home

1. **The live path never leaves the cockpit.** `buildChildEnv` drops every home-locating
   variable (`CEZ_HOME`, `OSTLERY_HOME`, `XDG_*` overrides that the cockpit itself set) for
   agent sessions and host commands. A task that needs the cockpit uses its API URL and
   token, not the home path. The self-update launcher (`self-update/launcher.ts:22`) stops
   writing a `CEZ_HOME` that equals the default into the launcher script.
2. **Explicit resolution.** Library code has no ambient `cezarHomeDir()`. The CLI and server
   entry points call `resolveHome({ purpose })` once and pass a `Home` object down. Tests
   build `Home.sandbox(tmpdir)`. A module that needs a path and has no `Home` cannot get one.
3. **Install marker.** The config dir holds `install.json`
   (`{ installId, kind: "live" | "dev" | "test", createdAt, migratedFrom? }`). Only
   `serve`, `init` and the migration create a `live` marker. One `HomeStore` writer handles
   every registry-type write and refuses:
   - a write to a home whose marker is `live` from a process that runs under a test runner
     (`VITEST`, `NODE_TEST_CONTEXT`, `JEST_WORKER_ID`, `STRYKER_*`), whatever the env object
     or `HOME` says;
   - a write to a dir with no marker, unless the caller is an entry point that creates one.
   The check reads the marker, not the path, so pinned `HOME`, inherited variables and
   custom env objects cannot hide the live home.
4. **Per-install lease.** The serving cockpit holds a lock file in the runtime dir
   (`cockpit.lock`: pid, installId). CLI writers from other processes take the same short
   lock. This stops lost updates; the marker stops tests.
5. **Foreign and old code.** We cannot change what upstream or an old build does. After
   migration, their default (`~/.cezar`) is no longer the live home. The new build watches
   it as a canary: a write there after migration shows a warning that names the file and time.
6. **Our suites.** Both Vitest and the `node:test` suites (`test:unit`, `test:package`) load
   one setup that scrubs `CEZ_*` and `OSTLERY_*`, pins `HOME`, `XDG_*` and `OSTLERY_HOME`
   to a sandbox, and writes a `test` marker. A lint rule refuses test code that writes
   through a home path it did not get from `Home.sandbox`.

## 4. Migration for existing installs

One code path, `migrateLegacyHome()`, runs at the first boot of the new build and as
`ostlery migrate [--dry-run]`.

1. Take `~/.cezar/.migrating` with `O_EXCL`. A second process waits or stops.
2. If the new config dir has `install.json` with `migratedFrom`, do nothing (idempotent).
3. Write a full backup: `<state>/backups/legacy-cezar-home-<UTC>.tar.gz` (without `versions/`,
   caches and `tmp/`).
4. Copy, never move, each file into the new layout (temp file, fsync, rename). Parse and hash
   each copy and compare.
5. Write the `live` marker with `migratedFrom`, then `~/.cezar/MOVED.json` with the new paths.
   Leave the rest of `~/.cezar` as it is.
6. Agent accounts whose `configDir` is inside `~/.cezar` keep their path. Settings shows
   which accounts still point there. The window-end cleanup never deletes `~/.cezar`; it
   prints what still uses it.

**`CEZ_HOME` set to a non-default dir** (containers, custom hosts): treat it as
`OSTLERY_HOME` one-root, migrate in place into `config/`, `state/`, and so on.

**Server installs** (apptension-host serves 12 projects): `ostlery server migrate` handles each
instance in `server.json` and `server-instances/`: stop the old unit, migrate, install
`ostlery[-<slug>].service` and the nginx site on the same port, start, check health. On
failure it re-enables the old unit and old site. Old unit files stay as `*.migrated`.

**Desktop installs**: the bundled server runs the same migration at boot. launchd labels move
as in section 2.

### 4.1 New bundle IDs

A new identifier is a new app to the OS and the stores:

- Desktop (Tauri): the last old-ID release updates itself one more time to a small bridge
  build. The bridge installs the new-ID app, hands over the window state, and removes itself.
  macOS asks again for permissions bound to the old ID (notifications, automation). Keychain
  items stored under the old ID are copied by the bridge while it still has access.
- Mobile: a new `applicationId` / bundle ID is a new store listing. The old app gets a final
  release that tells the user to install the new one and opens its store page. Paired-device
  data is re-paired, not copied.

**Deprecation window**: two minor releases or 60 days, whichever is later. During it: old
binaries, `CEZ_*` variables and `.ai/cezar` work with a notice. After it: aliases and env
fallbacks go; a boot still logs any `CEZ_*` that is set, so nobody loses a setting silently.

## 5. Backups for every registry-type file

`HomeStore` writes `config.json`, `agent-accounts.json`, secrets and connection files,
`remote-settings/*` and `server*.json`. Before it replaces a file whose content changed, it
copies the current one to `<state>/backups/<file>/<UTC>-<sha8>.json`. It keeps the last 20
plus one per day for 30 days. `ostlery backup list` and `ostlery backup restore <file>
[--at <time>]` restore one. When a write shrinks a non-empty registry to zero projects or
zero accounts, the cockpit shows a banner with a one-click restore of the newest backup.
`config.json.bak` (ADR 0010) becomes the newest entry of this set.

## 6. Delivery

| Phase | PRs | Needs the name? |
| --- | --- | --- |
| **P0 Stop the bleed** | (a) `buildChildEnv` never forwards `CEZ_HOME`; the launcher stops writing a default `CEZ_HOME`. (b) Guard compares against `os.userInfo().homedir` (passwd, not `$HOME`), runs for every env object and under `node:test` too; node:test suites load the sandbox setup. (c) Rotating backups for `config.json` and `agent-accounts.json`. (d) Issue to `apptension/toolkit-dev`: audit-agent-readiness probes run foreign suites with a scrubbed env and a temp `HOME`. Ops: drop `CEZ_HOME` from apptension-host's hand-written unit (`~/.config/systemd/user/cezar.service`). | no |
| **P1 Home object and layout** | `resolveHome`, `Home` passed down, XDG/macOS/Windows layout behind the current names, marker, `HomeStore`, lease, backups for all registry files, test lint. ADR superseding the "literal `~/.cezar`" rule in `paths.ts`. | layout dir name only |
| **P2 Migration** | `migrateLegacyHome`, canary, server migrate with rollback, launchd label move. | yes |
| **P3 Rename surface** | npm package and aliases, CLI bins, `OSTLERY_*` with `CEZ_*` fallback through one env helper, docs, repo rename, display names, systemd and nginx names. Several mechanical PRs, one per surface. | yes |
| **P4 Per-project dir** | per decision 3. | yes |
| **P5 Window end** | remove aliases and fallbacks. | yes |

All phases ship in one release (owner decision). Phases stay separate PRs for review; they land on
an integration branch `rebrand` and merge into `main` together, so no release carries half of it.
Every phase updates `BACKWARD_COMPATIBILITY.md`, `.env.example` and the area docs it touches.
