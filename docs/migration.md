# Move from Cezarion to Squawk

Squawk uses the `hsq` command and the npm package `@hearsay-tools/squawk`.
This guide describes the rebrand release (v0.18.0) and later. Release operators
must follow the [publishing runbook](publishing.md).

## Release notes

What changes in the Squawk release:

- **Command.** The CLI is `hsq`. The old `cez` and `cezarion` commands still work
  during the deprecation window. Each process started through an old name prints
  one notice to stderr; JSON on stdout stays valid.
- **Package.** The npm package is `@hearsay-tools/squawk`, with the unscoped alias
  `hsq`. During the window, `@wjarka/cezarion` and `cezarion` releases forward to
  the same version of the new package.
- **Environment.** Settings use `HSQ_*` names. A `CEZ_*` name still works as a
  fallback, and boot prints one warning that lists the old names that are set
  (names only, never values). `CEZ_HOME` stays supported after the window.
- **Home.** At its first start, the new build moves the home from `~/.cezar`
  (or `CEZ_HOME`) to the platform layout (XDG on Linux, `~/Library` on macOS,
  `%APPDATA%` and `%LOCALAPPDATA%` on Windows). It first saves a full backup
  archive. Registry and account files then get rotating backups. A recovery
  banner shows a reset or an outside write. The old home stays in place as a
  canary: a later write there shows a banner row that can import it.
- **Projects.** The cockpit moves each registered project's `.ai/cezar/` state to
  `.ai/squawk/` at start, when the project is idle. A busy project stays in place,
  is served from both folders and moves at a later start. `hsq migrate-project`
  moves a project offline. Tracked files under `.ai/cezar/` (workflows, skills,
  `context.yaml`) are not moved: the move prints the `git mv` commands for you to
  commit. A new project starts in `.ai/squawk/`.
- **Servers.** An install made with `server-install` (Ubuntu or macOS + ngrok)
  does not migrate at boot. It keeps the old home until you run
  `hsq server-migrate`.
- **Desktop and mobile.** The apps get new IDs. A bridge build of the old desktop
  app installs the new app and hands over its state. The mobile app is a new
  store listing.
- **Older binaries.** An older build opens `.ai/cezar/` directly. It does not see
  the tasks of a project that a newer cockpit moved, but no data is lost.

