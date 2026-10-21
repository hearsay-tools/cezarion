# Session activity summary plan

**Goal:** Make folded session details useful at each width and give CI waits and worker capacity clear homes.
**Architecture:** Keep the existing React disclosures and query owners. Add one measured summary that removes whole items in a declared order; CSS keeps a single clipped line before measurement. Reuse reference chips and the existing agent identity resolver.
**Spec:** The task request and its Workspace chip addition.

## Constraints

- No server, contract, run state or configuration changes.
- Preserve metric visibility, all wait outcomes, disclosure memory and keyboard access.
- Usage order: provider, model, effort, cost, input/output. Remove tokens, cost, provider, effort, model.
- Folded card: status, runner, model, effort, cost, reference chips. Remove chips, cost, runner, effort, model, status.
- Workspace shows both issue and PR references, including the folded card.

## Review focus

- Narrow containers and long model names must remove whole values without wrapping or overflow.
- Hidden chips must not remain keyboard targets.
- Missing metrics and identities must not invent values.
- CI references must work even when the wait PR is absent from the task references.
- Capacity must stay visible when the worker list is folded.

## Implementation

1. Extend dock tests for folded identity, CI chips, Workspace chips and worker capacity. Observe expected failures through Squeal.
2. Add a reusable priority summary with intrinsic width measurement and a CSS fallback. Integrate the requested removal orders into the dock and usage row.
3. Render CI state, PR and deadline as labelled details. Reuse safe links and preserve every outcome.
4. Show worker capacity in the Workers section header so it stays visible when the list is folded.
5. Verify focused unit results, web typecheck/build and real browser widths. Capture and publish expanded, folded and narrow screenshots.
6. Ask for screenshot approval. Open the draft PR only after approval.

## Verification evidence

- Web typecheck and production web build pass.
- Focused dock, summary, wait, relationships and session-details suites pass through Squeal.
- Real Chrome: ten widths from 320 to 1080 pixels; both themes; 200% zoom; priority removal and restoration; PR link and keyboard focus.
- Review-fix `proof_base`: `6f7951872de96c32edeea5c0eed76a606feab07c`.
- Disposable-worktree command: `npm test -- packages/web/src/routes/task-thread/run-activity-dock.test.tsx`.
- With the current test copied onto the old source: five expected failures (provider identity and accessible summaries), 45 passes.
- With only the fixed `run-activity-dock.tsx` copied into that same worktree: all 50 tests pass. The disposable worktree was removed.

## Screenshot feedback

- Expanded Workspace groups standard chips into labeled PRs and Issues rows.
- Folded references use the shared chip colors and borders, with inert controls inside disclosure buttons.
- Capacity stays in the Workers header; the expanded body retains the full-capacity recovery message.
- Browser assertions now select measured summary items; the main chevron explicitly disables transitions for reduced motion.
- Web typecheck/build and updated real Chrome checks pass (ten widths, themes, zoom, chip containment, grouped references, and capacity in the folded Workers header).

- Correction regression proof base: `4a9ea8634`. Copied the current dock and reference-chip tests into a disposable worktree with its own dependencies. Command: `npm test -- packages/web/src/routes/task-thread/run-activity-dock.test.tsx packages/web/src/components/reference-chip.test.tsx`. Old source: three expected failures; fixed source: 126 passes. Scratch worktree removed. Logs: ignored `.ai/qa/session-activity-review/correction-proof-{red,green}.log`.

- Final correction check: all nine selected suites are current/pass at revision 25, including the full `task-thread.e2e.ts` browser suite. All five previously reported browser failures pass. Web typecheck/build and real Chrome checks pass. The remaining 79 slow files were queued and are optional for this task.

## CI touch-target correction

- CI run [39610780143](https://github.com/hearsay-tools/cezarion/actions/runs/39610780143) failed the two mobile reference checks. Artifact `cockpit-failures-shard-1` (`12351000804`) shows the approved separate PRs and Issues rows; the old assertion still required both chips on one row. This is an obsolete test assertion, not a timing failure.
- Preserve the 44px minimum width/height and horizontal-overflow checks. Replace the old same-row expectation with exact group labels and chip membership, distinct vertical rows and an aligned chip column.
- Test-only `proof_base`: `a4e88c02725447dfd694b354022bcab029ed2bf4`. Copied the old test into ignored `.ai/qa/touch-reference-proof/before.test.ts`, outside watched includes. Adjusted only relative imports and `import.meta.dirname` to their original paths. The scratch config extends the browser config and selects only that copy.
- Command: `npm exec -- vitest run --config .ai/qa/touch-reference-proof/vitest.config.ts -t 'Session activity carries'`. Old test: both selected tests failed at the same-row expectation (182 vs 238; 438 vs 494). Replaced only the scratch test with the corrected version: both selected tests passed. The built app and fixture data were identical. Logs retained at ignored `.ai/qa/session-activity-review/touch-proof-{red,green}.log`; scratch test/config removed after proof.
- Local verification after the test correction: `npm run typecheck:web` passes, and Squeal reports the wait-discipline, cockpit sequencer and contract import guards current/pass at revision 30. The focused scratch browser proof passes both mobile cases. The full touch-target suite remains queued behind another worktree's shared slow slot; all 81 optional slow files are not current. CI owns the full browser gate.
