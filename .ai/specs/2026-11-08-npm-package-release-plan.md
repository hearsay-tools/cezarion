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
| PR archives | cezar.tgz and alias.tgz | Same artifact filenames |
| Bump staging | Workspace manifests, legacy alias, lock | Workspace manifests, new alias, lock |
| Cleanup | Current service, client and alias | New service, same client and new alias |
| Failed publication | Source name and bytes preserved | Source name and bytes preserved; copy removed |
| Dry run | npm publish --dry-run; no tag/deprecation calls | Same |

Compatibility artifacts are unit C. Their approved layout is a release-only
temporary pack tree, outside the workspaces, with exact new-package pins and old
bins targeting `dist/index.js`. The new dispatcher owns the sole stderr notice.
