# Owned geometry and mobile project navigation closeout

Implementation: `2f602324`, separate from unchanged `5ab8ba8d`. This report supersedes the remaining-owned-geometry and missing-mobile-picker findings in the earlier independent/checkpoint reports.

Built from frozen parent `b87b5082` (including current shared controls `6a7d1591` and shared popover `4ed1a848`) plus `5ab8ba8d` and the exact `capture-source.patch`. Approved source SHA256 is `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8` (193 frames). Both isolated populated CLI fixtures served assets matching every on-disk index/asset hash; `final-proof.json` records both process command lines, source hashes, frozen capture hashes and measurements.

## Closed findings

- Step number badges use the source's 5px corners. Workflow actions, Add step, reorder, save, Auto and View YAML use measured icon gaps and border-compensated padding. Removed View YAML's doubled icon margin. Import measures 88.516px versus 88.5px source glyph advance plus padding.
- Workflow canvas and palette use the source padding, line boxes and footer separation. Desktop canvas height 493px; mobile 695px; palette 455px in both widths. Auto heights are 324px desktop and 384px mobile.
- Same-content catalog row stacks, Markdown paragraph/list spacing and reader heights match: desktop catalog 788px, reader 465px; mobile reader 614px. Manage rows use 21px name/19px description line boxes; Manage reader heights are 761px desktop and 984px mobile. The 13px introductory paragraph uses 21px line height instead of accidentally inheriting the smaller paragraph rule.
- The mobile project name/folder/chevron is a real 44px button opening the existing shared project drawer. Pointer and Enter open it, Escape returns focus to the actual opener, selecting another project navigates and updates the header. Both themes pass real browser checks; menu-trigger focus behavior remains intact. No API changes.
- Mobile catalog divider restored; bookmarklet wrapper no longer highlights an unrelated selected skill.

The full source-left/browser-right pairs were visually inspected, including changed Manage, catalog, Workflow and Auto views. Measured panel heights above match exactly; top origins differ by less than 0.25px (browser layout subpixels). Source and bundled Poppins Medium glyph advances were checked and agree. Rasterization remains visibly different; it is not used to excuse geometry.

## Evidence and scope

`index.html` links 22 final paired views (Skills catalog/reader, Manage, Workflows, Auto, four bookmarklet wrappers), with four additional selector interaction captures in `pairs.json`. Native select popups are not faithfully included by Chromium screenshots; these captures are not claimed as popup pixel proof. The prior independent evidence retains the four import frames and unchanged shell desktop/mobile/theme/menu/R1 and behavior acceptance; no unnecessary full rerun was performed.

Validation logs: 194 scoped tests across shell/project groups/session list/Skills/Workflows; final route rerun 46 tests; web typecheck and build pass. The new project-picker regression fails without its source fix (red log retained). Real browser pointer/keyboard/project navigation/focus checks pass both themes. Full-suite verification remains worker86's scope.

## Genuine remaining design coverage gaps

Waiting counts, More links, ordinary session ages and persistent footer version are existing capabilities omitted by the source compositions; they remain visible/functional. Actual project/session data and command summaries are rendered faithfully, with no illustrative API values substituted. First/last reorder controls correctly disable impossible moves despite illustrative source enabled states.

Bookmarklet inner content, Settings, Git/GitHub backdrops, task/session/plan pages, EnginePills, PromptTemplateMenu and DiffStatLabel remain other owners' scope. Their appearance in wrappers/backdrops is not acceptance of those surfaces. There are no known remaining correctable owned findings from this closeout; this is not a global 193-frame signoff.
