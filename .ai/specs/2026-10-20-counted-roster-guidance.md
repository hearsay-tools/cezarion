# Proposed: surface the existing counted-roster prose rule

Status: proposed, awaiting design approval. Subject: hearsay-tools/cezarion#1337.
This document is analysis only; it does not apply the documentation remedy.

## Eligibility and evidence

Checked 2026-10-20 against fetched main `9adb3f1d9beda70f61e76d185db385d88196562f`
(the worktree HEAD also matches). The issue is OPEN, authored by `wjarka`,
unassigned, with `friction`, exactly one handling label (`friction-design`) and
one recognized category (`friction-knowledge`). Its comments are empty; its
GitHub timeline shows no claim or linked implementation PR. An open-PR search
for 1337 returns none. The cockpit lists 711 parent tasks; a read-only scan of
all 1,613 local run records (task/title/issue/automation subject fields) finds
only this task, `f41fe8ba-cea4-4e19-b012-f9cea5128b13`, for this issue.
These are point-in-time observations, not an atomic cross-system reservation.
Recheck before implementation after Continue.

Verified missing recipe on main:

- `packages/cezar/src/core/harness-parity.test.ts:1971` defines the test
  `protocol and matrix prose name runners without a counted roster`.
- Its regex checks AGENT_PROTOCOL.md, the harness-parity matrix spec,
  harness-parity.test.ts and harness-parity.testkit.ts. It recognizes specified
  numeric/word counts before runner/backend/mock/mock-selector/test-file nouns,
  with a bounded list of intervening modifiers. It is not a general prose parser.
- AGENT_PROTOCOL.md:1745 already explains the rule deep in §7. Thus the report's
  “nothing near the prose” overstates its absence. The introduction has no such
  guidance and neither does the AGENTS.md Agent runners / backends routing row.
  Neither supplies the focused command next to that rule.
- Historical AGENT_PROTOCOL.md at `22c111dd7efa98709bd89493900b979da8c29818`
  (a commit in hearsay-tools/cezarion#1317) contains “three runner shards” at
  line 1152. Extracting the regex from current main and applying it to that
  historical file produces `['three runner']`; current main produces `[]`.
  This reproduces the string-level violation without changing tracked files
  or running a full parity suite. The reported CI duration and shard failure
  were not independently timed or re-executed and are not needed for this design.
- Root package.json maps `npm test` to `vitest run` with the workspace projects;
  the existing test title contains the unique filter text `counted roster`.
  Command wiring is verified statically; the focused command has not been run
  during this analysis-only task.

## Existing load-bearing guarantees

The guard prevents runner inventory changes from leaving stale numeric claims
in the protocol and parity documentation/comments. `RUNNER_IDS` and the executable
adapter/matrix coverage remain the inventory authority. Naming runners when a
wire distinction matters remains useful; numeric protocol layers, criterion IDs,
version numbers and unrelated limits must remain readable. The guard must retain
its current regex, checked paths, assertions and CI coverage. An editing hint
cannot substitute for backend parity verification.

The protocol introduction already makes executable code authoritative when prose
and fixtures disagree. The remedy should expose established practice, not broaden
that practice into a new repository-wide ban on numbers.

## Recommended behavior and exact proposed wording

After approval, add a short editing note near the top of AGENT_PROTOCOL.md,
after the paragraph explaining that code wins and before the protocol layers:

> Editing runner prose: name runners or backends when needed, but avoid counted
> rosters; use “every runner” or “runner shards” instead. The
> `harness-parity.test.ts` guard `protocol and matrix prose name runners without
> a counted roster` enforces this rule here and in its parity reference files.
> From the repository root, run only that guard with:
>
> `npm test -- packages/cezar/src/core/harness-parity.test.ts -t "counted roster"`

Add the following sentence and command to AGENTS.md's Agent runners / backends
row, close to its instruction to read AGENT_PROTOCOL.md first:

> Runner/backend prose avoids counted rosters; `harness-parity.test.ts` checks
> this in the protocol and parity reference files. Focused prose check from the
> repository root: `npm test -- packages/cezar/src/core/harness-parity.test.ts -t "counted roster"`.

Retain the existing §7 explanation. Its technical detail and the new entry-point
hint serve different reading paths. The note should not claim AGENTS.md itself
is scanned by the guard. Avoid rejected examples in the protocol note itself:
the regex scans literal text, including code fences. Do not restate the complete
regex in prose, where it would become another inventory to maintain.

## Alternatives and trade-offs

1. **Recommended: entry-point note plus routing-row hint.** Small duplication
   makes the established requirement visible at both editing entry points. The
   executable guard remains authoritative; the command appears where needed.
2. **Only link to §7.** Less duplication, but the focused recipe remains harder
   to discover and the routing instruction still lacks immediate guidance.
3. **Split or broaden the guard.** A faster dedicated suite or new coverage of
   AGENTS.md could help later, but changes test structure/policy and is unnecessary
   for the verified discovery gap. Do not include it in this remedy.

## Defaults, authority, cost and user-visible behavior

Shipped runtime defaults, runner availability, environment variables, grants,
model selection, network exposure and token costs are unchanged. Reading the
hint is passive; running the focused command is an explicit contributor action.
That command selects a prose guard, not the full runner harness, and provides no
claim that native-wire parity passed. Contributors get earlier guidance rather
than a changed cockpit experience. No new approval power is conferred on agents;
existing review and verification requirements remain in force.

## Persistence and compatibility

Only tracked Markdown in AGENT_PROTOCOL.md and AGENTS.md would change after
approval. There is no new runtime state, config, migration, schema or API.
Existing recordings, recovery, clients and published behavior are unaffected.
This proposal itself persists under .ai/specs. No run state is added or changed;
a Transitions out table, including no-session recovery, is therefore not
applicable. No runtime execution path or durable outcome write is touched.

## Acceptance criteria

- The protocol introduction states the established rule and names the existing
  guard and its source test file.
- The exact root-relative focused command appears next to the rule, and the
  AGENTS.md routing row provides the same guidance without breaking its table.
- The wording avoids counted runner/backend rosters and does not imply a new
  ban on unrelated numbers or claim that the guard scans AGENTS.md.
- The existing §7 context, regex, paths, parity matrices and required verification
  remain unchanged. The implementation diff contains only the approved Markdown.
- The focused guard passes on the approved documentation change. Full parity
  checks remain mandatory whenever their existing repository triggers apply.

## Verification plan after approval

1. Re-fetch main and the issue; confirm current eligibility and no other work.
2. Apply only the agreed Markdown additions. Review the rendered Markdown table
   and ensure both editing entry points show the command and scope accurately.
3. Execute the exact focused command above once to validate the documented
   recipe. Follow Squeal coordination: use its current result when it covers the
   required check; if the focused recipe has no known result, an explicit run
   verifies the recipe itself. Do not duplicate full background harness runs.
4. Retain the already verified historical regex reproduction as evidence of
   existing policy, not evidence of a new runtime regression fix. No product
   source is changed or stashed for this documentation-only remedy.
5. Run `git diff --check`, inspect the final file list, and read current Squeal
   results before reporting verification. Typecheck/build are unnecessary for
   plain Markdown unless later scope introduces executable changes.

## Approval and continuation

Design approval and **Continue on this same task** are the next steps. The
classification is a recommendation, not approval. Do not relabel to launch a
second task, close the issue, merge, enable automations or implement the remedy
as part of this analysis-only stage.
