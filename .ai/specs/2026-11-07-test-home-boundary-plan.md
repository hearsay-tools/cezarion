# Test home boundary — P1d

Implements hearsay-tools/cezarion#2813 from its approved issue body, following
ADR 0059 and ADR 0060. Baseline: `1002d9954738f911187a568bfade357bf75c662d`,
after P1b (hearsay-tools/cezarion#2898). Product home paths and the release switch
stay unchanged. P1c owns backups, outside-write enforcement and banners.

## Decisions

The coordinator approved test-source scope and operational-tool exclusions on
2026-11-07. The new rule covers `*.test.ts`, `*.test.tsx`, `*.testkit.ts`,
`*.test.mjs` and `*.test.cjs` across the repository. `docs/sdlc/lint.md` records
each excluded tool and its reason. Benchmarks, transcript measurement and mutation
tools keep their explicit environments and legacy cache paths. Runtime skill
discovery, browser launch discovery, Squeal discovery and the registry refusal
guard keep their read-only homedir calls.

One script-only setup scrubs inherited CEZ flags, selects a marked test home and
pins user and XDG paths. It imports no product module. The server selector stays
a type-only callback bridge, so product mocks still load first. Browser workers
keep host HOME and USERPROFILE for installed browser discovery. Their CEZ_HOME
and XDG paths stay private. The existing shared OMP native cache is selected
before XDG pins, preserving its lifetime outside any worker sandbox.

The coordinator approved replacing only the old XDG_CONFIG_HOME and
XDG_DATA_HOME `undefined` assertions with exact sandbox paths. The named guarantee
is stronger: host config, data, state, cache and runtime directories never reach a
test. Other test outcomes stay unchanged.

## Behavior cases

| Input or event | Required result | Evidence |
| --- | --- | --- |
| Test writes `join(cezarHomeDir(), 'config.json')` | Lint fails | Scanner fixture and real oxlint plugin fixture; baseline accepts, changed plugin refuses |
| Ambient home flows through a local alias or function | Write fails lint | Alias, callback, promise and local-function fixtures |
| Rename uses ambient home as source or destination | Lint fails for either path | Scanner fixtures |
| Explicit sandbox write or read-only ambient lookup | Lint passes | Scanner fixtures |
| Test selects CEZ_HOME directly outside server package | Lint fails | External repository scanner fixture |
| Worker inherits CEZ and XDG overrides | Overrides disappear before test import; test marker exists | Real server/web worker and node preload tests |
| Browser worker inherits host HOME | HOME/USERPROFILE stay; other home paths use its marked sandbox | Browser preload test and browser shard |
| File beforeAll selects a Home or a feature flag | Per-test repair preserves that selection/flag | Existing task-env tests and shared setup test |
| A test drops its selected home | Per-test repair restores the marked sandbox | Shared setup test and existing task-env tests |
| Worker needs OMP native modules | Link targets the existing cache outside sandbox cleanup | Existing task-env regression test |

## Baseline reference audit

The issue's line numbers were remeasured on the baseline. Node preloads were at
`squeal.config.json:237,245`; the task-env dependency was at `:198-200`.
The packaged test preload stayed at `scripts/test-package.mjs:96`.
The benchmark workspace selection was at `benchmark-workspace-events.ts:76`;
transcript measurement stayed at `measure-transcript-facts-health.mjs:16`;
the mutation cache was at `.github/scripts/mutants-file.cjs:311`.
The browser launch reader stayed at `browser-launch.ts:9`; Squeal discovery
stayed at `scripts/test-parity.mjs:40,118`; runtime skill discovery stayed at
`pi-project-skills.mjs:19`. These remain outside the test-source rule.
