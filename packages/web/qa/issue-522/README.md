# Issue 522 browser screenshots

These screenshots show the selected values at real browser widths. The picker keeps its field prefix when the full label fits its label slot (within 0.5px); otherwise it removes the whole prefix before truncating the value. The 360px long-model pill ends with a visible ellipsis.

| Surface | Selected model | Width | Prefixes visible | Screenshot |
| --- | --- | ---: | --- | --- |
| New Task | `opencode/muse-spark-1.3-contributor-free` | 375px | Runner, Effort; Model removed | [PNG](522-new-task-long-375.png) |
| New Task, three columns | `opencode/muse-spark-1.3-contributor-free` | 1440px viewport, 420px sidebar | Runner, Effort; Model removed | [PNG](522-new-task-long-1440.png) |
| New Task | `grok-4.6` with Pi | 375px | Runner, Model, Effort | [PNG](522-new-task-short-375.png) |
| New Task, three columns | `grok-4.6` with Pi | 1440px viewport, 420px sidebar | Runner, Model, Effort | [PNG](522-new-task-short-1440.png) |
| Thread follow-up | `opencode/muse-spark-1.3-contributor-free` | 360px | Runner; Model and Effort removed | [PNG](522-followup-long-360.png) |
| Thread follow-up | `opencode/muse-spark-1.3-contributor-free` | 906px | Runner, Effort; Model removed | [PNG](522-followup-long-906.png) |
| Thread follow-up | `opencode/muse-spark-1.3-contributor-free` | 1280px | Runner, Effort; Model removed | [PNG](522-followup-long-1280.png) |
| Thread follow-up | `grok-4.6` | 360px | Runner, Model; Effort removed | [PNG](522-followup-short-360.png) |
| Thread follow-up | `grok-4.6` | 906px | Runner, Model, Effort | [PNG](522-followup-short-906.png) |
| Thread follow-up | `grok-4.6` | 1280px | Runner, Model, Effort | [PNG](522-followup-short-1280.png) |
| OpenCode command | `grok-4.6` | 906px | Collapsed mono command with ellipsis | [PNG](522-opencode-command-collapsed.png) |
| OpenCode command | `grok-4.6` | 906px | Expanded full command | [PNG](522-opencode-command-expanded.png) |

The browser tests in `packages/web/e2e/new-task-picker-layout.e2e.ts` and `task-thread.e2e.ts` assert the prefix fit using fractional bounding rectangles and verify the collapsed command's ellipsis, tooltip, and expanded content.
