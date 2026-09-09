# GitHub-hosted and Blacksmith CI comparison

Status: complete. The optimized-balance and release-verification campaigns support Blacksmith for verification jobs. Publishing stays on GitHub-hosted infrastructure.

## Scope and method

This experiment compares the real CI workflow on GitHub's `ubuntu-latest` runner with Blacksmith's `blacksmith-4vcpu-ubuntu-2404` runner. It also tests the three-weight shard-balance candidate described in [the experiment README](../../.github/benchmarks/blacksmith/README.md). The application baseline is `252b749d464a8f630f7446a6ff29e6f8fa076b10`; provider refs differ only where their workflow runner labels must differ. PR #154 itself is unchanged.

The driver dispatches three matched provider pairs through `ci.yml`, reversing dispatch order on the middle repetition. Each pair completes before the next starts. A manual dispatch exercises the normal three parallel verification jobs and the aggregate required check. Snapshot publication is ineligible and skipped. The measurements retain normal `actions/setup-node` npm caching and the production four-worker shard arguments.

Both CI campaigns requested the production `lts/*` policy, but the providers resolved different toolchains: GitHub used Node 24.20.0 with npm 11.19.0, while Blacksmith used Node 24.13.0 with npm 11.6.2. Both exposed four CPUs. This deliberately reproduces the workflow's default policy; it measures a provider environment change, not an isolated hardware-only speedup. Pinning a runtime now would depart from the exact job being evaluated. CPU models, runner images and first-run cache state also vary and are disclosed below.

Verification wall time is measured from workflow creation through completion of the stable `Unit, build, E2E, and package` aggregate, so it includes queueing, setup and dependency gaps. Workflow wall time extends through the end of the run. Runner seconds sum all non-skipped job durations and therefore describe consumption rather than latency. Medians and ranges include successful runs only; every failure remains listed separately.

The separate release-verification campaign runs three repetitions per provider against the same fixed application. It mirrors `release.yml`'s `Verify before release` commands exactly: `npm ci`, `npm run typecheck`, `npm run test:unit`, bare `npm test` with its default worker count, and `npm run build`. It uses Node `lts/*` and setup-node's normal npm cache. The benchmark workflow has read-only permissions and contains no release, publish, environment or OIDC step. Its job also has an extra harness checkout and result upload that the production release job does not have.

## Campaign references

