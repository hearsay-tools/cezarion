# Cezarion on your phone

The mobile app connects to an existing HTTPS Cezarion server. Agents, repositories,
and worktrees stay on that server. The phone uses the same responsive cockpit as
the browser: tasks, conversations, questions, and reviews. Your server's remote-mode
restrictions still apply. The server must be reachable from the phone, including
through your VPN if it is private.

This first version is for personal installation. It supports iOS 16+ and Android 8+.
It has a native connection screen and embeds the cockpit in WKWebView / Android
WebView. The desktop work in [hearsay-tools/cezarion#847](https://github.com/hearsay-tools/cezarion/pull/847)
informs its trust model; this change does not depend on that PR being merged.

## Install on Android

1. Open the PR's **Checks → Mobile apps → android** workflow run in GitHub. After
   it passes, download the **cezarion-android-personal** artifact from the run's
   **Artifacts** section. GitHub sign-in is required; artifacts expire after 14 days.
2. Unzip the download. Transfer **app-debug.apk** to your phone, or download and
   unzip it directly on the phone.
3. Open the APK. If Android asks, allow this browser/file manager to **Install
   unknown apps**, then install **Cezarion**. You can turn that permission off again.
4. Launch Cezarion and follow **Connect and test** below.

With USB debugging enabled, installation from a computer is also possible:

```sh
adb install -r app-debug.apk
```

This personal build uses the application ID `tools.hearsay.cezarion.mobile.debug`
and a development signing key. CI may generate a different key on each run. If an
update says the signatures do not match, uninstall the earlier personal build and
install again; you will need to reconnect and sign in. Builds made repeatedly on
one development machine use that machine's existing debug key.

## Install on iPhone

Use a Mac with Xcode and your Apple account. A free personal team can run the app
on your own connected device; its provisioning expires periodically, so Xcode may
need to reinstall it. A downloaded unsigned archive cannot be installed directly.

1. Check out the PR branch, **codex/mobile-companion**. Open
   **packages/mobile/ios/Cezarion.xcodeproj** in Xcode. No npm, CocoaPods, Rust,
   XcodeGen, or other package installation is required to build this checked-in project.
2. Connect and unlock your iPhone. Accept **Trust This Computer** if prompted.
3. In Xcode, select the **Cezarion** app target → **Signing & Capabilities**. Keep
   **Automatically manage signing** enabled and choose your team. Add your Apple
   account in **Xcode → Settings → Apple Accounts** (called **Accounts** in older
   versions) if needed. If the bundle identifier is
   unavailable to your team, use a unique identifier for your local personal build.
4. Select your iPhone as the run destination and press **Run** (`⌘R`). Xcode will
   register/provision the device and install the app.
5. If requested, enable **Settings → Privacy & Security → Developer Mode** on the
   phone and restart it. Trust the developer under **Settings → General → VPN &
   Device Management** if iOS asks. Run from Xcode again.
6. Open Cezarion and follow **Connect and test** below. The Mac is not needed once
   the app is installed and its provisioning is valid.

If a signed development `.ipa` has been supplied separately, it only works on
devices included in its provisioning profile. Manage devices through **Xcode →
Open Developer Tool → Device Hub**, or **Manage Devices…** in the run destination
menu. Older Xcode versions use **Window → Devices and Simulators**, where the
device's **Installed Apps → +** control accepts a signed IPA. If the device is not
registered or the install control is unavailable, use the source-and-Run steps above.

Apple's instructions: [personal development accounts](https://developer.apple.com/help/account/basics/about-your-developer-account)
and [Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).

## Connect and test

1. Enter your server's full **Cockpit address**, for example
   `https://cezar.example.com`. Use the address without passwords, query parameters,
   or fragments. Plain HTTP and invalid HTTPS certificates are refused.
2. If authentication redirects to another host, enter its **Trusted sign-in
   origin**, for example `https://auth.example.com`. It must be an origin only,
   without a login path. Trust is exact, including non-default ports.
3. Tap **Connect**. Complete your server's sign-in in the app, including MFA if
   required. Choose the sign-in service's **Remember me** option if you want its
   persistent session; the shell does not override the server's expiration policy.
4. Open a task, read the conversation, and send a message or create a small test
   task. Verify streamed updates and any **Needs You** response flow you use.
5. Switch apps or lock the phone, then return. The existing cockpit reconciles its
   stream when it becomes visible. Use pull-to-refresh or **⋯ → Refresh** if stuck.
   It does not rerun a task.
6. Use **⋯ → Connection settings** to return to the connection screen. Close and reopen the app:
   the address is remembered; tap **Connect** to reopen it.
7. Use **Forget connection & sign out**, confirm, and reconnect. You should have to
   sign in again. This clears this app's website data, not your browser's sessions.

The cockpit fills the available screen, with no permanent native toolbar. A small
**⋯** button floats at the right edge; drag it up or down if it covers something.
It is announced as **Browser controls** by screen readers. Tap it for the current
server origin, **Back**, **Refresh**, or **Connection settings**. There is no saved
multi-server list in this version.

- **Back:** on iPhone, swipe right from the left edge to navigate web history.
  Swipe left from the right edge to go forward again. Android uses the system Back
  gesture/button. The menu also offers Back when there
  is a previous page. On iPhone, an edge swipe never dismisses the cockpit to the
  connection form; use the menu for that.
- **Refresh:** pull down starting at the **top edge of the web content**, until
  **Release to refresh** appears, then release. Pulling inside a conversation only
  scrolls it. The cockpit deliberately contains its nested panels' scrolling, so
  arbitrary downward swipes must not reload the page or lose a draft. The menu's
  Refresh action is an accessible alternative.
- Refresh keeps the current cockpit route. When recovering from a connection
  error or a sign-in redirect, it starts at the saved cockpit address instead.
- Connection settings preserves the current session. Connecting to a different
  server/auth pair or choosing Forget still clears it.

External HTTPS links ask before opening in the system browser. A blocked SSO
redirect shows only its origin; open **⋯ → Connection settings** and correct the
trusted origin. Redirects never add trust automatically.

## Scope and session behavior

- One remembered server/auth pair per app installation. Connecting with a different
  pair clears the previous browser session before opening the new one.
- Cookies and website data are stored in the operating system's app sandbox.
  The shell stores addresses; it does not collect or separately store passwords.
- Remote pages get no JavaScript-to-native bridge, filesystem API, or local-agent
  process access. File uploads use the platform's explicit file picker.
- HTTPS certificate verification remains enabled. Android blocks mixed content and
  third-party cookies; full-page SSO redirects work within the trusted origin pair.
- No background execution of agents on the phone, offline cockpit, push
  notifications, biometric lock, or native HTTP Basic Auth prompt in v1.
  Providers requiring a system-browser OAuth callback or special popup flow need
  additional integration. The tested authentication flow is a full-page SSO redirect.
- Website JavaScript, responsive layouts, and task functionality come from your
  server's deployed cockpit version. Updating the shell does not update that server.

## Build and verify

Android requires JDK 17, Android SDK Platform 35 and Build Tools 35.0.0. Set
`ANDROID_HOME` to the SDK installed by Android Studio, or create the usual
untracked `packages/mobile/android/local.properties` with `sdk.dir=...`.

```sh
cd packages/mobile/android
./gradlew testDebugUnitTest lintDebug assembleDebug
# With an emulator or USB-debugging device connected:
./gradlew connectedDebugAndroidTest
```

The APK is `packages/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
Tests cover HTTPS validation, exact origin matching, credential rejection,
sign-in-origin changes, the connection form, and actual cookie deletion.

iOS builds with the checked-in Xcode project:

```sh
xcodebuild -project packages/mobile/ios/Cezarion.xcodeproj -scheme Cezarion \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath packages/mobile/build/ios CODE_SIGNING_ALLOWED=NO build

# Replace the destination with an installed simulator from xcrun simctl list devices:
xcodebuild -project packages/mobile/ios/Cezarion.xcodeproj -scheme Cezarion \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath packages/mobile/build/ios-test CODE_SIGNING_ALLOWED=NO test
```

The optional iOS network smoke test is skipped unless both `MOBILE_TEST_ENDPOINT`
and `MOBILE_TEST_AUTH_ORIGIN` are passed as `xcodebuild` build settings. It checks
arrival at the chosen sign-in origin and saves a screenshot; it does not enter
credentials. The deterministic tests run without a live server.

`ios/project.yml` is the editable XcodeGen specification. If you change target
membership or build settings, regenerate the checked-in project with XcodeGen
2.44.1: `xcodegen generate --spec packages/mobile/ios/project.yml`.

## Later App Store / Play distribution

The production bundle/application ID is `tools.hearsay.cezarion.mobile`, separate
from Android personal builds. Both projects have Release configurations and version
numbers. iOS includes a privacy manifest for its local settings API. CI builds an
unsigned iOS device archive and an installable Android debug APK; no signing
credentials are committed and nothing is automatically published.

For store delivery, add protected signing credentials, signed iOS archive export
and Android `bundleRelease`, store listings, screenshots, privacy disclosures for
the connected service, and a review/test account. Recheck the stores' current SDK
and product requirements at that point. Push notifications and system-browser
authentication can be added as native integrations without rewriting the cockpit.
These projects make that work possible; this personal build has not been submitted
to or approved by either store.
