# GitHub paged lists: first-page benchmark (hearsay-tools/cezarion#1183)

The script is below (`.ai/qa/` is ignored except its Markdown, so it lives here). Each run is a fresh `tsx` process
that imports `fetchGithub` from source and reads `hearsay-tools/cezarion` (81 open issues, 6 open
PRs on 2026-10-17). `gh` auth is warm; the server-side list cache is cold.

- `ms`: the first call in the process. It also resolves the repository handle (one more `gh`
  round trip), which a running server does once and keeps.
- `warmMs`: a second call in the same process with `refresh=true`. It skips the list cache but
  keeps the handle, which is the steady-state cost of opening the tab or pressing Refresh.

`main` is `origin/main` at `2c98e7bd1` and asks for `limit=1000`, as its cockpit did. This branch
asks for one 50-row page per side, with exact totals.

| Tree | Cold best | Cold median | Warm best | Warm median |
| --- | --- | --- | --- | --- |
| main (`limit=1000`) | 1362 ms | 1703 ms | 1022 ms | 1145 ms |
| branch (`limit=50`, totals) | 1088 ms | 1196 ms | 707 ms | 782 ms |

Raw runs (load average 4.5 to 5.4, `uptime` before and after):

```
main   {"ms":1792,"warmMs":1098,"issues":81,"prs":6,"issuesTotal":null,"prsTotal":null}
branch {"ms":1196,"warmMs":901,"issues":50,"prs":6,"issuesTotal":81,"prsTotal":6}
main   {"ms":1815,"warmMs":1022,"issues":81,"prs":6,"issuesTotal":null,"prsTotal":null}
branch {"ms":1222,"warmMs":707,"issues":50,"prs":6,"issuesTotal":81,"prsTotal":6}
main   {"ms":1401,"warmMs":1345,"issues":81,"prs":6,"issuesTotal":null,"prsTotal":null}
branch {"ms":1093,"warmMs":819,"issues":50,"prs":6,"issuesTotal":81,"prsTotal":6}
main   {"ms":1362,"warmMs":1229,"issues":81,"prs":6,"issuesTotal":null,"prsTotal":null}
branch {"ms":1088,"warmMs":782,"issues":50,"prs":6,"issuesTotal":81,"prsTotal":6}
main   {"ms":1703,"warmMs":1145,"issues":81,"prs":6,"issuesTotal":null,"prsTotal":null}
branch {"ms":1201,"warmMs":734,"issues":50,"prs":6,"issuesTotal":81,"prsTotal":6}
```

Reading it:

- With the handle known, the branch's first page plus totals lands under 1 s (median 782 ms); one
  `gh api graphql` round trip alone takes about 300 ms on this host.
- The first read after a cold start stays above 1 s (median 1196 ms), because it also resolves
  the repository handle. That cost is unchanged from `main` and outside this change.
- This repository is small: `main` fetches all 87 rows here. Its cost grows with the open count up
  to its 1,000-row cap, while the branch's first page stays at 50 rows per side.

## Script

`bench.ts`:

```ts
// hearsay-tools/cezarion#1183 benchmark: one cold `fetchGithub` per process (no server cache,
// warm `gh` auth). Usage: tsx bench.ts <source checkout> <limit> <repoRoot>
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const [source, limitArg, repoRoot] = process.argv.slice(2)
if (!source || !limitArg || !repoRoot) throw new Error('usage: bench.ts <source> <limit> <repoRoot>')
const mod = await import(pathToFileURL(resolve(source, 'packages/cezar/src/server/forge/github.ts')).href)
const started = performance.now()
const data = await mod.fetchGithub(resolve(repoRoot), false, Number(limitArg))
const ms = Math.round(performance.now() - started)
// A running server has already resolved the repository handle; `refresh` skips the list cache
// but keeps that handle, which is the steady-state cost of a list read.
const again = performance.now()
await mod.fetchGithub(resolve(repoRoot), true, Number(limitArg))
const warmMs = Math.round(performance.now() - again)
console.log(JSON.stringify({
  ms, warmMs, available: data.available, reason: data.reason, issues: data.issues?.length, prs: data.prs?.length,
  issuesTotal: data.issuesTotal ?? null, prsTotal: data.prsTotal ?? null,
}))
process.exit(0)
```

`bench.sh` (five fresh processes per tree; `wt-main` is a detached `git worktree` at `origin/main` with this checkout's `node_modules` linked in):

```sh
#!/bin/sh
# Five fresh processes per tree; prints one JSON line per run.
cd "$(dirname "$0")/../../.."
ROOT=$(pwd)
TSX=$ROOT/node_modules/.bin/tsx
uptime
for i in 1 2 3 4 5; do
  printf 'main   '; $TSX .ai/qa/1183/bench.ts .ai/qa/1183/wt-main 1000 "$ROOT"
  printf 'branch '; $TSX .ai/qa/1183/bench.ts "$ROOT" 50 "$ROOT"
done
uptime
```
