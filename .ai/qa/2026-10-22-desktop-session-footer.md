# Desktop session footer

The user clarified that Session Activity and the Composer must stay visible while
scrolling on desktop. The existing footer scrolled away with the conversation.

## Design

Use the existing footer as a CSS sticky element at viewport widths of 768px and
above. Keep the shell main as the transcript's scroll owner. Place Jump to latest
above the footer so it cannot cover the Composer. Bound the footer content to
60dvh and the space below the header; expanded activity details scroll within
their card and yield space to the Composer. Long drafts scroll inside the input.
Attachments stay in a horizontal scroll area. Phone controls keep document flow.

A fixed footer would need a separately measured spacer to keep the last message
readable. CSS sticky retains that space without another scroll owner. A resize
observer measures the header, footer and main viewport. Their sizes set native
scroll padding so focused transcript controls and scrollIntoView targets clear
the sticky controls. The observer removes its properties when the route unmounts.
No configuration, run states, API, dependencies, artwork or motion are added.

## Verification

| Requirement | Evidence |
| --- | --- |
| Desktop controls stay visible at the start and middle of long threads | `session-footer.e2e.ts`: flat/light and virtual/dark at 1440×900; flat/dark and virtual/light at 1024×768 |
| Jump stays visible and returns to the live tail | Same browser cells check its position and hit target, then click it |
| Scrolling keeps a typed draft | Same browser cells retain the draft while reading earlier messages |
| Short sessions keep controls at the bottom | Short-session browser case |
| Expanded activity and long drafts remain accessible | Browser case at 768×640 with 20 draft lines and a scrolling activity card |
| Attachments and send controls fit a short desktop window | Browser case at 1024×480 with four files and 20 draft lines |
| The final transcript row remains readable | Existing `thread-scroll.e2e.ts` checks row separation during interaction and footer separation at the live tail |
| Phone controls scroll away | Chrome inspection at 360×640; existing phone coverage in `thread-scroll.e2e.ts` |
| Both themes and keyboard targets remain usable | Browser cells cover both themes; a real Tab reveals a transcript button above the footer and checks its hit target |

`npm run typecheck` and `npm run build` pass. The production build includes
`check:pack`. Focused task-thread, thread-scroller, activity-dock and browser wait
discipline unit suites pass through Squeal. The draft PR records the latest
task-worktree browser verdicts and the optional slow-suite count.

## Regression proof

- `proof_base`: `73cbdfe1f3242b1a6019b2eed61bc5fc75a942fc`.
- Created a disposable detached worktree and installed its own dependencies.
- Copied `session-footer.e2e.ts` into that checkout.
- Command: `npm run test:e2e -- session-footer.e2e.ts`.
- Old source: five failures show footer visibility or placement defects; the
  short-session guard passes. No import or setup failure occurred.
- Copied only `task-thread.tsx` and `session-layout.css` from the task checkout.
  The same six browser tests pass with the fixed source.
- Logs are retained under ignored `.ai/qa/footer-proof-{red,green}.log`.

The independent review found short-window clipping and footer-hidden keyboard
focus. Additional proof uses `8141e01a42c4e93fd1c7dc99e742a43348c993af` as its
`proof_base`, with its own installed dependencies and unchanged new tests:

- `npm run test:e2e -- session-footer.e2e.ts -t '480px|keyboard-focused'`:
  two failures on old source. The Composer leaves the viewport, and Tab focuses
  a button whose hit target is covered by the footer.
- Copying the fixed CSS, route, viewport hook and activity interaction helper
  makes both cases pass. The helper scrolls rows within the bounded activity card
  before a pointer click; it keeps the real click and expansion assertions.
- `npm run test:e2e -- session-footer.e2e.ts`: all eight cases pass on final source.
- Logs: ignored `.ai/qa/footer-review-proof-{red,green}.log`.

## CI browser compatibility proof

Fresh CI run `39844072926` installed agent-browser 0.39.2 after its release at
19:52 UTC. The Settings system-prompt field at 1440×900 starts at y=880.89 with
height 44px. Its center is below the viewport. Version 0.39.2 rejects this click;
0.36.0 reported success for the same off-screen coordinates. The test now scrolls the field
into view before the real pointer click. Save and cold-reload assertions remain.

- `proof_base`: `3fd324dc95b1e0c7c1cd48378088efb040e90755`.
- An ignored scratch copy uses the same browser config, setup and assertions.
  Imports and artifact paths point to their original locations. Its browser
  descriptor selects an isolated agent-browser 0.39.2 binary and namespace.
- Command: `npm exec -- vitest run --config .ai/qa/settings-proof.ialck5j7/vitest.config.ts`.
- Old test: four pass; explicit-save click fails with “outside the viewport”,
  then cold reload fails because no prompt was saved. These match CI.
- Adding only the scroll step makes all six tests pass with the same browser.
- Logs: ignored `.ai/qa/footer-settings-proof-{before,after}.log`.
- The scratch test and config were removed after proof.

## Existing limitation

Jump to latest resets paged history and can remount the Composer, clearing a
draft. This predates the layout change. Draft persistence across remounts is
tracked in [hearsay-tools/cezarion#1009](https://github.com/hearsay-tools/cezarion/issues/1009).
The new tests check retention during scrolling; the Jump assertion covers layout.
