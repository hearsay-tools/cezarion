# Blacksmith allocation calculation

Status: smallest-tier typecheck measured successfully. Final CI and review remain merge gates.

## Sample and method

Source: GitHub Actions API for `hearsay-tools/cezarion`, `ci.yml`, runs created
from 2026-10-20 00:00 UTC through 2026-10-26 23:59 UTC. The complete sample has
858 runs, 938 attempts and 18,490 unique jobs. It includes reruns, failures and
cancelled work. Skipped and never-started jobs contribute no execution time.
Four transient HTTP 502 reads were retried; the final collection has no missing
runs. A 30-day projection multiplies the seven-day totals by 30/7.

This is a workload estimate, not a Blacksmith invoice. The repository changed
its CI layout during the sample. Legacy floor shards remain in historical
totals but are not a candidate for a new allocation. Recent coverage and quality
jobs have shorter histories, so their observed weekly totals understate their
current run frequency. The stable build/package job gives a better estimate of
the frequency a separate mandatory typecheck would have.

## Allowance

[Blacksmith's runner FAQ](https://docs.blacksmith.sh/blacksmith-runners/overview#faq)
provides 3,000 x64 2-vCPU equivalent minutes per organization per month. A minute
on a 4-vCPU runner consumes two equivalent minutes; an 8-vCPU minute consumes
four. The smallest x64 Ubuntu 24.04 runner is
`blacksmith-2vcpu-ubuntu-2404`, with 2 vCPU and 8 GB RAM.

The allowance is shared across repositories. This session has no authenticated
Blacksmith billing view. Other organization usage and billing rounding are
unknown. Do not describe the estimate as a guaranteed zero bill.

## Candidate

Split `npm run typecheck` from the GitHub-hosted build/package job. Run the new
job on Blacksmith's 2-vCPU tier for PR and diagnostic-dispatch events. Keep
pushes and merge groups on GitHub. Keep unit tests, build, packaged CLI tests
and package verification on GitHub. Keep the minimum supported Node version
and its bounded setup retry.

| Sample | Executed build/package attempts | Projected attempts in 30 days |
| --- | ---: | ---: |
| PR events | 628 | 2,691.4 |
| Manual dispatches | 33 | 141.4 |
| Selected total | 661 | 2,832.9 |

One selected PR attempt stopped before typecheck. Among the other 627 PR
attempts, typecheck averaged 17.72 seconds. Their existing checkout, setup,
install, cleanup and typecheck steps averaged 35.34 seconds combined, with a
35-second median and 44-second 95th percentile. One exceeded 60 seconds.
For 33 manual-dispatch attempts, the combined mean was 36.09 seconds, with a
37-second median and 49-second maximum.

These GitHub timings are a sizing baseline. The hosted Blacksmith measurement
below supplies a second estimate; one run does not establish a monthly average.

| Accounting scenario | Selected new job | Existing release verification | Combined equivalent minutes |
| --- | ---: | ---: | ---: |
| GitHub-derived execution-time projection | 1,670.6 | 79.2 | 1,749.8 |
| Sensitivity: round each observed job up to a minute | 2,837.1 | 88.0 | 2,925.1 |

The rounding row is a conservative planning scenario, not a verified Blacksmith
billing rule. It remains below 3,000 for a 30-day month before other organization
usage. A 31-day month, growth, cold downloads and more retries can exceed that
amount. Existing release use comes from three jobs on the 8-vCPU tier over
2026-09-27 through 2026-10-26: 521, 364 and 303 seconds. No `ci-benchmark.yml`
runs appeared in that 30-day window. Ad hoc experiments consume allowance too.

## Hosted measurement

[Dispatch 40436779269](https://github.com/hearsay-tools/cezarion/actions/runs/40436779269),
[Typecheck job 121968595424](https://github.com/hearsay-tools/cezarion/actions/runs/40436779269/job/121968595424),
ran commit `5f6bc9e1d3494fa8e329b9231083bf0aea7e2eeb` on
`blacksmith-2vcpu-ubuntu-2404`. The job passed from 02:13:48 to 02:14:42 UTC
on 2026-10-27: 54 seconds. Checkout took 4 seconds, pnpm setup 3 seconds,
Node/cache setup 5 seconds, dependency installation 3 seconds, and the full
`npm run typecheck` 30 seconds. Remaining time includes runner setup and cleanup.

The same-head GitHub control's typecheck step in
[job 121968399298](https://github.com/hearsay-tools/cezarion/actions/runs/40436740535/job/121968399298)
took 22 seconds, Node setup 5 seconds and dependency installation 2 seconds.
Blacksmith did not improve typecheck execution speed in this pair. The control
uses a combined build/package job, so its whole-job duration is not comparable
to standalone typecheck. The new leaf runs alongside build/package rather than
adding a serial dependency. The change targets available capacity within the
allowance; it does not claim a workflow speedup.

Applying 54 seconds to the projected 2,832.9 monthly jobs gives 2,549.6 runtime
minutes. Adding the observed 79.2 equivalent release minutes gives **2,628.8**.
If every new job took 54 seconds and billing rounded each job up to one minute,
the estimate would be **2,920.9**, including 88 rounded release minutes. This
fits a 30-day allowance before other organization usage. Neither estimate is a
billing cap: the sample is short, runtime varies, and growth, retries, other
repositories or a 31-day month can exceed it. Keep push and merge-group
verification on GitHub and compare actual Blacksmith usage before adding jobs.

## Alternatives

Moving the entire PR build/package job projects 12,058 execution minutes per
30 days at unchanged GitHub timings, or 13,187 with per-job minute rounding.
That exceeds the allowance on the 2-vCPU tier before release use. Increasing
the CPU tier adds a proportional allowance multiplier.

Required Vitest, browser and coverage families are much larger than this
allowance. Selecting one complete shard for every PR would exceed the target.
Moving a subset of PRs based on a hash or calendar would complicate the policy
and make the provider harder to predict.

Splitting typecheck adds a second setup sequence. It removes only the
typecheck portion from GitHub's occupied runner time; it does not remove the
whole build/package runner. Its concurrency gain will therefore be modest.
Benchmark both job duration and the remaining GitHub job before claiming a
wall-time improvement.

## Preserved guarantees

Before the split, `build-and-package` required typecheck to pass before it could
pass. Its skip rule ignored docs, infrastructure and release-bump exemptions.
The required aggregate now depends on both typecheck and build/package. It
requires both to pass for every change surface. Only verified exact-commit
queue proof permits both to skip on a main push. The proof roster requires the
new typecheck leaf as well, so old or incomplete queue evidence falls back to
full verification.

Minimum Node setup, its bounded retry, immutable checkouts, read-only permissions
and npm/pnpm lockfile selection apply to both jobs. The build/package VM explicitly
builds the server before unit tests, preserving the preparation formerly done
by the typecheck prehook. Nightly retains its combined GitHub job.

## Required preservation and proof

The typecheck remains mandatory for docs-only, infra-only and release-bump
PRs. A failed, cancelled or unexpectedly skipped typecheck must fail the
required aggregate. Preserve immutable checkouts, read-only permissions,
installer selection, the Node minimum, setup retry and queue-proof fallback.
Add the new job to the exact-queue proof roster and its parity checks.

The old typecheck built server declarations before checking the web. The new
build/package job explicitly runs `npm run build:server` before unit tests,
preserving that preparation on its own VM.

Native PR checks use the base branch workflow. A branch workflow dispatch must
exercise the final Blacksmith runner selection before merge. The typecheck
measurement above passed; the complete dispatch and current-head PR gates
must still pass. The PR's verification section records their final results.
