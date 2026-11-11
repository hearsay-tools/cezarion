# Rebrand and a home layout that tests cannot clobber

Status: accepted by the owner (2026-11-06). Epic: hearsay-tools/cezarion#2778.

Owner decisions (2026-11-06):

- Name: **Squawk** (Hearsay Squawk); CLI `hsq`; npm `@hearsay-tools/squawk`, with no unscoped
  alias (section 2). Skein was chosen first, then reopened.
- Delivery: one release. Slices land dark on `main` behind `REBRAND_SWITCH`; one switch PR turns
  them on. The P0 safety fixes take effect as they merge (section 6).
- Merge authority: phase coordinators merge slice PRs through land-pr. The switch PR, the npm
  publish, the repo rename, the store listings and the server migration wait for the owner.
- Per-project dir: read both `.ai/cezar/` and `.ai/squawk/`; an opt-in `migrate-project` moves it
  once the deprecation window ends (older binaries need the real `.ai/cezar`).
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
| `tmp/agent/` (353 dirs) | upstream's agent temp fallback under the home (ours is per project, `runs/agent-tmpdir.ts`) |

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

## 2. New name: Squawk

The owner chose **Squawk** (brand "Hearsay Squawk"): a parrot repeats what others say (the
Hearsay family), and in aviation a squawk is the transponder code that keeps an aircraft on
radar ("keep agents on the radar"; the logo is a parrot with pilot goggles).

The bare word collides, so each surface uses a form that does not (checked 2026-11-06):

| Surface | Form | Why |
| --- | --- | --- |
| CLI | `hsq` | The `squawk` command belongs to the `sbdchd/squawk` Postgres linter (npm `squawk-cli`, pip) and to small Claude Code tools (`Jack-Lin-DS-AI/squawk`). `hsq` is free in npm, Homebrew and Debian. |
| npm | `@hearsay-tools/squawk`, no unscoped alias | Unscoped `squawk` is taken. npm refuses unscoped `hsq` as too similar to existing names (403 on the first publish, owner decision A1, 2026-11-11). One-off runs use `npx -p @hearsay-tools/squawk hsq`. |
| Env prefix | `HSQ_*` | Matches the command and shares no prefix with the other `squawk` tools. |
| Home folders, services | `hearsay-squawk` | Another `squawk` tool could use `~/.config/squawk`, which is the clobber class this spec removes. |
| Repo dir, app IDs, launchd | `.ai/squawk/`, `tools.hearsay.squawk`, `tools.hearsay.squawk.*` | Inside our own namespaces; no collision. |
| GitHub, site | `hearsay-tools/squawk`, `squawk.hearsay.tools` | All plain `squawk.*` domains are registered. |

Considered before: Skein (most people read it as yarn), Ostlery, Drovery (rare words),
Cezarion (no rename); rejected for collisions: Murmur, Castra, Decurion, Legatio, Roost, Perch,
Caw, Covey, Flock, Hatch, Nest.

### What gets renamed

