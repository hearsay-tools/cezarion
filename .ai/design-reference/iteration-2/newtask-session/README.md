# New task / session — iteration 2 work in progress

Code pass only. **Visual acceptance remains open.** The authoritative parent `.pen` changed externally from `37378246893ba6259088ec3ddb2702e4220f44ca643ac13e5ac293263021a74b` to `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8` during this run. Parent confirmation and the shared exact filled-icon adapter are requested. The frozen design PNG manifest still identifies the former source.

Changes: CPU model identity, terminal hint, execution heading/tip glyphs, model border/size, starter labels, selected Start indicator, follow-up switch, route-local spacing, report typography, task confirmation geometry/wording/colors. Submission, provider/config gates, draft retention, dictation, attachments, templates, skills, resume, review, scrolling and reading-width state logic are retained.

Verified code gates:

- `npm run typecheck` passed.
- Focused new-task/composer/task-thread Vitest: 36 files, 1,077 tests passed.
- Full Vitest: 7,981 passed; four failures in unrelated environment-sensitive files. Reran the three failed files with `env -u TMP -u TEMP -u CEZ_AUTOMATIONS TMPDIR=/tmp npm test -- packages/web/src/test/fixture-serve-env.test.ts packages/cezar/src/workflows/delegation-wire-gate.test.ts packages/cezar/src/server/projects-api.test.ts`: all 45 tests passed. Two original failures were Git discovery from the worktree-local TMPDIR, one inherited automations flag, one process-polling timeout.
- `npm run test:unit`: 261 passed.
- `npm run build`: passed including pack gate.
- `npm run test:package`: 27 passed.
- `git diff --check -- packages/web/src`: passed.

`serve-fixture.mjs` runs the built app on port 44636 using an isolated Git repository, isolated CEZ_HOME and only explicit fixture flags/PATH in the child environment. Its session events contain an analogous audit prompt, read/search tools and Markdown report; notes are populated. No real agent or external write is needed. `capture.py` uses the frozen parent PNG manifest and captures each actual state separately. Pillow is needed for density-matched design PNG resizing; `browser.sh` invokes the installed agent-browser.

78 provisional state captures were generated locally: new-task desktop/mobile/light/dark, revised starters/follow-ups, session/activity, actions/notes/worktree chooser, finish/archive/delete confirmation, three densities × two reading widths × two themes, and seven selectors × two viewports × two themes. `captures.json` and PNGs are intentionally not accepted or committed yet: adapter work and the source decision require a final rebuild/recapture. Some captures precede the final confirmation color change.

Remaining work after parent response:

1. Integrate the shared icon adapter without editing its owned files; replace provisional Lucide glyphs with exact mapped filled outlines.
2. Resolve source authority and regenerate pairs if needed.
3. Restart the updated populated fixture, rebuild once, recapture all states and inspect every pair; capture menu close/cancel, scrolling/pinned-tail, and persistence behavior.
4. Resolve visual discrepancies and write the final manifest with build hashes, fixture, viewport/theme/density, source hash, pair verdicts and remaining concerns.

Known design/runtime differences to review, not silently remove: existing history boundary; live tool/context/streak grouping instead of a synthetic report card; actual runner/model/catalog values; review panel; extra project selector when multiple projects exist; provider/attachment/dictation errors and preserved feedback space. Revised starters and follow-up preference increase mobile height beyond original frame 1. Frame 14 is task Changes (body owned elsewhere); frames 28/29 are specimen sheets, so actual mutually exclusive overlays are captured as separate states. Reading width remains a persisted narrow/wide preference.
