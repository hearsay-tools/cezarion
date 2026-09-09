# Mobile Git Page Headings Design

## Goal

Show one visible page title on mobile Git and GitHub routes while preserving route semantics, repository context, desktop headers, and all existing behavior.

## Audience and context

- **Who:** developers and operators who understand Git and GitHub repository workflows.
- **Context stress:** checking repository state one-handed on a 360px phone, potentially in low light, where duplicate headings consume the first viewport.
- **Job:** reach branch/repository context, controls, and the first content row without losing page orientation.
- **Success:** the mobile shell is the only visible page title, route headings remain accessible, and desktop presentation is unchanged.

## Design

Keep the existing semantic `h1` in each Git and GitHub route header. Below the `md` breakpoint, make only the route title visually hidden; at `md` and above, restore its existing visible typography. The mobile shell title remains unchanged and supplies the single visible title on phones. Branch and repository context remain in the route headers next to their relevant controls.

Do not change component contracts, shell title resolution, navigation, data queries, loading/empty/error/success states, controls, motion, or responsive pane behavior. Reuse the current typography, spacing, and breakpoint vocabulary. No dependency or artwork is added.

## State and interaction review

Git loading, not-a-repository, changes, commits, and branches states remain unchanged. GitHub loading, unavailable, empty, search, list, and detail states remain unchanged. Offline/conflict behavior is not affected by this presentation-only change. No input, target, focus, animation, or reduced-motion behavior changes.

## Verification

A real-browser regression will inspect rendered visibility and geometry at 360×640 and 1440×900 in light and dark themes. It will prove that exactly one `Git` or `GitHub` page title is visibly rendered on mobile, the semantic route `h1` remains in the accessibility tree, branch/repository context stays visible, the first route content row is unobscured, and desktop route titles remain visible. Focused component tests will continue to pin route heading semantics and context. Full repository verification remains required.
