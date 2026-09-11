# Session and GitHub revision evidence

Scope: issue 224, owned session/composer and GitHub routes. No shared shell, API,
run-engine, provider, permission, or merge-policy changes. References are the revised
`cezarion.pen`, not `design.pen`. The source design stays in the parent worktree.

## Reference coverage

- Session 2/3: `cgGWE`, `HYltX`, `gVXYn`, `zwIL4`: transcript and composer in document
  flow; Runner/Effort above attachment, microphone, Model and Continue on desktop;
  Model then Runner/Effort then attachment/microphone/Send on phones. User content,
  tool details, plan/worker docks, Stop, drafts, selection and scroll restoration retained.
- Session actions 28/29: `ZhHkR`, `rEzlh`, `ogTQi`: one desktop/mobile action menu,
  actual discovered worktree targets, copy path/available resume command, notes,
  Finish/Archive/Delete confirmation. Existing action flags and finish review gate retained.
- GitHub 9: `tVifC`, `zu66o`, `AKO2L`, `eOnqx`: prompt first, Template, full-width
  Workflow/Skills, removable selected skills, Model, Runner/Effort, Account. Mobile
  issue preview expands to all issues; an already selected row never disappears.
- GitHub 27: `I44Ul8`, `zSB9u`, `kDsvU`, `RvbXf` (plus source subtree `Pf2JI`): full-width PR review, Conversation
  and Changes, ready/conflicting/unknown readiness, confirmation and exact reviewed
  head. Readiness and handoff are available on Changes too. Conflict CTA focuses the
  actual handoff; it does not create a task without the existing submit action.
- `mxZSz` coverage contract: retained issue filters, assigned-to-me, board, Clear,
  Refresh, provider/account gates, persisted choices and exact-head merge permissions.

Primary and supplemental PNGs were viewed, along with the relevant page-subtree
content extracts. Corrupt repeated navigation rows were not reproduced. Parent owns
shared navigation and global theme/density/width integration.

## Verification

Commands use `env -u TMPDIR -u TMP -u TEMP`; browser commands additionally set
`AGENT_BROWSER_ARGS=--no-sandbox` for this container. Unit runs unset the inherited
`CEZ_AUTOMATIONS` flag when checking default capabilities.

- Owned Vitest suites: **1,017 tests / 33 files pass**.
- Root typecheck and build pass; final web typecheck passes.
- `npm run test:unit`: **261 pass**. `npm run test:package`: **27 pass**.
- Full unit run: **7,958 pass / 4 fail**. Health capability mismatch passes with
  inherited `CEZ_AUTOMATIONS` unset. Worker-wait recovery timeout passes isolated.
  Two pre-existing `routes.test.tsx` workflow heading expectations still fail: they
  expect `Loading workflows…`, while the existing loading component renders
  `Workflows`. These files are outside worker ownership. All 1,017 owned tests pass; final GitHub recheck passes 153/153.
- Browser verification: **74/74 tests pass across all three owned suites** in one
  combined run (130.57 seconds). This includes the 12 long-transcript scroll checks.

Regression tests demonstrated red before implementation for labeled Send,
prompt-first handoff, readiness on Changes, Finish/Archive confirmations, worktree
chooser, unknown requirement label, direct resume-command copy and mobile list expansion.
Existing assertions were adapted only for intentional relocation/document flow. The
virtualized tool interaction waits for complete replay geometry to settle beyond
virtua's 150 ms arrival-scroll retry window, then resolves its stable row key rather
than clicking a detached DOM node. Every simulated upward gesture sends intent even
if already near its target; overlap and scroll assertions remain intact.

Browser artifacts are in this worker's `.ai/qa/artifacts_e2e/` (gitignored):
`revised-session-{1440,402,360}-{light,dark}.png`, corresponding action-menu images,
`revised-github-handoff-{1440,402,360}-{light,dark}.png`, loading/empty/error images,
`revised-pr-{ready,unknown,conflicting}-{1440,402}-{light,dark}.png`, confirmation
images, `github-iphone.png`, and long-thread scroll/overlap metrics and images.
Verification logs are retained under `artifacts_e2e/session-github-verification/`.
These use real wire-shaped fixtures and real controls. PR browser fixtures reject
merge POSTs; precise-head mutations and capability gates are asserted in unit tests.

## Explicit design/API limits for parent review

- PR 27 depicts assignee/project-board metadata. The current contract/driver supplies
  those for issues only. Existing issue filters remain wired; no fake PR metadata or
  controls were invented. There was no existing explicit state dropdown to preserve.
- Handoff API supplies text without an updated timestamp; no timestamp was fabricated.
- No read-only native resume-command endpoint exists. Copy uses the existing validated
  `resumeHint` when available, and terminal failure retains the existing server-command
  fallback. Opening a terminal is never used merely to obtain a copyable command.
- `Pf2JI` had no exported PNG. Its actual source subtree was inspected and the
  equivalent unknown-requirements mobile fixture was exercised in both themes.
- Real-device iOS keyboard behavior remains a manual check; headless tests verify the
  viewport inset seam, document flow and non-overlap, not a physical keyboard.

## Parent review follow-up: Model target

The desktop Model button measured 26px. Its shared rule now has `min-height: 44px`,
with no separate mobile override. The browser matrix asserts the actual button
height at 1440, 402 and 360 in both themes: desktop failed before the fix, all six
pass afterwards. Web build passes; session browser suite 30/30 and scroll suite
12/12 pass with the fix. The Notes screenshot uses viewport capture so stitching
does not scroll the transcript between its unchanged menu-toggle assertions.
