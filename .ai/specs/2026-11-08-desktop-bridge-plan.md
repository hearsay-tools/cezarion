# Desktop identity bridge — hearsay-tools/cezarion#2974

The shipped switch stays false. Desktop build metadata comes from the shared
product identity command. An explicit bridge build retains the old identifier
and embeds the new app artifact. It does not fetch an unsigned payload.

Coordinator decisions D8/D11 pin both sidecar control aliases in both builds.
D12 limits automatic installation/removal to macOS apps, Windows per-user NSIS
installs and Linux AppImages. DEB/Arch keep the old app usable and show manual
package-manager instructions. The updater library can install DEBs with privilege;
the bridge must refuse that route, irrespective of manifest selection.

## Transfer cases

| Case | Required durable outcome |
| --- | --- |
| Ordinary switch-off build | Existing config, feed, artifacts and home paths |
| Switch-on build | Squawk ID, display name, separate feed and artifact names |
| Bridge receives unsupported install | No installation, transfer or removal; dismissible notice; old app works |
| Installer fails | Source app and source state untouched; retry possible |
| Source profile still in use | Refuse transfer; source remains usable |
| Destination conflicts | Refuse overwrite; source and destination remain usable |
| Transfer fails midway | Remove only destinations created by this attempt; source untouched |
| App fails to start/acknowledge | Keep source app and state; retain transfer journal for retry |
| New app acknowledges | Record acknowledgement before old-app removal |
| Removal fails | Keep acknowledgement; retry removal without copying new state again |
| Completed bridge repeats | No copy, duplicate connection or profile overwrite |
| macOS 14+ | Copy full WebKit UUID store, preserving cookies and site storage |
| macOS 12/13 | No persistent remote profile exists; preserve saved connections |
| Linux/Windows | Copy complete closed profile directory for each connection UUID |
| Existing old managed package | Continue opening it after the rename |
| New HSQ env is empty | Presence wins; never fall through to CEZ |

The bridge copies geometry to the new state root, connections to the new state
root, and Linux/Windows profiles to the new data root. macOS WebKit stores live
outside those roots at `~/Library/WebKit/<bundle-id>/WebsiteDataStore/<UUID>`.
UUIDs, endpoints and sign-in origins stay unchanged. Source state remains in
place after completion. A journal prevents a retry from replacing state that
the new app has changed. The bridge runs before it opens any webview.

A real macOS CI fixture must seed an HTTP cookie and local storage under the old
ID, close the app, transfer the store, then read both under the new ID. A byte
copy fixture alone does not prove authenticated state survives.

No release, feed or tag is published by development validation. Workflow edits
require owner approval. macOS notification and automation grants return for the
new bundle identifier; the app has no app-managed Keychain/password store.
