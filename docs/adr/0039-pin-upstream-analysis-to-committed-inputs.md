# Pin upstream analysis to committed inputs

Upstream scans append decisions to a canonical YAML ledger and derive Markdown from it.
Fetch upstream into a dedicated ref instead of adding a remote that could change repository
discovery for normal cockpit work. Resolve the target commit once and analyze that snapshot.

## Consequences

Scan Git calls select attributes from the pinned tree. Dry-run application and reachability
use a private index and extracted files, leaving the live index and uncommitted changes out.
The global attribute option must be supported; an ignored environment variable would silently
restore untrusted working-tree attributes.

Reachability includes static type-only imports that a bundler would otherwise erase. Generated
ledger fields retain source provenance. Scanning proposes pending rows for review; it does not
authorize automatic ports or rewrite history. Historical observations of gh remote preference
explain the ref choice, but are not a guarantee about every current gh version.

Commit `eadd0633585232ea637799560805b6f50af85992` records the dedicated-ref choice and
its original discovery observation.

## Considered Options

- **Add an upstream remote.** Avoided to keep normal forge discovery attached to the fork.
- **Use git archive for the scratch tree.** The private-index checkout shares the analyzed tree and does not honor export-ignore exclusions.

Implementation: [upstream-scan.cjs](../../.github/scripts/upstream-scan.cjs), [upstream-reachability.cjs](../../.github/scripts/upstream-reachability.cjs), [README.md](../../.ai/upstream/README.md).

Coverage: [upstream-ledger.test.cjs](../../.github/scripts/upstream-ledger.test.cjs), [upstream-targets.test.cjs](../../.github/scripts/upstream-targets.test.cjs).
