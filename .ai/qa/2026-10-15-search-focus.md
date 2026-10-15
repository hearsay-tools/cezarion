# Search picker focus — hearsay-tools/cezarion#1023

The original focus rule shipped in hearsay-tools/cezarion#942, merge
`42d33625cd3ab4b922a62057b8e0c084e39d8268`. The branch search combined a
fixed 192px input with a sibling icon, so the global input outline framed
only part of the control. The shared command search had the same input-only
frame. The code editor's transparent inner outline also became visible in
forced colors, alongside its wrapper outline. The composer already received
its corresponding correction in hearsay-tools/cezarion#966.

The search rows now own an inset focus outline, including the icon. The
branch input expands into the available width while the row supplies its
minimum width. Command search retains enough height for its input and inherits
the container's upper corner radii so clipping does not cut the outline.
Forced colors use Highlight on each wrapper and suppress the inner outline.
No event handlers, filtering or focus-management code changed.

## Regression evidence

Before implementation, the new browser checks failed against the original
sources: branch and skill search wrappers computed `outline-style: none`;
the code editor's inner outline computed `2px` under forced colors instead
of `0px`. Failure bundles remain locally under `.ai/qa/failures/search-focus/`
and `.ai/qa/failures/good-css/`.

After implementation:

- `npm run typecheck:web` passed (includes fresh server declarations).
- `npm run test:e2e -- search-focus.e2e.ts new-task.e2e.ts good-css.e2e.ts`
  passed: 3 files, 41 tests. This is focused coverage, not a full-suite result.
- `search-focus.e2e.ts` covers branch and skill pickers at 1440×900 and
  360×640, in light, dark and forced-colors modes. It measures full-width input
  geometry, inset wrapper outlines, one visible frame, icon inclusion,
  separation from results, unchanged row height during filtering, and at least
  3:1 outline contrast. A real long branch widens the desktop menu beyond 400px.
- Existing branch tests exercise autofocus, filtering, hover focus retention,
  empty results, ArrowDown/ArrowUp, selection, persistence, and Escape dismissal.
- Existing code-editor checks now also reject a duplicate inner outline under
  forced colors in both themes.
- Governed read-only worker `3ddec921-202a-4b24-8046-0fe699073e4d` reviewed the
  latest changes and reported no actionable findings; its settled result was
  collected and its owned worktree and branch destroyed.

Screenshots under `.ai/qa/artifacts_e2e/search-focus/` were inspected for the
mobile branch picker and desktop skill picker. Both show a complete search
frame with the icon inside and results below. Existing loading, empty, error
and disabled states retain their behavior. No imagery or motion is needed
for this focus correction; existing reduced-motion checks pass.

CI owns the complete repository gate. Real Safari/device QA was not performed.
