# Resolve cockpit paths once at entry points

Accepted for hearsay-tools/cezarion#2809, P1a-1 of the
[home layout spec](../../.ai/specs/2026-11-06-rebrand-and-home-layout.md).
This record supersedes the literal `~/.cezar`, no-XDG rule formerly in `paths.ts`
and the workspace-registry rule that every path must call `cezarHomeDir()` and
never derive `homedir()` elsewhere. The new layout itself remains deferred to P2a.

## Decision

`home/resolve.ts` resolves a `Home` object without filesystem access. CLI dispatch
resolves it lazily once for operator commands. Server updater consumers reuse the injected
object, or resolve one when called directly. Task commands (`artifact`, `message`,
`worker`, `task`, `automation`, `webhook`, `discover`) receive no `Home` and do not
invoke the factory. The selected object passes through migrations, managed update
services, checkout discovery, managed restart, application update boot, backup listing
and preview lookup/download.

`Home` names individual paths. Kind roots alone cannot describe the legacy layout:
registry, install, dry cache, dry prefix, backups and application updates use
`CEZ_HOME || join(homedir(), '.cezar')`, while skills and browser caches use
`join(homedir(), '.cache', 'cez')` and ignore `CEZ_HOME`. Server state and install
locks keep their default and named-instance paths. The launcher keeps runtime expressions
separate from resolved directories: the default POSIX launcher evaluates
`"${CEZ_HOME:-$HOME/.cezar}"` when it runs. Windows keeps its baked entry path.
Home carries only path data and the original override. Shell rendering stays in the
launcher; its historical POSIX quote spelling is preserved byte for byte.

`HOME_LOCATING_ENV` remains the only list of home-locating variables. The resolver
reads only those names from its supplied environment. `homedir()` continues to
supply the legacy platform home independently of that object. Empty `CEZ_HOME`
falls back; nonempty values, including relative paths and whitespace, remain literal.
The write guard `assertCezarHomeWriteIsSandboxed(path, env?)` is unchanged.

`home/switch.ts` declares `REBRAND_SWITCH = false`. This slice adds no alternative
layout and no visible behavior change. Turning the constant on does not select an
unfinished XDG layout. P2a will add that layout behind this release gate.

## Transition

The one-function `cezarHomeDir(env?)` shim delegates to `resolveHome` and returns
its legacy root. Existing callers and test expectations remain valid. Optional
`Home` parameters retain the existing env-object and explicit-path APIs while
entry points pass their resolved object. Other ambient readers remain on the shim;
P1a-2 (hearsay-tools/cezarion#2810) migrates them and removes it. The PR inventories
those callers. P1a-2a threads the same object through runtime config, accounts,
model policy, workflow launch and Continue, delegation, planner/namer calls,
webhooks, provider runtime auth, discovery, the semaphore and lazy project contexts.
The runtime APIs still accept an omitted Home during this transition; P1a-2b
removes that fallback with the remaining skills, installer and remote readers.
HomeStore, install markers, test migration and the desktop Rust home are separate
slices.

Backups still derive their write directory from the file being replaced. An
explicit backup-list root still selects that root's `backups/` directory. Home
injection adds the named backup path without changing either rule.

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
