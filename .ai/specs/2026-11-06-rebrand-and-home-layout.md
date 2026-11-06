# Rebrand and a home layout that tests cannot clobber

Status: accepted by the owner (2026-11-06).

Owner decisions (2026-11-06):

- Name: **Skein** (Hearsay Skein). CLI `skein`. See section 2.
- Delivery: all phases ship together in one release. P0 is not released on its own.
- Per-project dir: read both `.ai/cezar/` and `.ai/skein/`; an opt-in `migrate-project` moves it.
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

## 2. New name: Skein

A skein is a flock of geese flying in a V-formation: the birds take turns leading and the
formation holds together. It names the one Hearsay product that leads the others (Peck,
Squeal, Screech, Swoop, Fledge, Reach, Glide, Preen) and fits "keep agents on the radar".

Checks done 2026-11-06 (npm, GitHub, Homebrew, Debian command-not-found, DNS, web and GitHub
search for coding-agent tools):

| Surface | Result |
| --- | --- |
| CLI `skein` | Free in Homebrew and Debian; no coding-agent tool installs it |
| Same-name projects | `skeinui/skein` (React components, 6 stars); no agent orchestrator |
| npm | unscoped `skein` taken (an encryption add-on, 1.0.21); `@hearsay-tools/skein` free |
| GitHub | `skein` is a user account; `hearsay-tools/skein` free |
| Domains | `skein.com/.dev/.sh/.ai/.io/.app` all registered; use `skein.hearsay.tools` |

Rejected on the way: Ostlery, Drovery (rare words), Squawk (CLI `squawk` belongs to the
`sbdchd/squawk` Postgres linter and three small agent tools), Murmur (Macroscope's
orchestrator), Castra, Decurion, Legatio, Roost, Perch, Caw, Covey (agent tools with the same
name), Flock, Hatch, Nest (existing commands), and Roman and English words with npm or brew
collisions. Cezarion was the no-rename option.

The safety fix in sections 3 and 4 does not depend on the name: any name other than `cezar`
moves the live install away from what upstream and old builds resolve.

### What gets renamed

| Surface | Now | After | Old name during the deprecation window |
| --- | --- | --- | --- |
| npm package | `@wjarka/cezarion`, alias `cezarion` | `@hearsay-tools/skein` (unscoped `skein` is taken, so no unscoped alias; `npx @hearsay-tools/skein`) | last `cezarion` release depends on the new package and prints a notice; then `npm deprecate` |
| CLI binary | `cezarion`, `cez` | `skein` | `cez` and `cezarion` work and print one notice to stderr, never to JSON stdout |
| Env vars | 144 `CEZ_*` names in source, 85 in `.env.example` | `SKEIN_*` | `CEZ_*` read as fallback; the new name wins; one boot warning lists the old names that are set |
| Per-project dir | `.ai/cezar/` (505 files mention it) | `.ai/skein/` | both read; opt-in `skein migrate-project` moves it when no task is live and repairs worktrees |
| Home | `~/.cezar`, `~/.cache/cez` | section 3 layout | read once by the migration, then a canary |
| GitHub repo | `hearsay-tools/cezarion` | `hearsay-tools/skein` (GitHub redirects the old name) | old citations stay valid; the citation checker accepts both |
| Docs | README, AGENTS.md, docs/, specs | new name; specs and ADRs keep history | — |
| Desktop / mobile ids | `tools.hearsay.cezarion`, `tools.hearsay.cezarion.mobile` | `tools.hearsay.skein`, `tools.hearsay.skein.mobile` | section 4.1 |
| launchd labels | `ai.cezar.cockpit`, `ai.cezar.ngrok` (same as upstream) | `tools.hearsay.skein.cockpit`, `tools.hearsay.skein.ngrok` | migration unloads the old label only if its plist points at our binary |
| systemd / nginx | `cezar.service`, `cezar-<slug>.service`, site `cezar-<slug>` | `skein.service`, `skein-<slug>.service`, site `skein-<slug>` | server migration swaps them, with rollback |

## 3. New home layout and live-install protection

### Layout

Resolved once, at the process entry point, from the platform. No setting is required.

| Kind | Holds | Linux | macOS | Windows |
| --- | --- | --- | --- | --- |
| config | `config.json` (registry, settings), `agent-accounts.json`, `remote-settings/`, secrets, `install.json` marker | `$XDG_CONFIG_HOME/skein` (`~/.config/skein`) | `~/Library/Application Support/Skein/config` | `%APPDATA%\Skein` |
| state | `ui-state.json`, `server.json`, `server-instances/`, `backups/`, migration log | `$XDG_STATE_HOME/skein` (`~/.local/state/skein`) | `~/Library/Application Support/Skein/state` | `%LOCALAPPDATA%\Skein\state` |
| data | managed install `versions/`, `bin/` | `$XDG_DATA_HOME/skein` (`~/.local/share/skein`) | `~/Library/Application Support/Skein/data` | `%LOCALAPPDATA%\Skein\data` |
| cache | skills cache (now `~/.cache/cez`), `dry-cache/`, `dry-prefix/` | `$XDG_CACHE_HOME/skein` | `~/Library/Caches/Skein` | `%LOCALAPPDATA%\Skein\cache` |
| runtime | locks, sockets, agent temp fallback (now `~/.cezar/tmp/agent`) | `$XDG_RUNTIME_DIR/skein`, else `<state>/run` | `$TMPDIR/skein` | `%LOCALAPPDATA%\Skein\run` |

