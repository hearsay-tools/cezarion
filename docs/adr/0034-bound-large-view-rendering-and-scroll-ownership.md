# Bound large views and keep one scroll owner

Transcripts and diffs can grow beyond a user-controlled size. Keep small views in normal
flow with off-screen rendering containment, then virtualize above measured thresholds to
bound mounted DOM. Pure helpers own thresholds and scroll rules; renderer mode overrides
allow both paths to be measured over the same content.

## Consequences

The diff virtualizes file cards so sticky headers, lazy file tokenization and per-file state
remain coherent. A single enormous file still needs row containment; card virtualization alone
does not bound it. Transcript scroll restoration uses stable row identity when history pages
change, and follows streaming output only near the tail.

A page has one vertical scroll owner. Controls and docks must not introduce a second transcript
viewport. Contained rows also require overlays to portal outside their containing blocks.
Keep nearby sizing, timing and measurement notes that a maintainer needs to preserve this behavior.

## Considered Options

- **Virtualize every diff line.** Rejected because headers would lose their file-sized sticky range and state would move to a finer unit than the UI exposes.
- **Keep every large view flat indefinitely.** Containment reduces rendering work, but only virtualization bounds the mounted DOM.

Implementation: [diff-scroll.ts](../../packages/web/src/components/diff/diff-scroll.ts), [thread-scroll.ts](../../packages/web/src/routes/task-thread/thread-scroll.ts), [thread-scroller.tsx](../../packages/web/src/routes/task-thread/thread-scroller.tsx).

Coverage: [diff-scroll.test.ts](../../packages/web/src/components/diff/diff-scroll.test.ts), [thread-scroll.test.ts](../../packages/web/src/routes/task-thread/thread-scroll.test.ts).
