# Desktop session footer

The user clarified that Session Activity and the Composer must stay visible while
scrolling on desktop. The existing footer scrolled away with the conversation.

## Design

Use the existing footer as a CSS sticky element at viewport widths of 768px and
above. Keep the shell main as the transcript's scroll owner. Place Jump to latest
above the footer so it cannot cover the Composer. Bound the footer content to
60dvh; expanded activity details scroll within their card and yield space to the
Composer. Phone controls keep their existing document flow.

A fixed footer would need a separately measured spacer to keep the last message
readable. CSS sticky retains that space without another observer or scroll owner.
No configuration, run states, API, dependencies, artwork or motion are added.

## Verification

| Requirement | Evidence |
| --- | --- |
| Desktop controls stay visible at the start and middle of long threads | `session-footer.e2e.ts`: flat/light and virtual/dark at 1440×900; flat/dark and virtual/light at 1024×768 |
| Jump stays visible and returns to the live tail | Same browser cells check its position and hit target, then click it |
| Scrolling keeps a typed draft | Same browser cells retain the draft while reading earlier messages |
| Short sessions keep controls at the bottom | Short-session browser case |
| Expanded activity and long drafts remain accessible | Browser case at 768×640 with 20 draft lines and a scrolling activity card |
| The final transcript row remains readable | Existing `thread-scroll.e2e.ts` checks row separation during interaction and footer separation at the live tail |
| Phone controls scroll away | Chrome inspection at 360×640; existing phone coverage in `thread-scroll.e2e.ts` |
| Both themes and keyboard targets remain usable | Browser cells cover both themes; existing controls retain their accessible labels, focus styles and target sizes |

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

## Existing limitation

Jump to latest resets paged history and can remount the Composer, clearing a
draft. This predates the layout change. Draft persistence across remounts is
tracked in [hearsay-tools/cezarion#1009](https://github.com/hearsay-tools/cezarion/issues/1009).
The new tests check retention during scrolling; the Jump assertion covers layout.