`SKEIN_HOME=<dir>` keeps a one-root layout (`<dir>/config`, `state`, `data`, `cache`,
`run`) for containers, tests and hosts that want one directory.

### How a live install is told apart from a test or dev home

1. **The live path never leaves the cockpit.** `buildChildEnv` drops every home-locating
   variable (`CEZ_HOME`, `SKEIN_HOME`, `XDG_*` overrides that the cockpit itself set) for
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
   one setup that scrubs `CEZ_*` and `SKEIN_*`, pins `HOME`, `XDG_*` and `SKEIN_HOME`
   to a sandbox, and writes a `test` marker. A lint rule refuses test code that writes
   through a home path it did not get from `Home.sandbox`.

## 4. Migration for existing installs

One code path, `migrateLegacyHome()`, runs at the first boot of the new build and as
`skein migrate [--dry-run]`.

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
`SKEIN_HOME` one-root, migrate in place into `config/`, `state/`, and so on.

**Server installs** (apptension-host serves 12 projects): `skein server migrate` handles each
instance in `server.json` and `server-instances/`: stop the old unit, migrate, install
`skein[-<slug>].service` and the nginx site on the same port, start, check health. On
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
plus one per day for 30 days. `skein backup list` and `skein backup restore <file>
[--at <time>]` restore one. When a write shrinks a non-empty registry to zero projects or
zero accounts, the cockpit shows a banner with a one-click restore of the newest backup.
`config.json.bak` (ADR 0010) becomes the newest entry of this set.

## 6. Delivery

### One release, landed dark

The owner wants every phase to reach users together. Two facts shape how:

- Stable `latest` releases are manual (`release.yml`), but every green push to `main`
  publishes the `dev` dist-tag, and hosts such as apptension-host run `dev` builds. So
  `main` is close to live.
- A long-lived integration branch would collect weeks of conflicts with a busy `main`, and
  the campaign skill requires slices that land on `main` one by one.

So each slice lands on `main` and keeps shipped behavior unchanged, except for safety fixes
that users cannot see. The new layout, the migration and the new names stay off behind one
code constant, `SKEIN_SWITCH` in `packages/cezar/src/home/switch.ts` (not an env var; no
setting). Tests run both states. One **switch PR** turns it on; that PR and the stable
release are the single user-visible change.

| Phase | Slices (one PR each unless noted) | Visible before the switch? |
| --- | --- | --- |
| **P0 Safety** | (a) `buildChildEnv` never forwards `CEZ_HOME` (or any later home variable); the launcher stops writing a default `CEZ_HOME`. (b) The guard compares against `os.userInfo().homedir` (passwd, not `$HOME`), runs for every env object, and covers `node:test`; `test:unit` and `test:package` load the sandbox setup. (c) Rotating backups for `config.json` and `agent-accounts.json`. (d) Issue to `apptension/toolkit-dev`: audit-agent-readiness probes run foreign suites with a scrubbed env and a temp `HOME`. | No: backups appear in the state dir only |
| **P1 Home object** | (a) `Home` type and `resolveHome` (legacy layout while the switch is off), passed down from entry points; no ambient `cezarHomeDir()`. (b) `HomeStore` writer with `install.json` marker (written into the legacy home too), test-runner refusal and lease. (c) Backups and restore command for every registry-type file; shrink banner. (d) Lint: test code writes only through `Home.sandbox`. ADR superseding the "literal `~/.cezar`" rule. | No (backup restore command is new) |
| **P2 Layout and migration** | (a) XDG / macOS / Windows / `SKEIN_HOME` resolver. (b) `migrateLegacyHome` with backup, `MOVED.json`, canary. (c) Server migration for systemd units and nginx sites, with rollback. (d) launchd label move. All behind the switch. | No |
| **P3 Name surfaces** | (a) One env helper: `SKEIN_*` first, `CEZ_*` fallback (additive). (b) `skein` bin added beside `cezarion` and `cez` (additive). (c) Package `@hearsay-tools/skein` prepared; publish waits for the switch. (d) Desktop and mobile new IDs and the bridge build, behind the switch. (e) Docs and display names, merged with the switch PR. | Additive names only |
| **P4 Project dir** | Dual read of `.ai/cezar/` and `.ai/skein/` (additive); `skein migrate-project` (refuses while a task is live; moves the dir; runs `git worktree repair`). | Command only |
| **Switch** | Turn `SKEIN_SWITCH` on; deprecation notices start; docs land. Then owner actions: stable release, npm publish and deprecate, repo rename, store listings, apptension-host server migration. | Yes: the release |
| **P5 Window end** | Remove aliases and `CEZ_*` fallbacks, two minor releases or 60 days after the release. | Yes |

Dependencies: P1(a) before every other P1, P2 and P3(a); P2(a) before P2(b–d); P2(b) before
P2(c); P1(b) before P2(b). P0 and P3(a–b) run in parallel with P1. The switch needs every
phase accepted on `main`.

Every slice updates `BACKWARD_COMPATIBILITY.md`, `.env.example` and the area docs it touches.
