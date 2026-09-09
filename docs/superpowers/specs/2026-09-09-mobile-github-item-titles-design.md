# Mobile GitHub Item Titles Design

## Goal

Make GitHub issue and pull-request rows distinguishable at phone width by showing up to two title lines, while retaining the current single-line desktop list, selection, filtering, and resize behavior.

## Audience and context

- **Who:** engineers and operators who already understand GitHub issues and pull requests.
- **Context stress:** scanning a dense list one-handed on a 360px phone, potentially in low light, where several titles may share the same opening words.
- **Job:** identify and select the intended issue or pull request without opening every candidate.
- **Success:** the distinguishing part of a long title is visible on mobile and every existing desktop/list interaction behaves as before.

## Design

GithubRow remains one linked row with the existing title, metadata, and label groups. Below the md breakpoint, the title uses a two-line clamp and the leading issue/pull-request icon aligns with the first title line. At md and above, the title explicitly returns to a block-level, single-line ellipsis so the resizable desktop column keeps its current density and behavior.

The metadata group remains beneath the title and gains wrapping with a small row gap at phone width. Identifiers, author, age, comment/check status, and the queued marker stay separate inline items; the existing label group remains on its own wrapping row. This preserves DOM order and accessible link behavior while preventing metadata, labels, and title text from occupying the same line box.

No component contract, route, state, query, filtering, selection, drag, or persistence behavior changes. No dependency or artwork is added.

## State and interaction review

The route's loading, empty, search-in-progress, search-error, unavailable, success, and selected-detail states remain unchanged. The row layout applies whenever item data renders and does not introduce an additional state. Offline/conflict handling is not applicable to this read-only row presentation. Existing focus, drag-to-composer, hover prefetch, selection, and resize interactions remain intact. No new animation is introduced, so motion and reduced-motion behavior are unchanged.

## Verification

A real-browser regression will replace a rendered issue title and author with deliberately long text, then inspect layout geometry rather than utility-class names. At 360×640 in light and dark themes it will prove the title occupies two lines but no more, the icon aligns to the first line, metadata wraps below the title, labels remain below metadata without overlap, and the document has no horizontal overflow. At 1440×900 in both themes it will prove the title and metadata remain one line with ellipsis and the list retains its configured desktop width.

Existing focused component tests continue to cover deep-link selection, filtering, mobile list/detail switching, and pointer/keyboard desktop resizing. Full repository verification and the GitHub e2e suite provide the regression gate.
