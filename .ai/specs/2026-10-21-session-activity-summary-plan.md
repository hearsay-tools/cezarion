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
