# Inline private contracts in the published CLI

The service is published, while contract, api-client and cockpit packages are private
workspace source consumers. A runtime contract import in the CLI cannot depend on an
unpublished package. The postbuild step therefore bundles contract code and emits declarations
inside the service artifact, then rewrites emitted root and subpath references.

## Consequences

Source dependencies retain the workspace graph. The cockpit builds into the service’s static
assets. The packaging gate must check runtime and declaration resolution, not only compilation.
Remove inlining when the contract is published or no runtime import remains.

Release scripts separate pure version/channel decisions from publishing effects. They stamp
private packages but publish only eligible packages in dependency order. Snapshots use explicit
non-latest tags; the stable workflow alone uses `latest`. An interrupted publish can leave some
package tags ahead, so dependent publication must follow its dependencies.

A file-list packaging check cannot prove that rewritten declaration imports resolve. The
packaged test checks runtime specifiers and declarations, including a consumer probe with
`skipLibCheck` disabled.

Every subpath repoints to one bundle, which exports only the names the contract index
re-exports. The postbuild step therefore links the emitted JavaScript against the bundle and
fails the build when an import names a value the bundle lacks.

Implementation: [inline-contract.mjs](../../packages/cezar/scripts/inline-contract.mjs), [release.mjs](../../scripts/release.mjs), [release-snapshot.mjs](../../scripts/release-snapshot.mjs), [stable.ts](../../packages/cezar/src/release/stable.ts).

Coverage: [stable.test.ts](../../packages/cezar/src/release/stable.test.ts), [snapshot.test.ts](../../packages/cezar/src/release/snapshot.test.ts), [inline-contract.test.ts](../../packages/cezar/test/e2e/inline-contract.test.ts), [inline-contract-check.test.ts](../../packages/cezar/src/inline-contract-check.test.ts).
