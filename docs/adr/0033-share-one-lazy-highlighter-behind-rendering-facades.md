# Share one lazy highlighter behind rendering facades

Read-only code surfaces share one Shiki core instance with the JavaScript regex engine.
Load the core, engine and explicit grammar allowlist on demand. Unknown fence languages render
as plaintext. One CSS-variable theme lets existing tokens follow appearance changes without
running tokenization again.

## Consequences

The Diff facade owns its props and lazy-loads the local renderer. A plain patch fallback
uses the same props when the chunk fails. Markdown uses a plugin over the shared highlighter
instead of adding another highlighting pipeline. Consumers do not import a diff engine directly.

Historical context: the implementation comment records an evaluation of `@pierre/diffs` 1.2.12
that rejected its separate highlighter and theme pipeline. That explains the local renderer;
it is not a claim about current versions of that library. The earlier technology research
proposed that library before the implementation evaluation.

The rationale is present in commit `5493efe038a303e382e32fc05e78a89e00f4dd9c` before the package move. It records the old evaluation rather than re-verifying that library today.

## Considered Options

- **Use the evaluated diff library.** Rejected at that version because the recorded integration did not meet the shared-highlighter boundary.
- **Load the full Shiki bundle or a second highlighter plugin.** The implementation instead keeps one core and explicit lazy grammars.

Implementation: [diff.tsx](../../packages/web/src/components/diff/diff.tsx), [highlighter.ts](../../packages/web/src/lib/highlighter.ts), [markdown.tsx](../../packages/web/src/routes/task-thread/markdown.tsx), [diff-highlight-tech.md](../../.ai/analysis/cockpit-ui-redesign/diff-highlight-tech.md).

Coverage: [highlighter.test.ts](../../packages/web/src/lib/highlighter.test.ts), [diff.test.tsx](../../packages/web/src/components/diff/diff.test.tsx).
