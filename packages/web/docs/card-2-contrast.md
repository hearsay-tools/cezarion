# Small text on card-2

Use at least **4.5:1** contrast for text under 14 px on `bg-card-2`.
The normal-text AA rule also applies to larger text until it meets WCAG's
large-text threshold (24 px regular or about 18.67 px bold).

These ratios use the opaque default palette in `src/styles/index.css`,
with `--card-2` resolving to `--surface-muted`. Both themes must pass.
Dark ratios reflect the lifted H1b palette in hearsay-tools/cezarion#1909.
Opacity, overlays, hover surfaces and custom colors require a separate measurement.

| Foreground utility | Dark | Light | Safe in both themes? |
| --- | ---: | ---: | --- |
| `text-foreground` | 10.12:1 | 15.66:1 | Yes — primary text |
| `text-muted-foreground`, `text-supporting-foreground` | 5.70:1 | 6.60:1 | Yes — secondary text |
| `text-link-foreground` | 7.60:1 | 4.80:1 | Yes — links |
| `text-signal-word-red` | 5.11:1 | 5.67:1 | Yes — red words |
| `text-soft-foreground` | 4.56:1 | 4.37:1 | No — use muted-foreground |
| `text-danger`, `text-destructive` (alias) | 4.34:1 | 4.24:1 | No — use signal-word-red |

Icons and non-text graphics have a separate 3:1 requirement; these text rules
do not prohibit their use of danger.

## Reproduction and guard

Reproduced for hearsay-tools/cezarion#1133 at `3040cbf78`:
open `src/routes/task-thread/thread-items.tsx`, find `data-slot="tool-error"`,
and follow its parent `bg-card-2`. The body uses `text-xs text-danger`.
Resolve the foreground and background tokens from `src/styles/index.css`, convert
OKLCH to linear sRGB, and calculate `(lighter luminance + .05) / (darker luminance + .05)`.
This yields 4.05:1 dark and 4.24:1 light. Substituting soft-foreground yields
4.88:1 dark and 4.37:1 light. For rendered measurements, use
`e2e/contrast.ts`'s `contrastSampleExpression` on the expanded tool-error element.
The initial baseline also records the small step number and Remove hover text in
`routes/plan-review.tsx`, settings section descriptions in `routes/settings/settings-shell.tsx`,
and project-link details in `routes/unknown-project.tsx`. The latter two inherit card-2
on hover. All five instances predate this guard; the ratchet applies after this initial baseline.
The existing tool-error fix belongs to hearsay-tools/cezarion#1114.

`src/test/card-2-contrast.test.ts` scans JSX class strings, including literal
branches of class helpers and templates. It follows card-2 ancestors, inherited
ink, font sizes and named font weights, and known tool/hook body slots. A named opaque palette background ends inheritance; transparent/translucent
backgrounds, images, and background layout utilities retain it conservatively. Literal size/background branches are checked
conservatively, including empty/absent class branches. Expansion is capped at 128
combinations with a conservative fallback. JSX-only expressions are visited as elements rather than wrapper text. Unknown font sizes are treated conservatively as
small. Known pixel/Tailwind sizes qualify as large at 24 px regular or 18.67 px
with bold, extrabold or black weight; unknown weights grant no bold exemption.
Important modifiers, fully opaque background suffixes (`/100`, `/[1]`, `/[100%]`),
and opacity suffixes on unsafe ink are normalized; reducing
these colors’ opacity cannot grant a contrast exemption. Variant-prefixed ink, size, weight and card-2 utilities are checked as possible
states alongside the default state; variant backgrounds cannot grant an opaque-surface exemption. Icons without text and explicitly large text are excluded.

This is a static guard, not a computed-style audit: runtime-generated classes,
component boundaries and CSS rules still need rendered contrast checks.
The baseline identifies existing instances by file and opening JSX, including
counts through duplicate entries. Remove an entry when fixing its instance;
never add allowances. The test rejects new instances and stale baseline entries.