The deprecation window is two minor releases or 60 days, whichever is later
([details](#rollback-and-the-deprecation-window)). After it, the old command
names and the `CEZ_*` fallbacks go, except `CEZ_HOME`. Boot still logs any
`CEZ_*` name that is set, so no setting is lost silently.

### Release steps for the owner

The rebrand release PR merges first. Then the owner:

1. before the stable release, runs `hsq server-migrate --dry-run` on a Mac that
   has a `macosx-ngrok` server install and checks the plan (the macOS path is
   checked by unit tests with a fake `launchctl` only, not on a real Mac);
2. publishes the stable release;
3. publishes `@hearsay-tools/squawk` and `hsq`, then the exact-pinned forwarding
   releases `@wjarka/cezarion` and `cezarion` of the same version
   ([publishing runbook](publishing.md#owner-runbook-for-the-npm-rename));
4. renames the repository to `hearsay-tools/squawk`;
5. publishes the desktop and mobile store listings for the new IDs;
6. runs `hsq server-migrate` on each server install that `server-install`
   recorded (Ubuntu and macOS + ngrok);
7. after the first start of the new build on each host, checks that the new
   home's marker is live. On Linux with the default home:

   ```sh
   node -e 'console.log(JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.config/hearsay-squawk/install.json","utf8")).kind)'
   ```

   It must print `live`. On other platforms read `<config>/install.json`. The
   old home's `install.json` is not repaired: after the migration the old home
   is only the canary.

## Install and command names

```sh
npm i -g @hearsay-tools/squawk
hsq --help
# Or run without a global install:
npx -p @hearsay-tools/squawk hsq
```

There is no unscoped `hsq` package: npm refuses that name. Install or run the
scoped package; its command is `hsq`. The old packages `@wjarka/cezarion` and
`cezarion` still publish every version, each pinned exactly to
`@hearsay-tools/squawk` at the same version. During the
deprecation window, `cez` and `cezarion` still work. Each process started through
an old name prints one notice to stderr. JSON stdout stays valid. Change scripts
to use `hsq`; do not parse the notice as command output.

## Home directories

Squawk finds these directories without a config file. In this documentation,
`<config>`, `<state>`, `<data>`, `<cache>` and `<runtime>` mean the resolved roots
in this table. They are path placeholders, not shell variables.

| Root | Contents | Linux default | macOS default | Windows default |
| --- | --- | --- | --- | --- |
| config | Registry and settings, accounts, remote grants, tracker connections, install marker | `~/.config/hearsay-squawk` | `~/Library/Application Support/Hearsay Squawk/config` | `%APPDATA%\Hearsay Squawk` |
| state | UI state, server records, backups, update recovery, desktop window and connection state | `~/.local/state/hearsay-squawk` | `~/Library/Application Support/Hearsay Squawk/state` | `%LOCALAPPDATA%\Hearsay Squawk\state` |
| data | Managed versions and launchers, copied account directories, desktop browser profiles on Linux/Windows | `~/.local/share/hearsay-squawk` | `~/Library/Application Support/Hearsay Squawk/data` | `%LOCALAPPDATA%\Hearsay Squawk\data` |
| cache | Team skills, dry-run caches | `~/.cache/hearsay-squawk` | `~/Library/Caches/Hearsay Squawk` | `%LOCALAPPDATA%\Hearsay Squawk\cache` |
| runtime | Sockets and temporary runtime files | `$XDG_RUNTIME_DIR/hearsay-squawk`, else `<state>/run` | `$TMPDIR/hearsay-squawk`, else `/tmp/hearsay-squawk` | `%LOCALAPPDATA%\Hearsay Squawk\run` |

Linux honors absolute `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME` and
`XDG_CACHE_HOME` overrides. Windows honors `APPDATA` and `LOCALAPPDATA`.
Cockpit leases stay under `<config>/.locks/cockpits/`. Short write locks and
version logs use each file's config or state root.

The old source is `CEZ_HOME` when set, else `~/.cezar`. The migration copies
recognized files to the new roots. It leaves the source in place and writes
`MOVED.json` there. It saves a full archive under
`<state>/backups/legacy-cezar-home-<UTC>.tar.gz`; managed versions, launchers,
caches and temporary files are excluded from that archive. Managed versions
are copied separately and launchers are rewritten. Unknown files stay in the
old home. Read the plan for deferred or excluded account directories.

Project state moves separately; see [project folders](#project-folders).

## Project folders

Each project keeps its state in `.ai/squawk/` (runs, logs, worktrees, artifacts).
A project that has no `.ai/cezar` path starts there. For a project that has one,
the cockpit moves the state at start, before any task resumes, when no other
writer uses the project: no other cockpit, headless run or automation lease.
When one is live, the project stays in place, the cockpit serves it from both
folders, logs what blocks the move and tries again at the next start.

A task that is not archived does not stop the move, live or not: running,
parked on you, waiting on a pull request, a timer or a worker, a worker whose
cleanup did not finish, or done, in review, failed or cancelled (you can still
Continue it). The run store and everything else move; the task's own files stay
in `.ai/cezar/` at the paths its agent knows: its worktree, its handoff file and
other `runs/<id>…` files, and its scratch directories. New tasks write only to
`.ai/squawk/`. A later start moves the files of each such task after you archive
or delete it, and removes the folders under `.ai/cezar/` that this leaves empty.
A finished move logs the `git mv` commands for tracked files and says "N task(s)
keep their files in .ai/cezar/ until they are archived: <ids>".

To move a project yourself, stop its cockpit and run:

```sh
hsq migrate-project --dry-run
hsq migrate-project
```

The command refuses while a cockpit serves the project or another process (a
headless run) holds one of its tasks, and names what to stop. A task that is not
archived keeps its own files in `.ai/cezar/`, as at a cockpit start; run the command
again after you archive the task to move them. It never moves tracked files under `.ai/cezar/` (workflows, skills,
`context.yaml`): it prints the `git mv` commands, and you commit them. Until you
do, the project reads those files from `.ai/cezar/`. Do not rename the directory
by hand, and keep older binaries off a project while it moves. An older binary
opens `.ai/cezar/` directly and does not see the tasks of a moved project.

## Inspect and migrate a local install

Quit every cockpit and desktop app that uses the old home. Finish active agent
sessions before moving their account directories. Run these commands as the
same OS user that owns the installation:

```sh
hsq migrate --dry-run
hsq migrate
```

The dry run prints the shared migration plan and changes no migration files.
Check the source, all target roots, the backup path, files and account
deferrals. The real migration takes a claim and the legacy write lock. It
refuses a live cockpit lease and names the holder. It copies and verifies data
before committing the new marker. Repeating a committed migration is safe.
Normal local and desktop boot use this same migration path.

An account directory inside the old home is copied to `<data>/accounts/<id>`
when it is not in use. Accounts outside the old home keep their paths.
In-use accounts are deferred until a later safe boot. OMP profile roots inside
the old home are reported as not moved; do not delete their source. No cleanup
at the end of the window deletes the old home automatically.

If migration reports an outside write or reset in the old home, inspect the
recovery information before choosing one of these actions:

```sh
hsq migrate --resolve-legacy config.json restore
# Or keep the current legacy bytes after reviewing them:
hsq migrate --resolve-legacy config.json accept
hsq migrate
```

`restore` uses the pinned recovery version and keeps normal backups. `accept`
keeps the found bytes. These actions do not migrate, cannot be combined with
`--dry-run`, and are safe to repeat after resolution. Stop any old process that
keeps writing before retrying migration.

After migration, a later change in the old home shows a recovery banner. Use
**Import changes from the old home** to merge the change after a backup, or
**Ignore** to keep the current file. Host CLI equivalents are
`hsq backup import <file>` and `hsq backup ignore <file>`. Deleted legacy files
allow Ignore only. Remote-settings grants can be changed only by the host CLI.

## Custom homes and containers

`HSQ_HOME` (`CEZ_HOME` fallback) selects one root with `config/`, `state/`,
`data/`, `cache/` and `run/` beneath it. With only a non-default `CEZ_HOME`, the
new release migrates into these subdirectories inside that same root. The
`CEZ_HOME` fallback remains supported after the deprecation window.

To keep a custom install in `/srv/squawk-home`, retain its old source selector
while checking the plan. Set both names to the same root during the move:

```sh
CEZ_HOME=/srv/squawk-home HSQ_HOME=/srv/squawk-home hsq migrate --dry-run
CEZ_HOME=/srv/squawk-home HSQ_HOME=/srv/squawk-home hsq migrate
```

After success, use `HSQ_HOME=/srv/squawk-home` for future launches. The migrated
home records its source, so a launch without `CEZ_HOME` keeps the same home and
the same old-home canary; keeping `CEZ_HOME` set also works. If source and
destination differ, keep `CEZ_HOME` set to the old source and set `HSQ_HOME` to
the new destination during migration. Setting only the destination does not
identify a custom legacy source. A `CEZ_HOME` equal to the default `~/.cezar`
does not override the platform split layout.

Update a container's persistent volume mounts to cover all resolved roots, or
mount the one custom root. Run migration as the service user with the same
mounts. Do not set either home variable in agent setup scripts: the cockpit
removes both from child environments.

## Installed servers

Use the server command for installs recorded by `server-install`, on Ubuntu and
on macOS + ngrok. It coordinates
all instances that share a home. Do not replace it with separate local migrations.
Run it on the server as its normal service user:

```sh
hsq server-migrate --dry-run
hsq server-migrate
```

The plan lists units, sites, files and environment lines. The command stops the
group, stages the home once, installs replacement services on the same ports,
and checks every instance before commit. Staged cockpits are read-only. The
installer prints privileged commands and uses its normal sudo-or-paste flow.

| Old artifact | New artifact |
| --- | --- |
| `cezar[-<slug>].service` | `hearsay-squawk[-<slug>].service` |
| nginx site `cezar[-<slug>]` | `hearsay-squawk[-<slug>]` |
| `/etc/cezar/htpasswd[-<slug>]` | `/etc/hearsay-squawk/htpasswd[-<slug>]` |
| `ai.cezar.cockpit`, `ai.cezar.ngrok` launchd labels | `tools.hearsay.squawk.cockpit`, `tools.hearsay.squawk.ngrok` |

Owned nginx sites retain TLS listeners, certificates, redirects and operator
edits; only the site name and password-file path change. The public URL must
pass its health check. External-proxy installs move only their service and
keep the bind-address check; the operator's proxy stays untouched. Foreign
destination files cause a refusal. Deploy and uninstall continue to use
recorded names for old installs.

If any instance fails, the whole group rolls back. Old services and sites come
back, and the target marker becomes `install.json.failed`. Boot keeps serving
the legacy home and warns to retry `hsq server-migrate`. Fix the reported cause
and repeat the command. A rollback is an attempt: when restoring an old unit,
site or plist fails, that instance stays stopped and the rollback journal stays,
so fix the reported error and run `hsq server-migrate` again to finish the
rollback. A restored service that fails its start check is reported as a
warning; check those services yourself. After success, old units remain as `*.migrated`.

On macOS + ngrok the command stops the owned launchd agents with
`launchctl bootout`, writes and bootstraps the `tools.hearsay.squawk.*` agents
and keeps each old plist as a private `*.plist.migrated`. The health check waits
for the cockpit on its loopback port, then for the ngrok tunnel (about 30 s). A
failure tries to restore the old plists and labels and rolls the home back, with
the same limits as above. Foreign
launchd agents stay untouched. The macOS path is checked by unit tests with a fake `launchctl` only, not on a real Mac.

See the [Ubuntu guide](server-install/ubuntu-vps.md) and
[macOS guide](server-install/macosx-ngrok.md) for platform details.

## Desktop and mobile

The desktop identity changes from `tools.hearsay.cezarion` to
`tools.hearsay.squawk`. The owner publishes a final bridge on the old feed.
For macOS apps, per-user Windows NSIS and Linux AppImage installs, it installs
the new app beside the old app, copies closed window state, connections and
persistent browser profiles, then waits for the new app to acknowledge startup
before removing the old app. Connection UUIDs and trusted origins stay the same.
On failure, the old app and source state remain usable. Close both apps before
retrying; a conflicting destination is never overwritten silently.

DEB and Arch installs receive a manual package-move notice. Use the same package
manager to install the new package and later remove the old one. These builds
do not transfer profiles or run a privileged updater. Keep the old app and its
state until you verify the new app. See [desktop setup](desktop.md) for details.

macOS asks again for permissions tied to the app ID, including notifications
and automation. Squawk has no app-managed Keychain or password store. macOS 14+
closed WebKit stores carry cookies and site storage through the bridge;
macOS 12–13 remote profiles remain temporary.

The mobile ID becomes `tools.hearsay.squawk.mobile`. The final old app links to
the new store listing. Install it, connect and sign in again. Mobile connection
and browser state are not copied. See [mobile setup](mobile.md).

## Rollback and the deprecation window

A failed pre-commit home migration leaves the old home intact. A failed server
group migration tries to restore the old services as described above. An interrupted
group is recovered from its journal on the next `hsq server-migrate` run. Keep
the reported backups and failed marker while diagnosing a failure.

There is no public `hsq migrate --rollback` command. For a deliberate rollback
after a successful migration, stop all new cockpits first. Run the previous
binary against the retained legacy home (`CEZ_HOME` for a custom source).
That home is the old snapshot; changes made only in the new home are not copied
back. Save and reconcile those changes before resuming work. Server operators
must also restore their retained units/sites and verify authentication and
health; do not run old and new services on the same ports. Desktop rollback
also needs the matching old app and its retained source state.

The deprecation window lasts **two minor releases or 60 days, whichever is
later**. During it, old command names and `CEZ_*` settings work with notices.
Ordinary settings prefer `HSQ_*`, including an explicitly empty value, then
fall back to `CEZ_*`. Boot lists old names that are still set, without values.
Hosted mode is an exception: `HSQ_REMOTE=1` or `CEZ_REMOTE=1` enables it.
Native sidecar controls have their own precedence; do not configure them.

After the window, old binaries and ordinary env fallbacks are scheduled for
removal in the cleanup release. `CEZ_HOME` keeps its permanent fallback. The
window ending does not rename `.ai/cezar/`: a project moves at an idle cockpit
start or with `hsq migrate-project`. Keep the old home until account deferrals
and recovery notices are resolved.
