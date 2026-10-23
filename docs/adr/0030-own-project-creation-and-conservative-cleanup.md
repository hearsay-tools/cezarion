# Own project creation and clean up conservatively

Clone and create operations target one validated name directly below the checkout root.
Reserve that directory with non-recursive mkdir; success establishes that this attempt created
it. Failed local work may remove only a real, non-symlink direct child whose canonical parent
still equals the checkout root. Ambiguous ownership leaves files in place.

## Consequences

New local projects get an empty initial commit so task worktrees have a base. GitHub creation
is explicit and always private. Once a remote effect has succeeded, retain useful local work
and report recovery steps instead of deleting an external repository whose creation cannot be
proved. A failed template clone may still clean its partial local directory and name the remote
that remains. Registry writes stay with the route layer.

These filesystem checks bound accidental cleanup. They are not an atomic defense against every
same-user path replacement between a check and removal.

## Considered Options

- **Recursively create or blindly remove the requested path.** Rejected because a network failure must not authorize deletion of pre-existing content.
- **Create public repositories by default.** Rejected because accidental public exposure cannot be undone by later cleanup.

Implementation: [checkout.ts](../../packages/cezar/src/server/checkout.ts), [create-project.ts](../../packages/cezar/src/server/create-project.ts).

Coverage: [checkout.test.ts](../../packages/cezar/src/server/checkout.test.ts), [create-project.test.ts](../../packages/cezar/src/server/create-project.test.ts).
