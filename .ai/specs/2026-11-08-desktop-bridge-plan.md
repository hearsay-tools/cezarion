# Desktop identity bridge — hearsay-tools/cezarion#2974

The shipped switch stays false. Desktop build metadata comes from the shared
product identity command. An explicit bridge build retains the old identifier
and embeds the new app artifact. It does not fetch an unsigned payload.

Coordinator decision D13 selects the legacy managed root until migration commits,
including empty/incomplete roots that need repair. This keeps the running files
outside the target tree that migration replaces.

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
| NSIS leaves an incomplete directory | Retry repairs the bridge-owned install; completion requires verified identity and registry location |
| Windows destination contains spaces | Pass trailing raw unquoted /D=; verify actual registry install location |
| Connection added/forgotten before acknowledgement | Replan the union with stable indices; retain earlier private profile snapshots |
| Source profile still in use | Refuse transfer; source remains usable |
| Destination conflicts | Refuse overwrite; source and destination remain usable |
| Transfer fails midway | Retain verified bridge copies for retry; source untouched; independent destination edits protected |
| App fails to start/acknowledge | Keep source app and state; retain transfer journal for retry |
| New app acknowledges | Record acknowledgement before old-app removal |
| Removal fails | Keep acknowledgement; retry removal without copying new state again |
| Completed bridge repeats | No copy, duplicate connection or profile overwrite |
| DEB/Arch bridge continues as old app | No shell update check or install at quit; no privileged DEB updater route |
| macOS 14+ | Copy full WebKit UUID store, preserving cookies and site storage |
| macOS 12/13 | No persistent remote profile exists; preserve saved connections |
| Linux/Windows | Copy complete closed profile directory for each connection UUID |
| New root has a managed install and migration committed | Start from new data root |
| Migration uncommitted and legacy versions directory exists | Start or repair in legacy tree; never install into copy target |
| Legacy versions directory empty/incomplete | Repair legacy tree, then let its process migrate from preserved source |
| Neither versions root exists; no pending marker/claim | Install fresh in new data root |
| Pending marker without legacy versions / any migration claim | Refuse fresh target start/install; preserve both roots |
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
