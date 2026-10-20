# Friction categories and handling policy

## Recommendation

Keep `friction` as the signal that work exposed an obstacle. Categorize the obstacle separately from deciding whether an agent may implement its remedy. The useful dividing line is **restoring an established behavior versus choosing a new behavior**. A small change can need design; a complicated regression can still be suitable for automatic implementation.

Use three handling routes:

- **Automatic implementation:** the intended result is established, the change is bounded, and verification can show it achieved that result. Finish at a draft PR and the normal review gate.
- **Guarded automatic implementation:** the result is established, but the change crosses runtime, integration, or safety boundaries. Investigate automatically and implement only with the relevant contract, regression evidence, and shared coverage.
- **Design first:** automatically investigate and draft a proposal, then obtain approval of the behavioral decisions before implementation. Approval can delegate implementation details; it should settle the user-visible guarantees and trade-offs.

This is a policy for future friction reports, not a disposition of the reference issues. The examples below illustrate recurring patterns; their current open/closed or PR status does not determine the recommended handling.

## Proposed categories

| Category | What belongs here | Default handling | Boundary that changes the route |
| --- | --- | --- | --- |
| **1. Missing knowledge and discoverability** | Correct commands, framework traps, review requirements, and established rules that contributors repeatedly rediscover. Examples: [fork #1001](https://github.com/hearsay-tools/cezarion/issues/1001), [fork #1093](https://github.com/hearsay-tools/cezarion/issues/1093), [fork #1166](https://github.com/hearsay-tools/cezarion/issues/1166), [fork #1252](https://github.com/hearsay-tools/cezarion/issues/1252). | **Automatic.** Verify the advice against the current system, add a copyable recipe or worked example to its canonical documentation, and link it from the entry point contributors use. | A proposed rule changes accepted behavior, adds a mandatory gate, or imposes a new repository-wide restriction. That is a policy decision and needs design, even when the patch is Markdown. |
| **2. Diagnostics and recovery guidance** | Failures hide the relevant event, filename, invalid field, or next action. Examples: [fork #1153](https://github.com/hearsay-tools/cezarion/issues/1153), [fork #1292](https://github.com/hearsay-tools/cezarion/issues/1292), [fork #1132](https://github.com/hearsay-tools/cezarion/issues/1132), [fork #1139](https://github.com/hearsay-tools/cezarion/issues/1139). | **Automatic.** Put useful evidence at the failure site; test the failing path and verify that suggested commands work in that state. Keep successful output quiet. | Recovery starts changing state, retrying paid work, revealing private data, or redefining outcomes. Separate those behavioral changes from improving the explanation. |
| **3. Test harness and verification mechanics** | Fixture startup, browser environment, keyboard helpers, synchronization, reproducibility, and fragile test bookkeeping. Examples: [fork #1090](https://github.com/hearsay-tools/cezarion/issues/1090), [fork #1091](https://github.com/hearsay-tools/cezarion/issues/1091), [fork #1084](https://github.com/hearsay-tools/cezarion/issues/1084), [fork #1216](https://github.com/hearsay-tools/cezarion/issues/1216), [fork #1276](https://github.com/hearsay-tools/cezarion/issues/1276). | **Automatic investigation and bounded fixes.** Read the failure evidence, reproduce the cause, prefer observable readiness, preserve the assertion, and demonstrate the improvement. | Fixing the report requires weakening assertions, excluding coverage, changing the verification strategy, or accepting a different level of reliability. Propose that change for design rather than silently making the suite green. |
| **4. Local consistency and maintainability** | Duplicated decisions, demonstrably dead code, formatting defects, and violations of an existing quality standard. Examples: [fork #1134](https://github.com/hearsay-tools/cezarion/issues/1134), [fork #1141](https://github.com/hearsay-tools/cezarion/issues/1141), [fork #1133](https://github.com/hearsay-tools/cezarion/issues/1133), [fork #1269](https://github.com/hearsay-tools/cezarion/issues/1269). | **Automatic.** Centralize the existing rule, remove code only after checking production reachability, or apply the established standard. Use the relevant compile, build, accessibility, or delivery checks. | The cleanup changes navigation, appearance beyond an established standard, public behavior, or architecture. Extract that decision into a design proposal. |
| **5. Regressions against an agreed contract** | The system violates a documented or previously approved guarantee. Examples: [fork #1137](https://github.com/hearsay-tools/cezarion/issues/1137), [fork #1138](https://github.com/hearsay-tools/cezarion/issues/1138), [fork #1268](https://github.com/hearsay-tools/cezarion/issues/1268). | **Guarded automatic.** Name the guarantee, reproduce its violation, prove the regression test fails without the fix, and verify the neighboring guarantees. Runner changes require native-wire coverage across `RUNNER_IDS`; lifecycle changes require the repository's parity gates. | The alleged guarantee is absent, contradictory, or the remedy changes another guarantee. The word “bug” is not sufficient authorization to choose the replacement behavior. |
| **6. Missing capabilities and integration support** | A command or helper does not exist, forcing manual discovery or workarounds. Examples: [fork #1242](https://github.com/hearsay-tools/cezarion/issues/1242), [fork #1149](https://github.com/hearsay-tools/cezarion/issues/1149), [fork #1002](https://github.com/hearsay-tools/cezarion/issues/1002). | **Automatic analysis; conditional implementation.** A bounded read-only extension can proceed automatically when it reuses established authority, data, and contract conventions. Otherwise produce a short design first. | New file copying, overwrite rules, permissions, cross-run access, persistence, external side effects, or a new user workflow need explicit decisions. An attachments flag, for example, needs decisions about paths, symlinks, sensitive files, limits, and cleanup. |
| **7. Lifecycle, concurrency, and durability policy** | What wakes, parks, times out, resumes, saves, or cleans up; ownership under crashes or simultaneous operations. Examples: [fork #1241](https://github.com/hearsay-tools/cezarion/issues/1241), [fork #1197](https://github.com/hearsay-tools/cezarion/issues/1197), [fork #1004](https://github.com/hearsay-tools/cezarion/issues/1004), [fork #1024](https://github.com/hearsay-tools/cezarion/issues/1024). | **Design first when guarantees change.** Analyze the existing mechanism and propose the defaults, transitions, crash behavior, bounds, and compatibility before implementation. | If an approved design already answers those questions and the report only identifies a violation, route it as category 5. The distinction is an established guarantee, not the number of files touched. |
| **8. Identity, accounting, and automation eligibility** | Which issue owns a task, what “replied” or “duplicate” means, when automation should launch, and what counters measure. Examples: [fork #1218](https://github.com/hearsay-tools/cezarion/issues/1218), [fork #1217](https://github.com/hearsay-tools/cezarion/issues/1217), [fork #1219](https://github.com/hearsay-tools/cezarion/issues/1219), [fork #1241](https://github.com/hearsay-tools/cezarion/issues/1241). | **Design first for meaning or policy changes.** Define the terms and lifecycle, then make storage, API, CLI, and UI agree. | A counter merely computes an already specified metric incorrectly, or a view misrenders a specified state: that narrower defect can use category 5. Choosing the metric's window or changing a settled outcome requires design. |

Categories can overlap. Record a primary category and any consequential boundary; the strongest applicable handling requirement wins. For example, changing a request's late-reply outcome belongs to both lifecycle and accounting, even if its visible symptom is an unhelpful message.

## How automation should handle the categories

### One routing step before implementation

Every friction run should first record:

1. **Obstacle:** what the contributor had to do, and the wasted effort it caused.
2. **Evidence:** reproduction, failure bundle, command transcript, or verified missing documentation.
3. **Established guarantee:** the source that determines the intended behavior, or an explicit statement that it remains undecided.
4. **Boundary:** runtime defaults, cost, authority, durable state, public contracts, or user experience affected by the proposed remedy.
5. **Route:** automatic, guarded automatic, or design first, with a short reason.

Closed, claimed, already-covered, or unreproducible reports should receive an evidence-based no-action result rather than a speculative implementation. A documentation report can be verified by following its recipe; a timing report needs a reproducible signal, not an assumption that a larger timeout will help.

### Automatic routes

Categories 1–4 are the best continuing source of automatic PRs. Category 5 is also suitable when its guarantee and verification are explicit. Category 6 has a narrow automatic subset: read-only additions within existing boundaries.

The run may investigate, implement, check the result, and open a draft PR. It should stop expanding the implementation if investigation reveals a design decision. For guarded work, attach the named guarantee, red/green regression evidence, and boundary-specific checks to the PR. A passing test suite alone does not establish that the chosen behavior was right.

### Design route

Automate the analysis and proposal for categories 7–8 and the broader category 6 work. The output should give:

- The recurring obstacle and evidence that it merits a product change.
- The existing guarantees that are doing useful work.
- A recommended behavior and credible alternatives, with the meaningful trade-offs.
- Behavior at shipped defaults, authority and cost boundaries, persistence and compatibility consequences.
- Acceptance criteria and a verification plan. State changes need the repository's **Transitions out** table, including no-session recovery and failure paths.

The review gate approves those decisions. Implementation can then run automatically against that approved design. This keeps investigation and proposal work autonomous while putting approval before a behavioral commitment.

Three recurring subjects especially justify this treatment:

| Design subject | What the proposal must settle |
| --- | --- |
| **Durable waits and request outcomes** | Request expiry versus work completion; whether a late reply amends a terminal outcome; cancellation, human messages, recovery, wake bounds, and resource release. Reference patterns: [fork #1241](https://github.com/hearsay-tools/cezarion/issues/1241), [fork #1197](https://github.com/hearsay-tools/cezarion/issues/1197), [fork #1225](https://github.com/hearsay-tools/cezarion/issues/1225), [fork #1268](https://github.com/hearsay-tools/cezarion/issues/1268). |
| **Task identity and automation policy** | Origin versus incidental references; deduplication scope; legitimate retries and later stages; ownership of a task; counter definitions and retention. Reference patterns: [fork #1218](https://github.com/hearsay-tools/cezarion/issues/1218), [fork #1217](https://github.com/hearsay-tools/cezarion/issues/1217), [fork #1219](https://github.com/hearsay-tools/cezarion/issues/1219). |
| **Worktree data and authority** | What may be written, copied, preserved, overwritten, or deleted; behavior beside the agent's Git operations; ownership of materialized skills; failure and cleanup guarantees. Reference patterns: [fork #1004](https://github.com/hearsay-tools/cezarion/issues/1004), [fork #1024](https://github.com/hearsay-tools/cezarion/issues/1024), [fork #1149](https://github.com/hearsay-tools/cezarion/issues/1149). |

These are subjects for future changes in those areas, not requests to redesign completed fixes.

## Applying the policy to cezar automations

The inspected “Friction” automation says: “Design gate is pre-approved.” Replace that blanket instruction with the routing policy above. Retain verification of the report and the final human merge gate, but recognize that a merge decision occurs after implementation; it does not replace approval of unresolved behavior before implementation.

Prefer **one routing automation** to start. It can either implement a qualified fix or finish with a design proposal. Continue the same task after design approval.

There is an implementation reason to keep that flow together: `launchAutomationRun` in `packages/cezar/src/automations/task-template.ts` checks `findNonArchivedRunByIssue` before launching an issue-triggered task. A separate design automation followed by a label-triggered implementation automation can be blocked by the design task's existing reference to that issue. A multi-stage automation handoff would itself need a designed continuation and deduplication policy; adding labels alone does not provide one.

Keep the label scheme small:

- `friction`: how the obstacle was discovered.
- Existing `area-*` labels: where the remedy belongs.
- Existing `risk-*` labels: blast radius.
- Optional routing labels, if useful in the UI: `friction-auto` and `friction-design`. Guarded automatic work can use `friction-auto` plus its actual risk and required evidence; it does not need a second label taxonomy.

Category names can live in the triage result initially. An unset route means investigation first. Applying an automatic label never overrides a newly discovered safety boundary or an explicit design requirement in the issue.

For knowledge friction, avoid turning every incident into another long rule in `AGENTS.md`. Prefer one canonical local explanation, a worked example, and a short pointer at the contributor's entry point. Repeated mechanical mistakes can justify a small executable check; introducing a broad new enforcement policy belongs on the design route.

## Reference scope and limits

Reviewed all **56 issues currently carrying `friction` in `hearsay-tools/cezarion`**, across open and closed states, created from 2026-10-13 through 2026-10-19. Read their bodies, complete available comments, and closure/cross-reference timelines. GitHub pagination reported no further issues, comments, or timeline pages. This scope does not claim to recover issues whose friction label was removed, or include other repositories.

Also inspected the live Friction automation's definition and the issue-launch deduplication code. The category and routing recommendations are judgments drawn from that reference set; they are not measured automatic-implementation success rates.

This deliverable changes no product behavior or live automation. Validation checks its references and coverage of the requested policy; runtime tests are not relevant to this Markdown-only report. No Squeal usage friction was encountered in this session.
