# Cezarion mobile companion

Native iOS (Swift/UIKit/WKWebView) and Android (Java/WebView) shells around the
existing HTTPS cockpit. The launcher is native; the product UI stays on the server.
No Node or coding-agent runtime runs on the phone.

See [installation, testing, and distribution instructions](../../docs/mobile.md).

This directory is independent of the npm workspaces. It does not change desktop,
server, or browser behavior. `ios/Cezarion.xcodeproj` and the Android Gradle wrapper
are checked in so a new checkout builds with the standard platform SDKs.

The app icons reuse the Cezarion parrot artwork from
[hearsay-tools/cezarion#847](https://github.com/hearsay-tools/cezarion/pull/847).
