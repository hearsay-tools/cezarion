# Issue 522 typography browser report — 2026-09-24

Run `npm run test:e2e` to regenerate the PNGs under `.ai/qa/artifacts_issue-522/`. These screenshots show the selected values at real browser widths. The picker keeps its field prefix when the full label fits its label slot (within 0.5px); otherwise it removes the whole prefix before truncating the value. The 360px long-model pill ends with a visible ellipsis.

| Surface | Selected model | Width | Prefixes visible | Regenerated file |
| --- | --- | ---: | --- | --- |
| New Task | `opencode/muse-spark-1.3-contributor-free` | 375px | Runner, Effort; Model removed | `.ai/qa/artifacts_issue-522/522-new-task-long-375.png` |
| New Task, three columns | `opencode/muse-spark-1.3-contributor-free` | 1440px viewport, 420px sidebar | Runner, Effort; Model removed | `.ai/qa/artifacts_issue-522/522-new-task-long-1440.png` |
| New Task | `grok-4.6` with Pi | 375px | Runner, Model, Effort | `.ai/qa/artifacts_issue-522/522-new-task-short-375.png` |
| New Task, three columns | `grok-4.6` with Pi | 1440px viewport, 420px sidebar | Runner, Model, Effort | `.ai/qa/artifacts_issue-522/522-new-task-short-1440.png` |
| Thread follow-up | `opencode/muse-spark-1.3-contributor-free` | 360px | Runner; Model and Effort removed | `.ai/qa/artifacts_issue-522/522-followup-long-360.png` |
| Thread follow-up | `opencode/muse-spark-1.3-contributor-free` | 906px | Runner, Effort; Model removed | `.ai/qa/artifacts_issue-522/522-followup-long-906.png` |
| Thread follow-up | `opencode/muse-spark-1.3-contributor-free` | 1280px | Runner, Effort; Model removed | `.ai/qa/artifacts_issue-522/522-followup-long-1280.png` |
| Thread follow-up | `grok-4.6` | 360px | Runner, Model; Effort removed | `.ai/qa/artifacts_issue-522/522-followup-short-360.png` |
| Thread follow-up | `grok-4.6` | 906px | Runner, Model, Effort | `.ai/qa/artifacts_issue-522/522-followup-short-906.png` |
| Thread follow-up | `grok-4.6` | 1280px | Runner, Model, Effort | `.ai/qa/artifacts_issue-522/522-followup-short-1280.png` |
| OpenCode command | `grok-4.6` | 906px | Collapsed mono command with ellipsis | `.ai/qa/artifacts_issue-522/522-opencode-command-collapsed.png` |
| OpenCode command | `grok-4.6` | 906px | Expanded full command | `.ai/qa/artifacts_issue-522/522-opencode-command-expanded.png` |

The browser tests in `packages/web/e2e/new-task-picker-layout.e2e.ts` and `task-thread.e2e.ts` assert prefix fit using fractional bounding rectangles. They also verify the collapsed command's ellipsis, tooltip, and expanded content. The long Model value can truncate while sibling prefixes remain; that row-level limitation is tracked in #541.
