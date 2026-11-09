# Additive project-directory reads

Implementation plan for hearsay-tools/cezarion#3086. The approved issue is the
scope. The release switch does not gate reads. P5 changes writes later.

`project-paths.ts` separates ordered read roots from the legacy write root.
Singleton files use whole-file presence precedence, even when the first file is
damaged. Catalogs use names; runs use IDs. A run's sidecars follow its record,
including when a duplicate sidecar is absent in the winning directory.

The coordinator approved per-family copy-on-write on 2026-11-09. Only an explicit
family write may preserve its fallback records and sidecars into the legacy
directory, inside the existing transaction and ownership checks. Boot and reads
do not copy fallback state or create an empty legacy database. Neither tree is
moved or symlinked. The fallback tree stays read only.

The planner chose no tombstones. Automatic retention and worktree cleanup skip
fallback-only items and log one count per sweep. An explicit destructive operation
refuses with the fallback path and asks the user to use the binary that migrated
the project. This preserves the source bytes and prevents deleted runs returning
from fallback on the next read.

| Case | Read | Write / cleanup |
| --- | --- | --- |
| Neither tree | Existing defaults | Explicit writes use legacy |
| Legacy only | Existing behavior, including import and recovery | Existing behavior |
| Fallback only | Read-only source, no shadow database | Explicit family writes preserve source data into legacy |
| Both, duplicate ID/name | Legacy item and its own sidecars | Legacy |
| Both, disjoint IDs/names | Union | Legacy |
| Damaged legacy singleton/store | Existing failure/default contract; no fallback substitution | Refuse unsafe replacement |
| Live foreign fallback claim | Readable; ownership stays foreign | Refuse |
| Dead fallback live family | Readable; no boot recovery write | Explicit adoption uses normal ownership checks |
| Automatic fallback cleanup | Retain bytes and evidence | Skip; one count per sweep |
| Explicit fallback deletion | Retain bytes and evidence | Refuse; name source path and required binary |
| Release switch off | Dual reads | No migration or deprecation notice |
| Release switch on | Same dual reads and precedence | Legacy notice; writes remain legacy until P5 |

Existing legacy-only tests keep their expectations. The skill-directory drift
guard gains `.ai/squawk/skills` immediately after `.ai/cezar/skills` and the browser
fixture catalog gains both fallback catalogs. This replaces the old closed list
with the approved additive discovery guarantee.
