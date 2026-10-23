# Confirm Markdown links outside contained rows

Transcript link text can come from an agent reading untrusted content. Keep an explicit
confirmation that shows the full destination before navigation. Use the application’s portalled
alert dialog for that confirmation, outside transcript rows with rendering containment.

## Consequences

The dialog remains viewport-positioned and provides focus and accessible description behavior.
Disabling confirmation would avoid the overlay problem but remove destination review. The
custom renderer must still call the Markdown library’s confirm and close callbacks; it changes
the dialog location, not the link decision. Keep protocol and href validation at their own
boundaries as well.

## Considered Options

- **Use an inline fixed overlay inside each message.** Rejected because contained rows can position and clip it.
- **Disable link confirmation.** Rejected because displayed agent prose does not establish that a destination is safe.

Implementation: [link-safety-dialog.tsx](../../packages/web/src/routes/task-thread/link-safety-dialog.tsx), [markdown.tsx](../../packages/web/src/routes/task-thread/markdown.tsx).

Coverage: [markdown.test.tsx](../../packages/web/src/routes/task-thread/markdown.test.tsx).
