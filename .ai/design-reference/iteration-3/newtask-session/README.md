# New task / session — current193 source, work in progress

Code pass only. **Visual acceptance remains open.** The parent confirmed user-approved source `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8` (193 top-level frames/components, parent commit `ac3f4a89`). This replaces the earlier iteration-2 source. Only iteration-3 PNGs can certify current fidelity. Shared exact filled-icon adapter is still requested; current glyphs are provisional Lucide React.

The replacement source was rescanned by frame name. Its model selectors changed from stacked 60px controls to inline 44px controls, with CPU identity and terminal/gauge icons in runner/effort selectors. This revision applies those changes to the new-task and continuation composers. Mode guidance now occupies the already-reserved feedback space, retaining pending/error geometry. Task action ordering and labels now match the current source; confirmation/review semantics are unchanged.

The follow-up side panel spans the reserved feedback row so it does not stretch editor/submission heights. Notes use 13px text with 16px normal-weight headings; mobile transcript/dock use the reference gutters.

Changes: CPU model identity, terminal hint, execution heading/tip glyphs, model border/size, starter labels, selected Start indicator, follow-up switch, route-local spacing, report typography, task confirmation geometry/wording/colors. Submission, provider/config gates, draft retention, dictation, attachments, templates, skills, resume, review, scrolling and reading-width state logic are retained.

Verified code gates:

- `npm run typecheck` passed.
- Focused new-task/composer/task-thread Vitest: 36 files, 1,077 tests passed.
- Current full Vitest: 7,982 passed; three unrelated timing failures in destruction-results, delegation-wire-gate and workspace-semaphore. All 35 tests in those files passed on targeted rerun with isolated environment. Latest route/composer subset: 30 files, 954 passed; broader earlier focused pass: 36 files, 1,077 passed.
- `npm run test:unit`: 261 passed.
- `npm run build`: passed including pack gate.
- `npm run test:package`: 27 passed.
- `git diff --check -- packages/web/src`: passed.

`serve-fixture.mjs` runs the built app on port 44636 using an isolated Git repository, isolated CEZ_HOME and only explicit fixture flags/PATH in the child environment. Its session events contain an analogous audit prompt, read/search tools and Markdown report; notes are populated. No real agent or external write is needed. `capture.py` uses the frozen parent PNG manifest and captures each actual state separately. Pillow is needed for density-matched design PNG resizing; `browser.sh` invokes the installed agent-browser.

78 provisional state captures were generated locally against the current iteration-3 PNGs: new-task desktop/mobile/light/dark, revised starters/follow-ups, session/activity, actions/notes/worktree chooser, finish/archive/delete confirmation, three densities × two reading widths × two themes, and seven selectors × two viewports × two themes. `captures.json` and PNGs are committed as explicitly unaccepted review evidence: adapter work still requires final glyph comparison and a final rebuild/recapture. Each capture records its built index SHA256; captures that precede later styling refinements must be refreshed.

Remaining work after parent response:

1. Integrate the shared icon adapter without editing its owned files; replace provisional Lucide glyphs with exact mapped filled outlines.
2. Use only current source hash 56a71a27 and iteration-3 PNGs. Source authority is resolved.
3. Restart the updated populated fixture, rebuild once, recapture all states and inspect every pair; capture menu close/cancel, scrolling/pinned-tail, and persistence behavior.
4. Resolve visual discrepancies and write the final manifest with build hashes, fixture, viewport/theme/density, source hash, pair verdicts and remaining concerns.

Known design/runtime differences to review, not silently remove: existing history boundary; live tool/context/streak grouping instead of a synthetic report card; actual runner/model/catalog values; review panel; extra project selector when multiple projects exist; provider/attachment/dictation errors and preserved feedback space. Revised starters and follow-up preference increase mobile height beyond original frame 1. Frame 14 is task Changes (body owned elsewhere); frames 28/29 are specimen sheets, so actual mutually exclusive overlays are captured as separate states. Reading width remains a persisted narrow/wide preference.

Parent communication limitation: worker progress delivery returned `capacity_limit: Conversation capacity limit reached` on 2026-09-12. Parent last confirmed the exact icon adapter was unavailable and promised its actual contract/commit. No provisional glyph is certified.

## Review package at the current checkpoint

Open `index.html` for all 78 design/browser pairs, `captures.json` for per-pair provenance and verdicts, and `manifest.json` for the checkpoint summary. Every pair was inspected; **none is marked as exact visual acceptance**. The 62 main captures use build `098761cf…` from `c63c5dae`; the 16 mobile new-task captures use build `4a683e9a…` from `8a2571a3`. They predate the behavior-only scroll fix below. The raw PNGs remain portable, and the browser screenshots were not composited or retouched.

Frame18 is a specification sheet and frames28/29 are component specimens. Their runtime comparisons are explicitly identified as such. Opened selectors and mobile confirmations have no dedicated corresponding frame in the exported manifest; their real states are included without claiming a nonexistent whole-frame match. The mobile base-branch menu opens after scrolling its trigger into view; its shared popover measures402.84px at402px viewport and needs the shared owner's clipping check.

### Jump regression found during actual browser checks

`Jump to latest` refreshes paged history, which can remount the transcript. The old hook's in-memory tail intent was lost to the saved away-from-tail position. `824369e0` saves the user's new tail intent before starting the refresh; normal arrival and manual scrolling paths are unchanged. The new remount regression test failed against the old code (120 instead of600), with the ten existing tests passing, then all39 scroll/history tests passed with the fix. Latest focused route/composer run:30 files,955 tests passed. Typecheck:web and production web build passed.

`behaviors.py` exercises the actual built fixture, and `behaviors.json` records seven passing checks: populated notes open, notes close, deletion stays at confirmation, cancellation retains task, jump reaches tail, reading preferences survive reload, and real continuation text is submitted through the dry-run backend. This is a behavior-only fix; no API or run-engine implementation changed.

Remaining exact-fidelity work is blocked on the shared adapter and integrated shell. The parent last confirmed the adapter was unavailable; subsequent progress updates were rejected with `capacity_limit`. Commits ready for parent review: `33bbb415`, `c63c5dae`, `8a2571a3`, `824369e0`. No push, PR, external application launch, or real agent execution occurred.
