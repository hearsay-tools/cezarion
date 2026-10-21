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
4. Move worker capacity into a separate row above worker links, outside their disclosure.
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
