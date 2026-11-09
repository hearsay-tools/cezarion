# npm package release paths

Part of hearsay-tools/cezarion#2973 and the accepted
[rebrand spec](2026-11-06-rebrand-and-home-layout.md), P3(c).

Coordinator decisions D16 and D17 (2026-11-08) split this work into three sequential
units. Each unit finishes independent review and lands before the next starts:

1. A: release identities, the new alias, dry runs, CI packing, version-bump staging
   and trusted PR publication/cleanup.
2. B: installed-copy update discovery, staging, restart, recovery and rollback.
3. C: release-only compatibility artifacts and the owner publication runbook.

A and B are partial deliveries. C closes the issue. No unit changes
`REBRAND_SWITCH` or publishes a package.

## Publication and source identities

Source workspace names stay unchanged, including the service. Existing build
scripts and type imports continue to address the source service name. Release
stamping changes source versions and dependency versions only. The selected alias
depends on the published service name.

One pure `publicationManifests` function projects the active service identity from
`productIdentity`. Stable, dev, nightly and PR packing use it. Trusted PR archive
validation uses the same function against trusted source. When a package name
changes, packing and publication use a disposable copy; neither success nor
failure changes the source name. Switch off returns the original manifest set.

## Preserved cases

| Case | Switch off | Switch on |
| --- | --- | --- |
| Stable package pair | Current scoped package and alias | New scoped package and alias |
| Stable alias pin | Caret version | Caret version |
| Dev/nightly/PR alias pin | Exact version | Exact version |
| Tags | latest / dev / nightly / pr-N | Same tags |
| Source workspace names | Unchanged | Unchanged |
| Service pack directory | Current source directory | Disposable publication copy |
| Alias directory | Legacy alias directory | New alias directory |
| PR archives | cezar.tgz and alias.tgz | Add legacyScoped.tgz and legacyAlias.tgz |
| Bump staging | Workspace manifests, legacy alias, lock | Workspace manifests, new alias, lock |
| Cleanup | Current service, client and alias | New service, same client, new alias and both forwarding names |
| Failed publication | Source name and bytes preserved | Source name and bytes preserved; copy removed |
| Dry run | npm publish --dry-run; no tag/deprecation calls | Same |

Compatibility artifacts are unit C. Their approved layout is a release-only
temporary pack tree, outside the workspaces, with exact new-package pins and old
bins targeting `dist/index.js`. The new dispatcher owns the sole stderr notice.


## Installed update paths (unit B)

Decision D25 preserves the outer npm package and launch path for global and npx
updates and rollbacks. An old alias or scoped install keeps reinstalling that
name. The compatibility releases in unit C forward old names to the new runtime;
B does not migrate identities or recovery records. This preserves service launch
paths and pending update records.

| Case | Switch off | Switch on |
| --- | --- | --- |
| Legacy global and npx layouts | Current discovery and outer package | Same |
| New global and npx layouts | Unsupported, no npm mutation | Discover matching direct, nested and hoisted layouts |
| New managed registry install | Legacy scoped package | Active scoped package |
| Managed version reads | Legacy scoped package only | Active scoped package first, legacy fallback |
| Local source pack or linked checkout | Source workspace identity | Same |
| Published new local pack | Rejected | Accepted with its manifest identity |
| Registry discovery | Current package argument | Active scoped package |
| Pending legacy update record | Existing schema and directory | Same, no rewrite |
| Restart and failed-promotion rollback | Original outer name and launch path | Same for both identities |
| Generated managed launcher | Frozen legacy bytes | Active package with legacy fallback; refresh before activation |
| Server npx cache ownership | All four exact launch names (P3b) | Same |

Tests stub registry reads and npm, or use local npm executables. No test accesses
the registry. Desktop, web and mobile code stays outside this unit.


Managed activation refreshes launchers before selecting a new tree with the
switch on. Cockpit apply and CLI update, use and link share that guard. Install
refreshes before packing or installing too: a local reinstall can replace the
already active version directory. CLI install and update do not write launchers
again after activation with the switch on. A failed refresh keeps `current`
unchanged and prevents local replacement. With the switch off, the existing
activation and launcher-write order stays unchanged; both versions use the
legacy runtime path, so the existing launcher remains usable.


Each managed launcher is replaced atomically in both switch states: write a unique
sibling temporary file, set its final mode, close it, then rename it over the
command. A write or rename failure removes that temporary file and keeps the old
command intact. POSIX files keep mode 0755; Windows files keep their existing mode
or the normal creation mode under the process umask. A locked Windows `.cmd` that
rejects rename with EPERM or EBUSY stops the update before switch-on activation;
there is no write-in-place fallback. Generated bytes and switch-off activation
order stay unchanged.


## Compatibility releases (unit C, planner X4)

With the switch on, every stable, dev, nightly and PR release also publishes the
old scoped name and old alias at the same version. Each forwarding manifest pins
the new scoped runtime to that exact version, including stable releases. Publish
the new scoped runtime and alias before either forwarding package. The last old
pair is published at window end: two minor releases or 60 days, whichever is
later. Then deprecate the old names. Never unpublish.

A single exact-pinned terminal wrapper at rename would freeze old installs. A
range alone cannot fix this: unit B reinstalls `outerPackage@targetVersion`, so
that old-name version must exist. Matching exact-pinned releases preserve D25's
outer name, launch path and reproducible rollback without changing record schema.

Both forwarding trees exist only in a disposable release directory. Old bins
point to `dist/index.js`; `hsq` points to `dist/hsq.js`. Both import the public new
package entry without printing. The dispatcher owns the single stderr notice.
Real built web assets keep the frozen v0.17.0 update validator working. Switch off
creates no forwarding trees or targets and retains the frozen release snapshots.

Application updates discover the new runtime under an old outer shim only with
the switch on. Only canonical nested or hoisted npm paths and matching exact
pins are supported. A hoisted global runtime uses the existing fixed
`recovery-package` slot. Recovery checks its identity and version before it
removes any installation path. Npx recovery retains its whole-root copy and lock.
No installed identity, pending-record schema or state-directory hash is migrated.
