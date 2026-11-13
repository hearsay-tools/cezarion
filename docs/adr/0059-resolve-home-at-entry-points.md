# Resolve cockpit paths once at entry points

Accepted for hearsay-tools/cezarion#2809, P1a-1 of the
[home layout spec](../../.ai/specs/2026-11-06-rebrand-and-home-layout.md).
This record supersedes the literal `~/.cezar`, no-XDG rule formerly in `paths.ts`
and the workspace-registry rule that every path must call `cezarHomeDir()` and
never derive `homedir()` elsewhere. The new layout itself remains deferred to P2a.

## Decision

`home/resolve.ts` resolves a `Home` object without filesystem access. CLI dispatch
resolves it lazily once for operator commands. Server updater consumers reuse the injected
object. Library APIs require that object or a path derived from it. Task commands (`artifact`, `message`,
`worker`, `task`, `automation`, `webhook`, `discover`) receive no `Home` and do not
invoke the factory. The selected object passes through migrations, managed update
services, checkout discovery, managed restart, application update boot, backup listing
and preview lookup/download.

`Home` names individual paths. Kind roots alone cannot describe the legacy layout:
registry, install and backups use
`CEZ_HOME || join(homedir(), '.cezar')`, while skills and browser caches use
`join(homedir(), '.cache', 'cez')` and ignore `CEZ_HOME`. Server state and install
locks keep their default and named-instance paths. The launcher keeps runtime expressions
separate from resolved directories: the default POSIX launcher evaluates
`"${CEZ_HOME:-$HOME/.cezar}"` when it runs. Windows keeps its baked entry path.
Home carries only path data and the original override. Shell rendering stays in the
launcher; its historical POSIX quote spelling is preserved byte for byte.

`HOME_LOCATING_ENV` lists only cockpit home locators (`CEZ_HOME`, `HSQ_HOME`).
Both are stripped case-insensitively from every child environment, even with
full-env or explicit passthrough. Platform layout values use the separate
`HOME_LAYOUT_ENV` list in `home/kind-roots.ts`; agents retain those values.
`homedir()` supplies the platform home independently of the supplied environment.
Legacy resolution still reads only `HOME_LOCATING_ENV`. Empty `CEZ_HOME` falls
back; nonempty legacy values, including relative paths and whitespace, stay literal.

P2a-1 added split paths behind a release constant, `REBRAND_SWITCH`. The rebrand
release (v0.18.0) turned it on and hearsay-tools/squawk#3450 removed it: split is the
default layout. `resolveHome({ purpose, env?, layout?, platform? })` supports explicit
layout and platform selection for tests and for reading the legacy home. Resolution stays
pure. Windows resolution uses `path.win32`, including when tested on another OS.

## Transition

P1a-2 (hearsay-tools/cezarion#2810) removes the `cezarHomeDir` shim and every
compatibility default. CLI entry and operator subcommand dispatch resolve a Home
once, then pass it through stores, runtime contexts, skills, installers, managed
updates, remote settings and preview paths. Task subcommands still receive none.
The process scripts listed in `docs/sdlc/lint.md` resolve once at their existing
environment boundary. The source lint rule allows resolution only in `home/`,
`index.ts` and `subcommands.ts`; OS-user readers have a shrink-only reasoned list.

P2a-1 (hearsay-tools/cezarion#2931) gives `Home` five kind roots: `config`,
`state`, `data`, `cache`, `runtime`. `root` aliases `config`; install markers and
cockpit leases stay there. Named config paths use config; UI state, server state
and install locks and backups use state; versions and bin
use data; skills use cache. Runtime has no named file yet.
Legacy kinds equal root except cache, which stays `~/.cache/cez`. New root metadata is non-enumerable so the P1
literal path table keeps the same enumerable shape.

Split defaults follow the platform table in the spec. Relative Linux XDG values
are ignored. macOS uses `/tmp/hearsay-squawk` when TMPDIR is absent. Nonempty
`HSQ_HOME` selects one-root subdirectories, then nonempty custom `CEZ_HOME` does;
`CEZ_HOME` equal to the normalized legacy default counts as unset (Windows
compares paths without case). CLI boot warns
once about a set `CEZ_HOME` when split layout is enabled. Split managed launchers
use the resolved data root; legacy launcher text stays byte for byte.

Tests select `Home.sandbox(dir, { layout? })`, defaulting to the release gate.
Legacy sandboxes retain their old shape. Split sandboxes use `config/`, `state/`,
`data/`, `cache/`, `run/`, with a test marker under config. The script-only setup
scrubs both prefixes and pins both locators, APPDATA and LOCALAPPDATA as well as
XDG values. The passwd-home write guard rejects native split default roots too.
Windows private directories replace the DACL with one inheritable current-user
full-control rule under the split gate. A successful grant on an existing canonical
directory is cached once per process with its device and inode identity; an
external replacement or unreadable identity gets a fresh grant.
New files inherit that ACL, so atomic replacement starts no ACL subprocess.
Unix private modes stay unchanged.
The sandbox factory and passwd-home guard share `nativePathPlatform`, derived
from Node's native path separator and OS type. A mocked `process.platform` cannot
send real filesystem probes through another platform's path formulas.

P2a-2 (hearsay-tools/cezarion#2932) routes HomeStore through the shared
`home/file-location.ts` map. The marker and cockpit leases stay in config.
Per-file short locks and version logs use the file's config or state root.
Recovery lists live files and deleted-file journals across both roots and keeps
HomeFile keys unchanged. See the [registry rules](../areas/workspace-registry.md#split-home-roots-staged).

With an injected Home, backups of both kinds use `Home.backups` in state.
The legacy path-only backup helper still derives its write directory from the
file being replaced. An explicit backup-list root still selects that root's
`backups/` directory. Historical nested named-instance snapshots remain readable
in the legacy layout.

## Evidence

`home/resolve.test.ts` pins literal legacy outputs for the default home and an
explicit env-object override. Launcher fixtures were generated from the old
implementation and compare both generated formats byte for byte.
`home/entry-points.test.ts` checks dispatch isolation and propagation through boot
services and migrations. `home/write-isolation.test.ts` checks that injected-home
restore and migration writes leave a different ambient home untouched.
`home/discovery-isolation.test.ts` keeps discovery, id collision checks and apply
on the injected Home when another home holds a same-id checkout. Restart and preview
lookup tests keep using the injected entry and cache after environment changes. Existing path, write-guard and task-home-read suites keep
their expectations.
