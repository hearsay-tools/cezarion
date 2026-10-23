# Bound filesystem access and OS handoffs

A browser filesystem picker checks lexical containment before disk access, then canonical
containment after resolving symlinks. Returned entries must remain inside the browse root.
Worktree file routes have their own containment and content limits. Do not equate a path that
looks contained with a file that resolves there.

## Consequences

Browser image delivery and OS file opening have different trust boundaries. The OS route
permits raster files only; SVG’s browser response protections do not follow a file into its
default application. Launch files through platform executables and argument arrays, avoiding
a shell that reinterprets repository filenames.

Terminal takeover validates session ids and renders account environment assignments for the
actual platform. Unsafe values refuse the handoff. Persist assignments in the terminal session
so the user’s next native command keeps the chosen account. These are local handoffs, not a
remote browser capability.

## Considered Options

- **Use lexical containment alone.** Rejected because a symlink can resolve outside the allowed root.
- **Reuse the HTTP image allowlist for OS opening.** Rejected because the OS path lacks the HTTP response content policy.
- **Use POSIX quoting on every platform.** Rejected because Windows command syntax differs.

Implementation: [fs-browse.ts](../../packages/cezar/src/server/fs-browse.ts), [git-changes.ts](../../packages/cezar/src/server/git-changes.ts), [open-in-app.ts](../../packages/cezar/src/server/open-in-app.ts), [shell-env.ts](../../packages/cezar/src/core/shell-env.ts).

Coverage: [fs-browse.test.ts](../../packages/cezar/src/server/fs-browse.test.ts), [open-in-app.test.ts](../../packages/cezar/src/server/open-in-app.test.ts), [shell-env.test.ts](../../packages/cezar/src/core/shell-env.test.ts).
