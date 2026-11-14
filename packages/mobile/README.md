# Squawk mobile companion

Native iOS (Swift/UIKit/WKWebView) and Android (Java/WebView) shells around the
existing HTTPS cockpit. The launcher is native; the product UI stays on the server.
No Node or coding-agent runtime runs on the phone.

See [installation, testing, and distribution instructions](../../docs/mobile.md).

This directory is outside the pnpm workspaces (`pnpm-workspace.yaml`). It does not change desktop,
server, or browser behavior. `ios/Cezarion.xcodeproj` and the Android Gradle wrapper
are checked in so a new checkout builds with the standard platform SDKs.

The app icons reuse the Squawk parrot artwork from
[hearsay-tools/cezarion#847](https://github.com/hearsay-tools/cezarion/pull/847).

## Build identity and final old-app release

Native IDs and display names come from `packages/cezar/src/home/identity.ts`.
`node packages/cezar/scripts/product-identity.mjs` prints that identity as JSON.
The default is the new identity; `--rebrand off` selects the old identity.
Android needs Node 24.21.0 or later on PATH and reads JSON during Gradle configuration.
Its Java namespace stays unchanged; the install ID and launcher name change together.

Xcode cannot import TypeScript. It reads the checked-in `ios/ProductIdentity.xcconfig`
snapshot. `home/mobile-metadata.test.ts` rejects a snapshot that differs from the
shared identity. Regenerate it when the identity changes:

```sh
node packages/mobile/scripts/build-metadata.mjs --write-ios
```

For a local build with the new identity:

```sh
cd packages/mobile/android
./gradlew -Prebrand=on assembleDebug
```

For iOS, run from the repository root, then build the usual Cezarion scheme:

```sh
node packages/mobile/scripts/build-metadata.mjs --rebrand on --write-ios
xcodegen generate --spec packages/mobile/ios/project.yml
```

Use `--rebrand off` / `-Prebrand=off` to test the old identity. Restore the default
snapshot with `--write-ios` before committing. The Xcode target, scheme and Swift
module names stay stable; bundle IDs, display names and permission text use the metadata.
CI builds and tests the old identity, the new identity and the final old-app mode on each platform.
It also checks IDs and names in the built APKs and iOS bundles.

The **final old-app** mode is a separate release input. It forces the old IDs even
with `--rebrand on`. It shows only a move screen. The move screen does not read the
saved connection, create a WebView, copy data or clear data. On Android, a data wipe
the user requested before the update still runs at app start. Without a pending
wipe, the old data stays unchanged. Ordinary old-identity builds keep the connection
flow. The owner must supply each platform's actual HTTPS store URL:

```sh
# Set android_store_url to the owner-supplied Play Store URL first.
cd packages/mobile/android
./gradlew -PfinalOldApp "-PstoreUrl=$android_store_url" assembleRelease
```

```sh
# From the repository root. Set ios_store_url to the owner-supplied App Store URL first.
node packages/mobile/scripts/build-metadata.mjs --final-old-app --store-url "$ios_store_url" --write-ios
# Build/archive the Cezarion scheme with the existing signing procedure.
```

A missing URL, a non-HTTPS URL or embedded credentials fail the build metadata step.
The CI URLs are test fixtures, not release destinations. These commands prepare builds;
they do not publish or submit them. Signing settings are unchanged.

## Side-by-side isolation check

The new install ID gets a separate OS sandbox. No app group, shared preferences import,
keychain import or browser-data copy is added. Android keeps `allowBackup=false` and
the cloud/device-transfer exclusions in `data_extraction_rules.xml`. iOS keeps
app-local defaults and WKWebView's app-local website data store.

On an Android device and an iPhone, check the following before store submission:

1. Install an ordinary old-identity build. Connect to an HTTPS cockpit and complete sign-in.
2. Install a new-identity build beside it. On Android, use the same build type for both
   (debug adds `.debug` to each ID). Confirm both app icons remain installed.
3. Open the new app. Confirm both connection fields are empty. Enter the same server
   and confirm that sign-in is required. A system browser or identity provider can
   still offer its own SSO; this app does not import a WebView session.
4. Reopen the old app. Confirm its connection and website session remain unchanged.
5. Update only the old app to the final old-app build, with the same signing identity
   and a higher version. Confirm only the move screen appears and the button opens
   the exact supplied store page. Confirm the new app still works.

CI also runs an automated side-by-side check in each platform's existing legacy
job. It installs both IDs on that job's emulator/simulator, seeds a saved connection
and persistent browser sign-in cookie in the old app, launches the new app and
checks its empty connection fields and absent cookie, then relaunches the old app
and checks that its connection and cookie remain unchanged. It inspects the new
app before any connection or reset action can clear an accidental copy. Each
stage runs in a separate process and must report an executed pass; skips fail the
check. The iOS seed initializes a real WebView, then awaits WebKit's cookie disk-flush
callback after setting the persistent cookie. An old-app-only relaunch control must
pass before the script tests the new app. That private WebKit selector is confined to the test bundle;
it is absent from the shipped app, and a simulator without it fails the test. The scripts are `scripts/side-by-side-android.sh` and
`scripts/side-by-side-ios.sh`. Their reports join the existing CI test artifacts.
The iOS patcher supports xctestrun format 1 (schemes without a test plan) and format 2
(test configurations), selected by the file's metadata. Unsupported versions or
shapes fail before a patched file is written. Run the portable input/output fixtures
with `python3 packages/mobile/scripts/side-by-side-fixtures.py` from the repository
root. Android CI also runs them. They cover both plist formats and Android raw
instrumentation pass, skip and failure results, including CRLF output.

The check reuses each legacy job's native test device and build outputs. It builds
the second ID without an extra emulator/simulator job. The Android script restores
the legacy APK outputs for the existing download artifact; the iOS script restores
the selected build metadata before the ordinary archive step.

Native checks have not run on this Linux development host. The CI check uses a
synthetic persistent session cookie. It proves separation of app connection settings
and browser session state, without a live sign-in service. It does not prove real
store installation, signing, physical-device transfer behavior, every browser
storage type or a real remote sign-in. The manual check above remains required
before store submission. The optional remote sign-in test still needs its existing
endpoint inputs.
