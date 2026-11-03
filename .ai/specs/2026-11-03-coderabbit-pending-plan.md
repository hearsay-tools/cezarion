# Keep unfinished CodeRabbit admission pending

The native review gate currently marks a running CodeRabbit review as failed.
Reconciliation later retries it. The owner asked to fix this and open a PR.

Preserve exact-head trusted newest provider evidence, resolved threads, review-first
heavy verification, native required checks, cancellation and bounded API reads.
Keep the shared admission reader immediate for readiness, reconciliation and queue
admission. Preserve the no-files policy in hearsay-tools/cezarion#2584.

Add a native-only wait helper. Read fresh admission at most 40 times, at 30-second
intervals, within a fixed 20-minute deadline. Each read keeps its 60-second total
and 10-second request caps, clipped to the wait deadline. Set the native job limit
to 25 minutes for checkout and reporting. This deliberately holds one Actions
runner while review is pending; it avoids failure/retry churn without changing
protected-check provenance or the heavy-job graph. No model requests or new flags.

Only missing and pending provider states wait. Retry the narrow changing-snapshot
error with fresh evidence; never grant admission from an inconsistent snapshot.
Other API/schema/head errors remain errors. Return settled admission immediately.
After timeout, fail with a clear notice; later existing reconciliation can retry.
The current marker remains the marker for the admission policy on main.

| Case | Result |
| --- | --- |
| Missing, queued or running provider | Keep native job active; heavy jobs remain blocked |
| Running provider with open findings | Wait for provider completion before settled admission |
| Newest successful or accepted no-files check; all threads resolved | Pass in the same native job |
| Older success, newer pending execution | Wait for newest execution |
| Completed unsuccessful provider or completed review with open threads | Block immediately; keep existing recovery |
| Provider changes during snapshot | Discard snapshot; bounded fresh read |
| Changed head, invalid target, API/schema/incomplete evidence | Error; never release heavy work |
| Missing or pending beyond deadline/read cap | Fail visibly; later reconciliation can recover |
| Cancelled or superseded workflow | Existing cancellation and concurrency prevent admission |
| Verified provider exception | Return immediately; still require resolved threads |
| Readiness, merge queue and reconciler | Immediate reader; no added waits |

Regression: execute the actual YAML admission script with fixture GitHub APIs and
an injected fake clock. Missing → pending → completed must exit successfully in
one invocation, and must fail under the original immediate-read YAML. Test limits,
terminal results, head changes, and changing snapshots without real-time sleeps.
Use Squeal for affected Node tests, then the complete changed-function quality
fallback, citations and pinned workflow lint. Dispatch final branch CI because
native PR CI reads main's workflow; the dispatch does not exercise native review.
