# Recover CodeRabbit no-files skips

Proof base: `666efc213`. Parent owns sender probe, review, push and landing.

## Preserved guarantee

The newest trusted CodeRabbit App execution on the exact live head must complete
with success, and every review thread must be resolved. Native CI provenance,
preflight, readiness, queue admission, verified exceptions and fork restrictions
stay intact. A recovery claim, command, response or skipped check never admits a PR.

Classify provider evidence in the shared reader. Only authenticated
completed/skipped with exact `output.title === 'No files to review'` can request
one `@coderabbitai full review`. Incident evidence: official check `125896576467`
on head `5be277591c9f908ed44982d0115012e20e116091`, App `347564` / `coderabbitai`.
Do not interpret comment Markdown or provider summary tables.

Use the existing per-PR trusted reconciliation lock. Before the comment POST,
create a dedicated GitHub Actions check on the head with a PR+head external ID.
Read the complete bounded claim inventory, validate ownership/identity shape,
and confirm the new claim is uniquely visible before sending. Existing claims
only suppress sends: their caller-supplied URL and key cannot prove originating
workflow provenance. Prove the current execution from its trusted context run ID.
Every existing claim blocks a second attempt, regardless of its conclusion.
The claim starts with an explicit crash-before-send inspection instruction.
The check is completed/neutral at creation and every update; diagnostics never
leave a pending check. Creation ambiguity never sends. Comment ambiguity records inspection-needed;
never retry either POST in that execution. Claim updates are diagnostic only.
This is at-most-one automatic comment attempt under the workflow lock and GitHub's
authoritative API reads, not guaranteed provider execution or exactly-once delivery.
Deleting claims or bypassing the workflow lock invalidates deduplication.

Use a separate repository-scoped release App client with pull-requests write for
the comment only, subject to the parent's live sender proof. Existing App settings
are optional; missing or invalid settings keep admission blocked and explain the
manual command. Never fall back to the unproven github-actions sender. The normal
token only gains checks write for claims. No PR checkout, dependency install,
PR-controlled script, new credential requirement or PR-code execution occurs.

## Cases and transitions

| Case / state | Default action | Exit / trigger |
| --- | --- | --- |
| Missing, queued or in-progress provider | Block; explain waiting | Provider or CI event |
| Newest trusted success, no open threads | Existing admission | Existing native retry/readiness |
| Success and open threads | Block | Reviewer resolves; manual thread dispatch |
| No-files skipped title | Block; claim then one full-review command | New provider execution event |
| Other skipped, neutral, failure, cancelled or unknown | Block; actionable provider reason | Human/provider repair |
| Spoofed, stale, changing or incomplete evidence | Fail closed; no command | Fresh validated event/manual dispatch |
| Verified release/upstream exception | Existing exception, still check threads | Existing flow |
| Fork, closed PR or non-main base | No recovery write | Maintainer action |
| Missing sender settings / identity mismatch | No claim/comment; manual full-review instruction | Existing App restored or human command |
| Duplicate event, same PR+head | Existing claim blocks repeat | Provider event or manual inspection |
| New head | New independent claim key after fresh proof | Provider event |
| Same head on two PRs | Independent PR keys | Each PR's event |
| Claim creation timeout or malformed result | No comment; inspect possible claim | Human inspection; no blind resend |
| Crash after claim, before comment | Claim blocks repeat; explicit possible-unsent reason | Human inspects claim/comments |
| Comment accepted, response lost | Inspect exact authenticated receipt; requested if visible, else ambiguous; no resend | Provider event or maintainer inspection |
| Comment accepted, claim update fails | Existing claim still blocks repeat | Inspect comment/provider |
| Recovery requested, no provider completion by inspection time | Claim gives a ten-minute inspection time; no timer or timeout transition runs | Maintainer inspects after that time, provider event or manual dispatch |
| Native admission historical green while provider skipped | Revoke first; do no recovery work in this execution | CI completion re-enters recovery after red gate |

## Validation and readers

Pin regression red against the proof base in a disposable tree; use an existing
reader test for specific no-files classification so red is an assertion failure,
not a missing import. Add recovery fixtures for all claim/crash/ambiguity boundaries
and workflow permission/identity contracts. Use Squeal for ordinary affected tests.
Run citations, workflow parser/actionlint and complete changed-function quality
check. Full gates belong in CI. No package declarations change; typecheck only if
later edits make it relevant. Search old/new provider reasons and active claims
that reconciliation never calls a reviewer; update CI guide, SDLC and workflow
contracts. Historical admission plan receives a supersession pointer.

## Regression evidence

Disposable worktree, baseline `666efc213`, command
`node --import ./scripts/test-git-env.mjs --test --test-name-pattern='authenticated no-files skip' .github/scripts/coderabbit-admission.test.cjs`:
1 failed assertion (`provider-not-successful` versus `provider-no-files`). Copying
only the fixed admission source: 1 passed, 0 skipped. Scratch tree removed.

Parent review corrected claim provenance wording, made claims completed/neutral,
and moved recovery behind native green-to-red revocation. The ten-minute
inspection time requires a maintainer; no automatic timeout observer is claimed.

Recovery regression proof in a second disposable tree, same baseline and command
with `--test-name-pattern='no-files skip reserves one'` selecting
`.github/scripts/coderabbit-recovery.test.cjs`: baseline reconciler reports
`unchanged` instead of `recovery-requested` (1 assertion failure). New support
modules and fixed admission were present in both runs. Copying only the fixed
reconciler: 1 passed, 0 skipped. Scratch tree removed.

Live read-only run evidence: official reconcile run `41674135994` has event
`workflow_run`, branch `main`, the expected reconcile workflow path, and same
repository/head repository. The current-run check uses trusted context run ID;
existing claim URLs never prove provenance.

## Final local evidence

- Complete bundled quality check: 94/94 changed functions pass; maximum complexity
  20, maximum CRAP 20.0079. Its four focused node test files pass all 191 tests,
  0 skipped. Report: `.ai/qa/coderabbit-recovery/code-quality.md` (published task artifact).
- Squeal revision 12: admission, reconcile, recovery and workflow files each have
  a current result with no known failures. Full suites remain CI-owned.
- `npm run lint`: 10 cez and 16 ast-grep rules pass.
- `node .github/scripts/check-citations.cjs` and `git diff --check`: pass.
- Pinned actionlint 1.7.12, verified archive SHA-256, passes both changed workflows
  with shellcheck/pyflakes disabled (no shell blocks changed).
- No declarations change, so typecheck is not needed for this patch.
- Live release-App command acceptance and a new exact-head trusted successful
  provider execution remain mandatory parent-owned proof before landing. Local
  fixtures do not prove sender acceptance, postmerge delivery, GitHub claim
  visibility or native rerun scheduling. Parent owns PR review, CI and merge.
