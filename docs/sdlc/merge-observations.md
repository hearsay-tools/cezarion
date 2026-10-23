# Shared pull request merge observations

The GitHub driver and CI client share confirmed merge facts in
`packages/cezar/src/merge-observations.ts`. This implements the information flow
for hearsay-tools/cezarion#1520. Completion controls in
hearsay-tools/cezarion#1540 still perform fresh checks before any mutation.

Each fact contains the GitHub owner, repository, PR number and actual `mergedAt`.
The key includes the repository. An observation of `org/a#42` cannot answer a
query for `org/b#42`. The canonical URL and returned number must match the
expected repository and number. GraphQL archive and sidebar observations also
require a matching `nameWithOwner` and an error-free response. A partial sidebar
response may still render its glyphs, but it cannot supply archive authority.

An absent, malformed or future merge timestamp supplies no shared fact. Neither
a sidebar glyph nor a successful merge response supplies a guessed merge time.
The first accepted fact is frozen. Repeated observations retain that fact and
its time. The process retains at most 1,000 facts and evicts the least recently
used fact. It stores no negative observations, credentials, CI state or merge
eligibility. This cache is shared across projects, has no configuration and
needs no browser demand. Dry-run archive lookups do not consume real facts.

## Producers and consumers

| Path | Shared facts or reuse | Additional evidence the consumer must obtain |
| --- | --- | --- |
| Sidebar reference status | The existing batch query requests canonical URL and `mergedAt`; verified merged PRs populate the cache. | The sidebar keeps its own status and mergeability refresh rules for open PRs. |
| PR detail, exact-number lookup and conversation detail | The PR view requests state and merge time; a resolved project repository validates identity before publication. | Body, comments, diff and display fields remain separate reads. Text search and timeline glyphs supply no merge authority. |
| Branch PR status | Publishes verified merge facts from its existing PR view. | The branch-to-PR relationship still comes from GitHub. A fact indexed only by number cannot establish that relationship. |
| PR merge-state panel | Publishes identity and merge time before policy reads. A later policy failure does not erase a confirmed merge. | Open PR eligibility, head, branch, checks, reviews, rules and allowed methods require fresh reads. |
| Automatic archive detection | `lookupMergedPullRequests` reuses known facts and batches only unknown identities, at most 25 per repository query. The fallback publishes its verified facts too. | The store/coordinator must validate the complete task family, declared and worker PRs, current archive policy, pending obligations, restore time and current intent before committing an archive receipt. |
| CI waits and PR merge waits | `GithubCiClient.mergeState` publishes verified merge facts. | Waits still fetch current head and mergeability, plus merge commit when available. They keep their existing wait IDs, deadlines and outcome rules. Shared merge facts do not prove CI success, approve a merge, or replace wait settlement. |
| Branch cleanup (`server/repo-branches.ts`) | A confirmed merge is reusable in principle; cleanup does not use this cache to authorize deletion. | Cleanup must still prove the branch tip and PR head match, the target base matches, the tip landed on that base, and every worktree/process/removal guard passes. A merged state alone cannot prove these facts. |
| Future merged-PR automations (hearsay-tools/cezarion#1180) | Repository identity and actual merge time can be reused. No new trigger is installed here. | Automations need their own persisted event identity, cursor, filter, baseline, deduplication and launch receipts. Cache presence is neither an event nor a delivery receipt. |

The archive scheduler keeps its existing bounded cross-project cadence and
query budget. Cache hits remove duplicate PR queries. They do not add polling,
new background loops or per-project timers. Eviction and process restart cause
the normal scheduler to fetch missing facts again, including for unopened
projects. Unavailable or incomplete responses remain eligible for later retry.
Consumers do not subscribe to cache presence as a lifecycle signal.

## Ready and merge safety

`ForgeDriver.readyPR` is an optional internal capability. It reads the PR again,
checks repository, number, expected head and task branch, and permits promotion
only while the PR is open. An already ready PR needs no mutation. The only
promotion command is `gh pr ready <number> --repo github.com/<owner>/<repo>`.
The command has a fixed argument shape and a 15-second timeout. It then refreshes
merge state and checks the expected head and branch again. GitHub provides no
atomic expected-head guard for promotion, so a concurrent update can occur
after the initial read. The later merge must revalidate independently.

`ForgeMergeInput.requirePassingChecks` requires at least one normalized check
and every normalized check passing in the fresh preflight. Missing, pending,
failing and unknown checks block completion merging. A complete, paginated workflow-run
query also blocks a rerun before its checks appear; query errors or incomplete pages
never authorize a merge. `NEUTRAL` and `SKIPPED`
use the driver's existing passing normalization. `expectedHeadRef`, when set,
must match the current PR branch. The normal GitHub eligibility and permitted
method checks still apply. Completion merging cannot override rules, even when
`overrideRules` is supplied. Inputs without strict completion fields preserve
manual merge behavior and its explicit override option.

Both mutation inputs accept an internal `canProceed` callback. The coordinator
uses it to stop work when task flags, status or the current intent change during
reads. The driver rechecks after reads and immediately before mutation. This
function never belongs in the HTTP contract. A change during an accepted GitHub
mutation cannot undo it. A completed merge reports GitHub's actual outcome; the
coordinator must check intent again before any later archive action.

The merge mutation still sends the expected SHA to GitHub's merge endpoint.
GitHub atomically rejects a changed head and enforces server-side rules. Dry-run
ready and merge paths perform no `gh` mutation. A successful merge without a
real merge timestamp needs a later authoritative observation before it can
populate the shared cache.