| Surface | Now | After | Old name during the deprecation window |
| --- | --- | --- | --- |
| npm package | `@wjarka/cezarion`, alias `cezarion` | `@hearsay-tools/squawk` (no unscoped alias, A1) | matching old scoped and `cezarion` forwarding releases pin the new package exactly during the window; the dispatcher prints one notice; the last pair ships at window end, then `npm deprecate` (planner X4) |
| CLI binary | `cezarion`, `cez` | `hsq` | `cez` and `cezarion` work and print one notice to stderr, never to JSON stdout |
| Env vars | 144 `CEZ_*` names in source, 85 in `.env.example` | `HSQ_*` | `CEZ_*` read as fallback; the new name wins; one boot warning lists the old names that are set |
| Per-project dir | `.ai/cezar/` (505 files mention it) | `.ai/squawk/` | both read; automatic move at cockpit start for each registered project that no other writer uses and that has a clean plan (a task that is not archived keeps its own items in `.ai/cezar/` until a later move after it is archived, owner decision A, 2026-11-11), and `hsq migrate-project`, with the release switch (P4); a moved project (marker in the Git common directory, keyed by the project root) writes `.ai/squawk/` and reads `.ai/cezar/` as the fallback, a fresh project with no `.ai/cezar` path and an absent or real `.ai/squawk` directory starts in `.ai/squawk/` and records the same marker before its first write; an existing legacy path keeps the migration rules (hearsay-tools/cezarion#3150) |
| Home | `~/.cezar`, `~/.cache/cez` | section 3 layout | read once by the migration, then a canary |
| GitHub repo | `hearsay-tools/cezarion` | `hearsay-tools/squawk` (GitHub redirects the old name) | old citations stay valid; the citation checker accepts both |
| Docs | README, AGENTS.md, docs/, specs | new name; specs and ADRs keep history | — |
| Desktop / mobile ids | `tools.hearsay.cezarion`, `tools.hearsay.cezarion.mobile` | `tools.hearsay.squawk`, `tools.hearsay.squawk.mobile` | section 4.1 |
| launchd labels | `ai.cezar.cockpit`, `ai.cezar.ngrok` (same as upstream) | `tools.hearsay.squawk.cockpit`, `tools.hearsay.squawk.ngrok` | migration unloads an old label only if it is ours: the cockpit plist when it points at our launcher, the ngrok plist when the server-install state records it as an owned artifact (`macosx-ngrok.ts` records it) |
| systemd / nginx | `cezar.service`, `cezar-<slug>.service`, site `cezar-<slug>` | `hearsay-squawk.service`, `hearsay-squawk-<slug>.service`, site `hearsay-squawk-<slug>` | server migration swaps them, with rollback |

## 3. New home layout and live-install protection

### Layout

Resolved once, at the process entry point, from the platform. No setting is required.

| Kind | Holds | Linux | macOS | Windows |
| --- | --- | --- | --- | --- |
| config | `config.json` (registry, settings), `agent-accounts.json`, `remote-settings/`, secrets, `install.json` marker | `$XDG_CONFIG_HOME/hearsay-squawk` (`~/.config/hearsay-squawk`) | `~/Library/Application Support/Hearsay Squawk/config` | `%APPDATA%\Hearsay Squawk` |
| state | `ui-state.json`, `server.json`, `server-instances/`, `backups/`, migration log | `$XDG_STATE_HOME/hearsay-squawk` (`~/.local/state/hearsay-squawk`) | `~/Library/Application Support/Hearsay Squawk/state` | `%LOCALAPPDATA%\Hearsay Squawk\state` |
| data | managed install `versions/`, `bin/` | `$XDG_DATA_HOME/hearsay-squawk` (`~/.local/share/hearsay-squawk`) | `~/Library/Application Support/Hearsay Squawk/data` | `%LOCALAPPDATA%\Hearsay Squawk\data` |
| cache | skills cache (now `~/.cache/cez`), `dry-cache/`, `dry-prefix/` | `$XDG_CACHE_HOME/hearsay-squawk` | `~/Library/Caches/Hearsay Squawk` | `%LOCALAPPDATA%\Hearsay Squawk\cache` |
| runtime | sockets and temp files only; locks and leases live in `<config>/.locks/` (below) | `$XDG_RUNTIME_DIR/hearsay-squawk`, else `<state>/run` | `$TMPDIR/hearsay-squawk` | `%LOCALAPPDATA%\Hearsay Squawk\run` |

`HSQ_HOME=<dir>` keeps a one-root layout (`<dir>/config`, `state`, `data`, `cache`,
`run`) for containers, tests and hosts that want one directory.

### How a live install is told apart from a test or dev home

1. **The live path never leaves the cockpit.** `buildChildEnv` drops every home-locating
   variable (`CEZ_HOME`, `HSQ_HOME`, `XDG_*` overrides that the cockpit itself set) for
   agent sessions and host commands. A task that needs the cockpit uses its API URL and
   token, not the home path.
2. **Explicit resolution.** Library code has no ambient `cezarHomeDir()`. The CLI and server
   entry points call `resolveHome({ purpose })` once and pass a `Home` object down. Tests
   build `Home.sandbox(tmpdir)`. A module that needs a path and has no `Home` cannot get one.
3. **Install marker.** The config dir holds `install.json`
   (`{ installId, kind: "live" | "dev" | "test", createdAt, migratedFrom? }`). The migration
   writes the `live` marker of a migrated home. Without one, every home-writing entry (serve,
   init, run, backup restore, the first authorized registry write) creates the fresh `live`
   marker on its first authorized write; read-only and invalid commands create no marker and
   write nothing (section 4 step 1). One `HomeStore` writer handles
   every registry-type write and refuses:
   - a write to a home whose marker is `live` from a process that runs under a test runner
     (`VITEST`, `NODE_TEST_CONTEXT`, `JEST_WORKER_ID`, `STRYKER_*`), whatever the env object
     or `HOME` says;
   - a write to a dir with no marker, unless the caller is an entry point that creates one.
   The check reads the marker, not the path, so pinned `HOME`, inherited variables and
   custom env objects cannot hide the live home. A `test` marker is never written to the
   account's real home: a test marker request (`Home.sandbox`, `scripts/test-install-marker.mjs`)
   refuses the account's legacy and platform roots in every process, test runner or not.
4. **Presence leases and write lock.** Two kinds of file in `<config>/.locks/`. They sit in
   the config dir, which identifies the home, not in the runtime dir, which depends on each
   process's `XDG_RUNTIME_DIR`; so a server and a CLI that share a home always share them. Each serving
   cockpit holds a lease (pid, installId, instance) for its whole life; it only tells other
   processes that a cockpit serves this home (the migration reads it, step 2 in section 4).
   One home can serve several cockpits (server instances), so each one holds its own file,
   `cockpits/<pid>.lease`; a lease whose pid is gone is stale and is removed on read.
   Every reader and writer, the cockpit included, takes the `write.lock` of the root that holds
   the file (`<config>/.locks/` for config files, `<state>/.locks/` for state files) only for
   that one file's read or read-modify-write, so CLI writers never wait on the cockpit's lifetime. This stops lost updates; the
   marker stops tests.
5. **Foreign and old code.** We cannot change what upstream or an old build does. After
   migration, their default (`~/.cezar`) is no longer the live home. The new build watches
   it as a canary: a write there after migration shows a warning that names the file and time.
6. **Our suites.** Both Vitest and the `node:test` suites (`test:unit`, `test:package`) load
   one setup that scrubs `CEZ_*` and `HSQ_*`, pins `HOME`, `XDG_*` and `HSQ_HOME`
   to a sandbox, and writes a `test` marker. A lint rule refuses test code that writes
   through a home path it did not get from `Home.sandbox`.
7. **Limits.** Agents keep an operator's own `XDG_*` values, because OpenCode and Cursor read
   them; so a process in a task can still derive the default live paths, as any process of
   that user can. What stops a test is not hiding paths but four layers together: a test
   setup that pins `HOME`, `XDG_*` and the home variables (ours, item 6); the marker check in
   every `HomeStore` writer; a name that old and foreign copies do not resolve; and rotating
   backups plus the canary for a direct file write that bypasses all of them.

## 4. Migration for existing installs

One code path, `migrateLegacyHome()`, runs at the first boot of the new build and as
`hsq migrate [--dry-run]`.

1. Resolve the legacy home: `CEZ_HOME` when set, else `~/.cezar`. First run the loader's own recovery
   (`loadWorkspaceConfig` restores `config.json` from `config.json.bak`, ADR 0010) and count
   `config.json.bak` and `backups/` as registry data. Only a legacy home that does not exist,
   or holds no registry file, backup or account file after that recovery, has nothing to
   migrate. With no legacy home, read-only and invalid commands write nothing.
   Only writer entries with valid arguments (serve, init, run, backup restore, or the
   first authorized registry write) record the fresh decision and write a `live` marker
   in the new home. A deferred first write that finds a legacy server install refuses
   and names `hsq server-migrate`. Never create the absent legacy directory to publish `MOVED.json`. An
   existing empty legacy directory gets a committed marker (an empty inventory) and
   `MOVED.json`, so a later legacy write reaches the canary and is never copied over
   the fresh home. Before a split marker exists, `hsq backup list` reads legacy
   backups without migration or writes. Every later lock and marker of this migration lives in the resolved legacy
   home.
2. Take `<legacy>/.migrating` with `O_EXCL`; a second migration waits or stops. Then take
   the legacy `write.lock`, which drains any writer already in its critical section, and hold
   it until step 7 ends. Every `HomeStore` writer checks `.migrating` inside its own
   `write.lock` section, after it acquires the lock, and refuses to write the legacy home when
   the file exists. A cockpit refuses to start on a home with `.migrating`. Then make sure no
   cockpit still serves the legacy home: every instance that shares it (on a server, every
   instance in `server.json` and `server-instances/` with the same home) is stopped, and the
   migration aborts, removing `.migrating`, when a live presence lease remains. It names the
   cockpit that holds it.
3. If the new config dir has `install.json` with `migratedFrom` and state `committed`, do
   nothing (idempotent).
4. Write a full backup: `<state>/backups/legacy-cezar-home-<UTC>.tar.gz` (without `versions/`,
   caches and `tmp/`).
5. Record the hash and mtime of every legacy file, then copy, never move, each file into the
   new layout (temp file, fsync, rename), including `backups/`. Parse and hash each copy and
   compare.
6. Older binaries do not know `write.lock` or `.migrating`, so they can still write the legacy
   files. Before committing, re-read every recorded hash: a changed file is copied again,
   and the check repeats (at most three times, then the migration aborts and says which
   binary to stop). After commit, the canary (section 3 item 5) watches the same hashes; a
   later change shows a banner with an "import changes from the old home" action that merges
   the changed file through `HomeStore`, after a backup.
7. Agent accounts whose `configDir` is inside the legacy home are copied to
   `<data>/accounts/<id>/` and their `configDir` is rewritten, so a stray writer of the legacy
   home cannot change a live account's files. An account in use by a running session is
   copied at the next start with no session. Accounts outside the legacy home keep their path.
8. Write the `live` marker with `migratedFrom` and state `committed`, then
   `<legacy>/MOVED.json` with the new paths. Leave the rest of the legacy home as it is. The
   window-end cleanup never deletes it; it prints what still uses it.

**Managed install** (`versions/`, `bin/`, the launchers and the PATH line): copied to
`<data>/versions` and `<data>/bin`, launchers rewritten, PATH line updated; the old
`~/.cezar/bin` launchers keep working. A copy works offline and can roll back.
`application-updates/` goes to the state root.

After commit, a watcher on the migrated legacy files reports a later change as a
`legacy-change` row in the recovery banner with **Import changes from the old home** and
**Ignore**.

**`CEZ_HOME` set to a non-default dir** (containers, custom hosts): treat it as
`HSQ_HOME` one-root, migrate in place into `config/`, `state/`, and so on. `CEZ_HOME`
stays an accepted home variable after P5, unlike the other `CEZ_*` names: `resolveHome` uses
`HSQ_HOME`, then `CEZ_HOME`, then the default, and a boot warning asks the operator to
rename it. So every custom install, container or not, keeps its own home with no pointer
file. A test covers a restart after P5 with only `CEZ_HOME` set. A committed home records its
source (`migratedFrom`); a later boot uses that source even when the env names another
legacy home, so a launch with only `HSQ_HOME` neither fails nor migrates again.

**Server installs** (apptension-host serves 12 projects): `hsq server-migrate` first stops
every instance that shares the legacy home, migrates that home once, then for each instance in
`server.json` and `server-instances/`: install
`hearsay-squawk[-<slug>].service` and the nginx site on the same port, start, check health.
A macOS (`macosx-ngrok`) server install is a server-migrate install too: the stop is
`launchctl bootout` of each recorded label, the move writes and bootstraps the
`tools.hearsay.squawk.*` plist and keeps the old plist as `*.plist.migrated`, and the health
check reloads each agent, then waits for the cockpit on its loopback port and, when the install
owns the tunnel agent, for a tunnel in the ngrok local API (about 30 s; each probe is time-bounded).
A rollback restores the old plist and leaves the old label unloaded until the home has rolled back,
so the restarted cockpit reads the legacy home. Only owned agents move, stop or start, as section 2
says.
The instances that share a home form one group and succeed or fail together. Until every
instance passes its health check, the new marker stays in state `pending` and `HomeStore`
refuses every write, so the cockpits serve read-only and no write can be lost by a rollback. If any instance
in the group fails its health check, every instance in the group stops, the old units and old
sites (on macOS the old launchd plists and labels) come back, and the new home's marker is renamed to `install.json.failed` so the next run
migrates again from the untouched legacy home. A rollback is an attempt: an instance whose old
unit, site or plist cannot be restored stays stopped, the rollback journal stays and the marker
is not renamed, so the operator fixes the reported error and re-runs `hsq server-migrate`; a
restored service that fails its start check is a warning. Old unit files stay as `*.migrated` after
success. When the install owns its nginx site, `/etc/cezar/htpasswd[-<slug>]` is copied to
`/etc/hearsay-squawk/` (the old file stays). The new site is the old site file copied as is (TLS listeners,
certificates, redirects and operator edits kept) with only its name and the
`auth_basic_user_file` path changed, so a credential rotated in the new file takes effect and
the old file no longer authenticates. For an install that owns its site, the health check goes through
its public URL (HTTPS when the site has TLS), not only the loopback port, before the group
commits. An `--external-proxy` install keeps the installer's existing check at its bind
address, since its public route belongs to the operator. An `--external-proxy`
install has neither; the migration leaves the operator's proxy untouched and moves only the
unit. Units and sites of an install made before the switch keep working with
`server-uninstall` and `server-deploy`, which act on the recorded names.
A boot or ordinary command of the new build does not run `migrateLegacyHome()` for a legacy
home that records an installed server supported by group migration (an `installed` record
without `dryRun`, whose strategy supports migrate, rollback, stop and start) while the new
home is not committed: it keeps the legacy home and prints one notice to run
`hsq server-migrate`, so the home moves only with the group's stop, `pending` stage and
rollback. `hsq server-migrate --dry-run` prints the stop, every move, each health check, the
group, the pending marker and the rollback, and writes nothing, not even to the legacy home.

**Desktop installs**: the bundled server runs the same migration at boot. A Mac that records a
completed `macosx-ngrok` server install is not a desktop install: its launchd labels move only
through `hsq server-migrate`, as in section 2 and under "Server installs".
A first boot that cannot write the legacy home or the new home (`EROFS`, `EACCES`, `EPERM`)
logs one line and serves the legacy home, or the migrated home when the commit already
happened, instead of failing (zero config).

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
plus one per day for 30 days. `hsq backup list` and `hsq backup restore <file>
[--at <time>]` restore one. When a write shrinks a non-empty registry to zero projects or
zero accounts, the cockpit shows a banner with a one-click restore of the newest backup.
`config.json.bak` (ADR 0010) becomes the newest entry of this set.

A test or stray process can also write a live file directly, past `HomeStore`. So
`HomeStore` keeps a version log per file beside the file's own dir (`<config>/.versions/<file>/`
for config files, `<state>/.versions/<file>/` for state files, so processes that share the
file share its log): every version it wrote, by content hash, plus a `HEAD` record that names
the committed version; "absent" is a valid `HEAD` for a file that does not exist yet, and the
first write creates file and log through the same steps. Reads and writes both run under
`write.lock`, so a read never sees a new `HEAD` with an old file. One write:

