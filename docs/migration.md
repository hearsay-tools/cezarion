# Move from Cezarion to Squawk

Squawk uses the `hsq` command and the npm package `@hearsay-tools/squawk`.
This guide describes the release with `REBRAND_SWITCH` enabled. It does not
instruct you to change that internal switch. Release operators must follow the
[publishing runbook](publishing.md).

## Install and command names

```sh
npm i -g @hearsay-tools/squawk
hsq --help
# Or run without a global install:
npx hsq
```

The unscoped `hsq` package is an alias for the scoped package. During the
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

Project state stays in `.ai/cezar/`. This release does not move `runs.db`, run
logs, worktrees, workflows or project skills to `.ai/squawk/`. Keep those paths
in scripts and do not rename the directory by hand.

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

After success, use `HSQ_HOME=/srv/squawk-home` for future launches. If source and
destination differ, keep `CEZ_HOME` set to the old source and set `HSQ_HOME` to
the new destination during migration. Setting only the destination does not
identify a custom legacy source. A `CEZ_HOME` equal to the default `~/.cezar`
does not override the platform split layout.

Update a container's persistent volume mounts to cover all resolved roots, or
mount the one custom root. Run migration as the service user with the same
mounts. Do not set either home variable in agent setup scripts: the cockpit
removes both from child environments.

## Installed servers

Use the server command for installs recorded by `server-install`. It coordinates
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
launchd agents and destination files are left alone or cause a refusal.
Deploy and uninstall continue to use recorded names for old installs.

If any instance fails, the whole group rolls back. Old services and sites come
back, and the target marker becomes `install.json.failed`. Boot keeps serving
the legacy home and warns to retry `hsq server-migrate`. Fix the reported cause
and repeat the command. After success, old units remain as `*.migrated` and
owned macOS plists have private `*.plist.migrated` rollback backups.

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
group migration restores the old services as described above. An interrupted
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
removal in the cleanup release. `CEZ_HOME` keeps its permanent fallback. Do not
assume that the window ending renames `.ai/cezar/`; project migration is a
separate, opt-in step. Keep the old home until account deferrals and recovery
notices are resolved.