| Phase | Provider source | Workflow SHA | Runs |
| --- | --- | --- | --- |
| Current layout | GitHub | `252b749d464a8f630f7446a6ff29e6f8fa076b10` | [34283875256](https://github.com/hearsay-tools/cezarion/actions/runs/34283875256), [34284246694](https://github.com/hearsay-tools/cezarion/actions/runs/34284246694), [34284613076](https://github.com/hearsay-tools/cezarion/actions/runs/34284613076) |
| Current layout | Blacksmith | `7635f690aea3dbe45e884f20437fd013cdee6bb9` | [34283884328](https://github.com/hearsay-tools/cezarion/actions/runs/34283884328), [34284238300](https://github.com/hearsay-tools/cezarion/actions/runs/34284238300), [34284621718](https://github.com/hearsay-tools/cezarion/actions/runs/34284621718) |
| Optimized balance | GitHub | `9b09ddf1b86b5f9d89a245c5a32b3408e7c74bfe` | [34284949016](https://github.com/hearsay-tools/cezarion/actions/runs/34284949016), [34285274607](https://github.com/hearsay-tools/cezarion/actions/runs/34285274607), [34285624789](https://github.com/hearsay-tools/cezarion/actions/runs/34285624789) |
| Optimized balance | Blacksmith | `7d785e0f3564a899f8925addf23b2077b0092653` | [34284958086](https://github.com/hearsay-tools/cezarion/actions/runs/34284958086), [34285266359](https://github.com/hearsay-tools/cezarion/actions/runs/34285266359), [34285633124](https://github.com/hearsay-tools/cezarion/actions/runs/34285633124) |
| Release verification | Both providers | `deaee0e87c78fb3f3b47891d78d2e5c16f7d1681` | [34286016241](https://github.com/hearsay-tools/cezarion/actions/runs/34286016241) |

## Current-layout control

| Provider | S/F | Verification wall | Workflow wall | Runner seconds |
| --- | ---: | ---: | ---: | ---: |
| GitHub | 2/1 | 207.5 `[202–213]` | 208 `[203–213]` | 430 `[420–440]` |
| Blacksmith | 2/1 | 200 `[188–212]` | 201 `[189–213]` | 368 `[351–385]` |

Blacksmith's successful workflow-wall median is seven seconds, or 3.4%, below GitHub's. Both ranges overlap, and each provider failed one of three repetitions. This is too small and noisy to select a runner. The Blacksmith runs consumed fewer aggregate runner seconds, but billing and price are outside this timing-only comparison.

Every run collected the complete 376-file, 7,803-case inventory: shard 1 held 187 files and 3,539 cases; shard 2 held 189 files and 4,264 cases. The two failures were:

- GitHub repetition 1: `github.test.tsx > the follow-up prompt template menu (#413) > inserting a second template stacks it below the first, separated by a blank line`.
- Blacksmith repetition 1: `owned-input-delivery.test.ts > opencode transport acceptance remains delivered when the accepted turn subsequently reports a provider failure`.

Both failures are retained and excluded from successful medians. Their presence further limits any conclusion from the small current-layout difference.

The setup-node logs show a provider-specific first-run cache condition. All three GitHub repetitions restored the exact npm cache key. Blacksmith repetition 1 reported `npm cache is not found` in all three verification jobs; one job saved the key and the two concurrent saves lost the reservation race. Blacksmith repetitions 2 and 3 then restored that exact key in every verification job. This is normal setup-node cache behavior, but it makes the first pair a cold-Blacksmith/warm-GitHub comparison rather than a cache-matched pair. Successful medians above use repetitions 2 and 3 for both providers and are cache-matched.

## Optimized-balance comparison

The candidate changes only three duration weights but deterministically redistributes 339 files, producing two 188-file shards. All six candidate workflows passed and each retained all 7,803 cases: 4,121 on shard 1 and 3,682 on shard 2.

| Provider | S/F | Verification wall | Workflow wall | Runner seconds |
| --- | ---: | ---: | ---: | ---: |
| GitHub | 3/0 | 207 `[186–214]` | 208 `[187–215]` | 436 `[416–444]` |
| Blacksmith | 3/0 | 177 `[151–186]` | 178 `[153–187]` | 323 `[308–347]` |

The combined Blacksmith-plus-three-weight configuration is selected for CI. Blacksmith beat GitHub in every candidate pair by 9, 55 and 28 seconds; its 178-second workflow-wall median is 30 seconds, or 14.4%, below GitHub's 208 seconds. All six runs passed the complete inventory. The three weights alone have no demonstrated benefit on GitHub: its median remained exactly 208 seconds compared with the current layout, and runner consumption rose from 430 to 436 seconds. The manifest is retained as part of the tested combined configuration, without attributing the measured provider gain to those weights independently.

GitHub restored the exact npm cache key in all three candidate repetitions. Blacksmith repetition 1 was cold in all three verification jobs; repetitions 2 and 3 restored the exact key. The cold Blacksmith repetition nevertheless completed in 178 seconds. The cache-matched Blacksmith repetitions spanned 153–187 seconds, showing material runner variation even within one provider.

The individual successful Vitest job durations show that the new weights improve balance more consistently on Blacksmith. Current GitHub repetitions 2 and 3 were `197/160` and `189/184` seconds, while candidate repetitions were `164/176`, `197/176` and `203/175`; the median absolute shard gap was 21 seconds for both layouts. Current Blacksmith's successful repetitions were `175/157` and `168/134`, for a 26-second median gap. Its candidate repetitions were `136/154`, `130/122` and `122/154`, reducing the median gap to 18 seconds. These job durations include setup around Vitest and do not isolate the weight change from host variation.

## Release verification

| Provider | S/F | Commands excluding install | Install | Vitest | CPU | Peak RSS | Runner | Queue + runner |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GitHub | 2/1 | 415.15 `[411.12–419.18]` | 7.43 `[7.37–7.48]` | 386.43 `[382.57–390.29]` | 948.63 `[931.81–965.44]` | 1,417,726 `[1,409,668–1,425,784]` | 435.5 `[432–439]` | 438 `[435–441]` |
| Blacksmith | 2/1 | 318.26 `[317.65–318.86]` | 5.39 `[4.94–5.83]` | 295.95 `[294.49–297.40]` | 603.44 `[600.86–606.01]` | 1,357,438 `[1,317,652–1,397,224]` | 340 `[339–341]` | 354.5 `[354–355]` |

Times are seconds except RSS, which is KiB. “Commands excluding install” is the sum of typecheck, unit, Vitest and build; install is shown separately. RSS is the largest child-process high-water mark, not simultaneous aggregate memory. Blacksmith's successful queue-inclusive median was 83.5 seconds, or 19.1%, below GitHub's; it won both directly comparable successful repetitions. Measured post-install command time improved 23.3%, Vitest 23.4%, runner time 21.9%, and child CPU consumption 36.4%. Peak child RSS was 4.3% lower.

The queue-inclusive release metric starts when the common harness-validation matrix gate completes and ends when the provider job completes. It therefore includes provider scheduling plus the whole benchmark job, including its extra application/harness checkout and artifact upload. It does not start at workflow creation and is not the wall time of an actual release workflow. The entire concurrent benchmark workflow took 451 seconds from creation because its critical path was a GitHub job; subtracting the common approximately ten-second matrix gate produces the reported provider comparisons.

All six jobs exposed four available CPUs. Installed Vitest therefore resolved its bare-command default to three workers. GitHub used Node 24.20.0, npm 11.19.0, AMD EPYC 9V74 and 7763 hosts, and runner images `20260907.300.1` and `20260831.293.1`. Blacksmith used Node 24.13.0, npm 11.6.2, Intel Xeon and AMD EPYC hosts, and image `20260121153938`. Although both jobs requested the same `lts/*` policy, this is an actual-policy comparison rather than a version-matched hardware comparison. The runtime and heterogeneous CPU differences limit attribution to the runner service alone.

All three GitHub jobs restored the exact setup-node npm cache key. All three simultaneously started Blacksmith jobs reported `npm cache is not found`; one saved the cache and the other successful job lost the save reservation race. Blacksmith's advantage therefore did not depend on a warmer npm cache in this campaign. Queue delay was 2–3 seconds for GitHub and 14–15 seconds for Blacksmith, and is included in the last table column.

Two failures are retained and excluded from successful medians:

- GitHub repetition 2: `harness parity — owned input run tier > opencode R9 continuation asks keep input queued through delayed native reply acknowledgement`; 7,802 of 7,803 tests passed.
- Blacksmith repetition 2: `harness parity — seam tier > opencode S7 surfaces a provider failure as an error on both streams`; 7,802 of 7,803 tests passed.

Neither scenario is changed by the runner-label candidate. Repetition 1 and repetition 3 passed on both providers, preserving a matched successful comparison while keeping the failures visible.

## Decision

Use `blacksmith-4vcpu-ubuntu-2404` for the three CI verification jobs and `release.yml`'s read-only `Verify before release` job. Keep the aggregate CI gate and every snapshot/publish job on `ubuntu-latest`; npm trusted publishing and provenance require GitHub-hosted infrastructure. The CI runner and weight selection was committed at `a4a372ac`; the release label was measured and selected separately for the final PR diff. Local verification passed all gates: 376 Vitest files and 7,803 cases, 37 workspace tests, 81 GitHub script tests and 24 package tests. The 20 Python benchmark tests also passed. The hosted failures above remain part of the record. This report establishes the measured runner decision and local correctness, not final PR acceptance or a successful npm publication.

Raw run objects, job metadata, workflow logs and collector artifacts are archived under `docs/benchmarks/blacksmith/raw/`: `ci-current.tar.gz`, `ci-candidate.tar.gz` and `release-34286016241.tar.gz`. The release archive includes all six artifact directories plus `jobs.json`, `run.json`, `aggregate.json` and the complete workflow log used for cache observations.