1. Re-read the live file. If its hash is not `HEAD`, an outside write happened since the last
   read: stop and flag it (below) instead of overwriting it.
2. Store the new version under its hash and record it as `PENDING`; fsync both.
3. Atomically replace the live file.
4. Set `HEAD` to the new hash and clear `PENDING`; fsync.

A read compares the live file with `HEAD`. A match is `HomeStore`'s own. A match with
`PENDING` means a crash between steps 3 and 4: the read finishes step 4. Anything else, an
older stored version included, is an outside write. A crash before step 3 leaves the old file,
which still matches `HEAD`.

On an outside write the cockpit keeps the file as found, pins the `HEAD` version as the
restore target, and blocks every `HomeStore` write to that file until the user chooses in a
banner: restore the pinned version, or accept the file as found (stored as a new version and
made `HEAD`). Blocking keeps a later merge from folding the outside content into the restore
target.

The banner (owner decisions, 2026-11-07) sits below the cockpit header on every page, one
row per affected file. Reset rows offer Restore and Accept as found (accept keeps the empty
registry or account list). Remote sessions see read-only rows ("Only the host operator can
restore or accept this file"). A `config.json` that was deleted outside cezar is restored
automatically when the next save starts from the pinned restore target; an edited file still
blocks. Blocking ships with the banner (P1c), not before it, so no intermediate `main`
blocks saves without a way to resolve them.

The migration (section 4 step 5) stores each copied file as a version and sets `HEAD`
before the new home goes live. The first build with `HomeStore` does the same on its first
boot for each file of an existing home that has no `HEAD`, so an upgrade is never flagged.

Limit: outside writers do not take `write.lock`. A write that lands between step 1 and step 3
of one `HomeStore` write is replaced without a flag; the window is one atomic rename long,
and the overwritten content is the outside write itself, not user data.

Every version, rotating backup, migration copy and migration archive holds the same data as
the live files, webhook tokens included. They are created private: `0600` files in `0700`
directories on Unix, and an ACL that grants only the current user on Windows.

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
code constant, `REBRAND_SWITCH` in `packages/cezar/src/home/switch.ts` (not an env var; no
setting). Tests run both states. One **switch PR** turns it on; that PR and the stable
release are the single user-visible change.

| Phase | Slices (one PR each unless noted) | Visible before the switch? |
| --- | --- | --- |
| **P0 Safety** | (a) `buildChildEnv`, check steps (`workflows/run/step-loop.ts:508`, full `process.env` today) and the draft-PR `git push` never pass `CEZ_HOME` (or any later home variable); In-task commands that read the home today (`cez artifact publish` reads the registry at `artifacts/cli.ts:45` to build its link) get what they need from the task context or the cockpit API instead, so a host with a custom home keeps working. (`CEZ_HOME` reached agents only through the blanket `CEZ_*` allowance added in `fedab0ed1`, not by design.) (b) The guard compares against `os.userInfo().homedir` (passwd, not `$HOME`), runs for every env object, and covers `node:test`; `test:unit` and `test:package` load the sandbox setup. (c) Rotating backups for `config.json` and `agent-accounts.json`, and `cez backup list` and `cez backup restore`. (d) Issue to `apptension/toolkit-dev`: audit-agent-readiness probes run foreign suites with a scrubbed env and a temp `HOME`. | Only the new `cez backup` command |
| **P1 Home object** | (a-1) `Home` type and `resolveHome` (legacy layout while the switch is off), passed down from entry points; `cezarHomeDir()` stays as a thin shim. (a-2) Remove the shim; tests use `Home.sandbox`; lint for `homedir()` and `cezarHomeDir()`. (b) `HomeStore` writer with `install.json` marker (written into the legacy home too), test-runner refusal and lease. (c) Backups and restore command for every registry-type file; shrink banner. (d) Lint: test code writes only through `Home.sandbox`. ADR superseding the "literal `~/.cezar`" rule. | Only the reset banner, which appears after a reset |
| **P2 Layout and migration** | (a-1) XDG / macOS / Windows / `HSQ_HOME` resolver, `Home` kind roots, Windows private-file ACL. (a-2) HomeStore, backups, version log and recovery routed by kind root. (b-1) `migrateLegacyHome` with backup, `pending`/`committed` marker, managed-install copy, `MOVED.json`; it carries `~/.cezar/backups/` into `<state>/backups/`. (b-2) Legacy-home canary with Import and Ignore. (c) `server-migrate` for systemd units and nginx sites, as a group with rollback. (d) launchd label move through `PlatformStrategy.migrate`. All behind the switch. | No |
| **P3 Name surfaces** | (a) One env helper: `HSQ_*` first, `CEZ_*` fallback (additive). (b) `hsq` bin added beside `cezarion` and `cez` (additive). (c) Package `@hearsay-tools/squawk` prepared; publish waits for the switch. The unscoped `hsq` alias was dropped after npm refused the name (A1). (d) Desktop and mobile new IDs and the bridge build, behind the switch. (e) Docs and display names, merged with the switch PR. | Additive names only |
| **P4 Project dir** | Dual read of `.ai/cezar/` and `.ai/squawk/` (additive). With `REBRAND_SWITCH` true the cockpit moves each registered legacy project by itself at start, after journal recovery, when no other writer uses it (no other cockpit, family another live process claims, or automation lease of this cockpit) and its plan has no blocker or conflict: the boot project before the listener, every other registered project right after the listener starts (or earlier, when a request reaches it first), and a project registered later when it is added. An older binary therefore stops seeing the earlier tasks of every project a cockpit start moved. A task that can still resume at the move (owner decision A, 2026-11-11: a live task, or any task not archived, since a human can Continue a finished one) does not stop it: the store and every item no kept task owns move, while the task's own items (`worktrees/<id>`, `runs/<id>…`, `t/<id8>`, `tmp/<id>`, `preview/<id>`) stay in `.ai/cezar/` with their stored paths unrewritten, listed in `.ai/squawk/legacy-runs.json`; every per-run path helper resolves a listed task's items there and the fallback write guard exempts them; each later start moves the items of the tasks archived or deleted since and removes the directories that leaves empty. A project another writer uses, or whose plan has a blocker or conflict, stays in place: the cockpit serves it from both folders, logs what blocks the move and retries at the next start. `hsq migrate-project`, registered exactly when `REBRAND_SWITCH` is true and run only by the user with the cockpit stopped, migrates offline the same way (hearsay-tools/cezarion#3089): it refuses while a cockpit it can see serves the project (the `cockpit.lock` owner, or a live cockpit of the user's homes whose registry lists it) or another live process claims a task of it, and names what to stop; every other task that is not archived keeps its own items in place as above. It cannot see a cockpit of another home that lists the project but never opened it: the user stops that cockpit, and while the fence holds the write backstop refuses its store and listed state writes. The automatic move has the same limit. It then takes the ownership lock and an exclusive project fence, so no cockpit of a binary that knows the fence can start on the project and no other process of such a binary is admitted meanwhile. A cockpit never migrates a project while it serves it: its automatic move runs before it serves the project. Every CLI operation that touches project data checks the fence, directly or through the cockpit's routes. It first writes a journal (`.ai/squawk-migration.json` beside both dirs) that lists every step and every path rewrite: move the dir, `git worktree repair`, rewrite the owned-workspace receipt files under `gitCommonDir(repoRoot)/cezar-owned-workspaces` (`delegation/workspace.ts`; in a linked worktree `.git` is a file), then one run-store transaction for each run's `worktreePath`, `delegation.workspace.path`, cleanup checkpoints, artifact and handoff paths. Each step is idempotent and marks itself done in the journal. Any later cockpit start or first open, CLI entry or `migrate-project` that finds an unfinished journal resumes it before it reads the project. A crash between steps can leave receipts, worktrees and the database on different paths; until recovery finishes, admission refuses the project to every cockpit and CLI operation of a binary that knows the journal, so none of them reads that state before the paths agree again. A dry run completes and reports any unfinished migration first, then lists the remaining rewrites; planning the remaining migration changes nothing. Tracked files under `.ai/cezar/` (workflows, skills, `context.yaml`) are not moved by the command: it prints the `git mv` for the user to commit. The command and the automatic move follow the release switch. An older binary opens `.ai/cezar` directly: on a moved project it sees no earlier task and starts a new run store there, while the moved runs stay intact under `.ai/squawk/` and the newer binary reads both names, so mixed versions during the window hide moved tasks from the older binary but lose no data. `.ai/cezar` stays a real directory for that reason. An older binary checks neither the fence nor the journal, so the user keeps older binaries off the project while a migration runs or a journal is unfinished. The switch turns on only after the write root follows moved state (hearsay-tools/cezarion#3150). The move's last step writes the marker `<git common dir>/cezar-moved-projects/<sha256 of the real root>.json`, which no commit can ship; with the switch on, `projectPaths(root)` then makes `.ai/squawk/` the write root and `.ai/cezar/` the fallback, every writer asks it, an unmoved or busy project keeps writing `.ai/cezar/` until it moves, and a second move of a marked project is a no-op once no task keeps items in `.ai/cezar/` (hearsay-tools/cezarion#3150). | No: the command and the automatic move follow the switch; the dual read is additive |
| **Switch** | Turn `REBRAND_SWITCH` on; deprecation notices start; docs land. Then owner actions: stable release, npm publish and deprecate, repo rename, store listings, apptension-host server migration. | Yes: the release |
| **P5 Window end** | Remove aliases and `CEZ_*` fallbacks (except `CEZ_HOME`, section 4), two minor releases or 60 days after the release. | Yes |

Dependencies: P1(a-1) before every other P1 slice and P2; P0(c) before P1(b) and P1(c) (same writers); P1(b) before P1(c) and P1(d); P0(b) before P1(d); P0(c) before P2(b); P1(a-2) before P1(b) (they share the test files); every P1 slice before P2(a-2); P2(a-1) before P2(a-2) before P2(b-1) and P2(d); P2(b-1) before P2(b-2); P2(b-1) and P2(d) before P2(c); P1(b) before P2(b). P0 and P3(a–b) do not depend on P1 and run in parallel with it.
The switch needs P0 to P4 accepted on `main`, including the per-project write root that follows moved state (hearsay-tools/cezarion#3150); P5 follows the release.

Every slice follows `BACKWARD_COMPATIBILITY.md` and updates `.env.example`, the README env table and the area docs it touches.

### Switch fix: first project use

With the switch on, no `.ai/cezar` path means a fresh project. Path reads select
`.ai/squawk/` without writing when it is absent or a real directory. Project preparation and the first CLI write mark the
project in the Git common directory, so a later legacy path does not change its write
root. An existing empty directory, tracked-only directory, symlink or unreadable path
keeps the existing migration rules. With the switch off, all writes remain legacy.
A blocked automatic move prints one switch-aware notice, and the offline cockpit
refusal also lists live tasks from the read-only task view.

| Case | Write root / result |
| --- | --- |
| Switch off, any marker or legacy path | `.ai/cezar/` |
| Switch on, no legacy path, destination absent or real directory | `.ai/squawk/`, marker before ordinary writes |
| Switch on, no legacy path, destination is a symlink or file | `.ai/cezar/`, no fresh marker |
| Switch on, existing unmarked legacy path | Existing P4 migration checks |
| Switch on, marked project, legacy path later appears | `.ai/squawk/`, legacy fallback |
| Cockpit and task live during offline migration | First refusal names both |
| Cockpit known, live-task read fails | Refusal names cockpit and read failure; nothing moves |

Fresh project writes also require an absent or real `.ai/squawk` directory. A
symlink or file keeps legacy writes and is never marked fresh. The destination
check is shared with migration planning. If a cockpit is known but its live tasks
cannot be read, migration still refuses and lists both the cockpit and the read
failure. It does not treat the failed read as an empty task list.

### Switch fix: stored checkout under a removed project root

Continue and restart recovery keep the shipped missing-checkout fallback when a
repository was moved or copied and its recorded old root no longer exists. This
does not make an existing migrated project's legacy state writable.

| Switch | Recorded root | Recorded checkout | Continue / recovery |
| --- | --- | --- | --- |
| Off | Removed | Missing legacy checkout | Use current repository, as shipped |
| On | Removed | Missing legacy checkout | Use current repository |
| On | Existing, migrated | Missing or existing legacy checkout | Refuse read-only fallback writes |
| Either | Existing | Existing writable checkout | Keep normal continuation |

The fallback guard checks the root's directory entry. An unreadable or dangling
entry still counts as present and keeps the existing guard. Registered projects
whose own current root was deleted retain their separate admission refusal.

### Known limits at the switch

- The one-time automatic move of a project that the cockpit prepares after the listener starts
  runs synchronous file and Git work on the event loop. In CI (`transcript-facts-responsiveness`,
  head 06169742d of hearsay-tools/cezarion#3240) the move of a project with an empty run store
  blocked health requests for 568 ms, 542 ms of it waiting on synchronous I/O; on a local disk the
  same move blocked 20–27 ms. The boot project moves before the listener, so this applies to
  other registered projects and to projects added later. The move stays synchronous in the
  switch release; the timing check seeds its fixture where a switch-on cockpit reads it, so it
  measures the cold history open, not the move.
