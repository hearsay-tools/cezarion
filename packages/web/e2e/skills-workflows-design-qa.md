# Skills and Workflows — design.pen verification

Issue #224, continuing the approved PR #227 baseline. Scope: Skills and Workflows only.

Audience: developers selecting playbooks or editing a reusable task chain while switching
between projects. Success means reading a skill or preparing a workflow without losing the
selection/draft or needing horizontal scrolling. No art: these reference frames use document
content and functional icons as their visual anchors.

## Frame mapping

| Reference frames | Implemented structure and evidence |
| --- | --- |
| 10A/B (`JfXUf`, `WygR0`) | Page heading and catalog actions; full-width filter/Refresh; separate catalog and reader cards; selected row, source label, usage and Markdown hierarchy. |
| 10C/D (`md67O`, `FaZPm`) | Stacked heading/actions/filter; full-width catalog rows. Existing URL-driven list/detail navigation is preserved rather than displaying the entire catalog above every mobile reader. |
| Mobile skill detail (`fR8Bl`, `UUyVL`) | Reader card and back link, wrapping title/source, usage and Markdown. |
| Manage skills (`QGPE7`, `x3aaN`, `n0DGX`, `rIXH7`) | Source eyebrow, heading, workspace scope, update card, filter/bulk action, separated checkbox rows. Existing optimistic persistence and update operations retained. |
| Run from GitHub (`LT4cB`, `tAPGJ`, `g3NKCA`, `M5Ynqs`) | Catalog-wide action and card container integrated; existing bookmarklet component renders within it. Inner component is owned by the Settings worker, not changed here. |
| 11A/B/C/D (`S446C7`, `e0YGQ`, `DZvRy`, `vLA8k`) | Page action, native workflow selector, full-width labeled name/description, toolbar, numbered step cards, Add step, save footer, available-skills card and disclosed YAML. Narrow/mobile adds explicit reorder buttons. |
| Workflow Auto (`jb9Yb`, `VS5gA`, `mU8TX`, `AjVTx`) | Full-width prompt builder between metadata/actions and editor; draft explanation, input, Build/Cancel and review-before-save note. |

The 820px Narrow reading measure is preserved. Wide consumes the existing 1180px measure;
columns respond to the available container width, not the window alone. Functional drag and
remove buttons remain visible even where the reference simplifies them to an ellipsis.

## Automated verification

- `npm run build:server` → passed.
- `npm run typecheck:web` → passed.
- `npm run build:web` → passed.
- `npx vitest run --project web packages/web/src/routes/skills.test.tsx packages/web/src/routes/workflows/workflows.test.tsx packages/web/src/routes/settings/skills-section.test.tsx packages/web/src/lib/skills.test.ts packages/web/src/lib/workflow-builder.test.ts` → 125 tests passed.
- New selector/description and non-drag ordering tests were run first against the old implementation: both failed on the missing controls, then passed after implementation.
- Existing workflow E2E selectors were updated for the native selector and YAML disclosure. The repository's agent-browser E2E suite was not run; browser checks below used standalone Playwright against the built dry-run cockpit with intercepted skill/workflow fixtures.

## Browser evidence

Captured Skills, selected detail, Manage skills, bookmarklets, Workflows, and Auto in light/dark
at 1440px Narrow, 1440px Wide, and 360px Narrow, Comfortable density. Layout/overflow measurements
use 1440×1100 and 360×640; long captures extend viewport height to include the whole editor.
All 36 page boxes fit horizontally. In the two mobile bookmarklet cases, internal `bm-link` and
`bm-copy` controls extend beyond the viewport; this was reported to the parent for the Settings
owner to fix. The other 34 cases have no internal overflow. Browser interactions verified description edits in YAML,
step ordering and opening the source disclosure. The Wide reorder check invoked the hidden
button programmatically; actual click checks ran at Narrow/mobile, where those controls display.

Additional checks used reduced motion at 360×640 and 200% CSS zoom at 720×640. Save retained visible
keyboard focus, the page fit horizontally, and sampled save/drag/remove/add targets measured at
least 44×44 CSS pixels (88×88 at 200%).

Evidence for the parent integration review:
`/tmp/skills-workflows-evidence/` contains named PNGs, `findings.json`, and the two reduced-motion
captures. Driver scripts: `/tmp/skills-workflows-qa.cjs` and
`/tmp/skills-workflows-accessibility.cjs`. Logs: `/tmp/scoped-tests-final.log`,
`/tmp/scoped-typecheck-final.log`, `/tmp/scoped-build-final.log`,
`/tmp/skills-workflows-browser-final.log`, and `/tmp/skills-workflows-accessibility.log`.

## Integration limits

Shared shell, breadcrumb, font/weight and primitive styling remain the parent's ownership; this
worker's screenshots show the baseline shell. Bookmarklet internals remain the Settings worker's
ownership. Recheck these screens after integration. This is structural fidelity with existing
capabilities retained, not a claim of pixel-identical fixture content or whole-app validation.
