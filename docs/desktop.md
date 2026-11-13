# Squawk Desktop

Paths `<config>`, `<state>`, `<data>` and `<cache>` refer to the
[resolved home roots](migration.md#home-directories).


The desktop app uses Tauri 2 and the existing React cockpit. The Rust shell owns
local process supervision, a bundled connection screen and isolated remote windows.
The shell is versioned independently from the service. Source provenance:
open-mercato/cezar#1132, open-mercato/cezar#1137, open-mercato/cezar#1138,
open-mercato/cezar#1140, open-mercato/cezar#1142, open-mercato/cezar#1143,
open-mercato/cezar#1144 and desktop/development portions of open-mercato/cezar#1195
and open-mercato/cezar#1196. The shell does not update the cockpit; see [Local mode](#local-mode).

## Install

The Desktop check workflow attaches test installers to PRs: macOS DMG, Windows
NSIS setup EXE, Linux AppImage and DEB. Test macOS builds are sealed ad-hoc;
test Windows installers are unsigned. These are review artifacts, not notarized
public releases. A local build can be opened on its build machine.

Public releases use `desktop-v<shell-version>` tags and the Desktop release
workflow. They require Apple Developer ID signing and notarization, Windows
Authenticode signing, and the separate Tauri updater key. Missing credentials
fail the release; they never silently publish an unsigned installer.

DMG: drag Squawk into Applications. Windows: run setup (WebView2 is handled by
Tauri's installer). DEB: `sudo apt install ./squawk-linux-x86_64.deb`.
AppImage: make executable and run. The release also includes an Arch package,
built and dependency-checked in an Arch container. Checksums accompany release
assets. Stable links are under the fork's `desktop-latest` GitHub release; the
rolling tag is never force-moved. A public download link exists only after a
signed release succeeds.

## Local mode

Click **Start local cockpit**. Node.js 24.21.0+ and npm must be installed; the shell
finds tools through your login shell on macOS/Linux. When Node is absent, it
shows a download link and retry. Remote mode remains available from the app menu.
The first local start installs the newest `@hearsay-tools/squawk` release
(npm dist-tag `latest`) under `<data>/versions` and points `versions/current`
at it. The cockpit and server come from that installation, not from the shell
bundle.

The app installs the cockpit only when none is installed. It does not check for,
offer or install a newer cockpit, and it has no version switcher. To get a newer
cockpit, quit the app, delete the `current` link in the versions directory, and
start the local cockpit again. The shell then installs the newest release. Older
installed versions stay on disk. Before home migration commits, the versions
directory is the legacy `versions/` tree (see
[Desktop identity and bridge validation](#desktop-identity-and-bridge-validation)).

An older installed cockpit can still have its own updater. When it exits with
status 75 after an update, the shell starts the version that `current` points
at.

## Remote mode and trust boundary

Enter the address on the launch screen, or choose **Connect to a server…**
(Cmd/Ctrl+Shift+K). No Node, local cockpit, npm install or agent is started by
connecting. Use an HTTPS server with a valid certificate and authentication
provided by its reverse proxy. Squawk itself has no built-in server auth.
Do not expose an unauthenticated cockpit on the internet.

Sign in on the remote site’s login page. For a separate identity provider such as
Authelia, enter its exact HTTPS origin in **Trusted sign-in origin** before
connecting (for example `https://auth.example.com`). Only the cockpit origin and
that explicitly trusted sign-in origin may navigate in the remote window. Other
redirects show a connection error; their destinations are never trusted automatically.
Credentials must not be embedded in either address. Certificate verification is
never disabled. The native window title continues to identify the selected cockpit. For SSH access:

```sh
ssh -N -L 54321:127.0.0.1:4321 user@server
```

Then connect to `http://127.0.0.1:54321`. Other unencrypted remote addresses are
rejected. The tunnel carries SSH's authentication and encryption; the server
should use its remote-mode protections (`HSQ_REMOTE=1` or `CEZ_REMOTE=1`).

**Remember this connection and sign-in** is checked by default. Saved cockpits
appear in the launcher's sidebar with their address and trusted sign-in origin
already filled in. Select one and choose **Open cockpit** on later launches.
Each saved connection has a separate persistent browser profile, isolated from
other connections and the local cockpit. Changing the cockpit address or trusted
sign-in origin creates a separate profile. Cookies and web storage are managed by
the OS webview; the app never reads or stores your password. Server expiration,
logout, MFA and any “Remember me” setting on the sign-in page still apply.

Uncheck Remember for a temporary, isolated session. **Forget connection…** closes
that connection and clears its saved sign-in/browser profile before removing the
bookmark. This clears local authentication state; it does not revoke sessions on
other devices. Persistent isolated profiles require macOS 14 or later; macOS
12–13 still remember addresses, explicitly show this limitation and use temporary
sessions. Windows and Linux use separate webview data directories.

Bookmarks live in `<state>/desktop/connections.json`, with owner-only permissions on Unix. Windows
and Linux browser profiles live in `<data>/desktop/profiles/<uuid>`; macOS
profiles are managed by WebKit under the app's data store. Use Forget to clear a
profile, rather than deleting just the bookmark file.

Remote webviews have no Tauri capability grants or local initialization script. The native title identifies the selected origin. This
does not add a local reverse proxy or weaken server CORS/CSRF rules.

Password-manager browser extensions are not bundled or integrated. Use your
manager's desktop copy/paste flow when needed; native autofill availability
varies by platform and provider and is not guaranteed. The app does not intercept
login fields or copy cookies from your regular browser.
External HTTPS links open in the system browser. Full-page identity-provider
redirects are supported through the explicit trusted sign-in origin; popup login
flows and an app-managed Basic Auth credential form are not supported. For the
installer’s default Basic-Auth reverse proxy, connect through an SSH tunnel to
the server’s loopback cockpit port; SSH provides the authentication.

## Build and test locally

From a fresh worktree, install dependencies there first:

```sh
pnpm install --frozen-lockfile
npm run build
npm ci --prefix packages/desktop
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --locked --lib
npm run build --prefix packages/desktop -- --debug --bundles app,dmg # macOS
```

Rust and the platform's Tauri build prerequisites are required to compile. They
are not required to run an installed app. The desktop package intentionally sits
outside the pnpm workspaces so normal CLI builds do not require Rust.

For an isolated macOS smoke test of an old-identity development build
(`--rebrand off`), launch its executable directly so it receives the test environment:

Before running the test, check that your login shell startup files do not
change or unset `CEZ_HOME` or `HSQ_DRY_RUN`. The sidecar uses a login shell.

```sh
CEZ_HOME="$(mktemp -d)" HSQ_DRY_RUN=1 \
HSQ_DESKTOP_ENTRY="$PWD/packages/cezar/dist/index.js" \
HSQ_DESKTOP_CWD="$PWD" HSQ_DESKTOP_NO_UPDATE=1 \
"$PWD/packages/desktop/src-tauri/target/debug/bundle/macos/Cezarion.app/Contents/MacOS/cezar-desktop"
```

An old-identity build's native home resolver reads only `CEZ_HOME`,
else `~/.cezar`; it ignores `HSQ_HOME`. The command pins `CEZ_HOME` to isolate
the registry and desktop state. In a new-identity build, `HSQ_HOME` selects the split
roots; see [custom homes](migration.md#custom-homes-and-containers) for `CEZ_HOME` rules.
The other native development settings use `HSQ_DRY_RUN` (`CEZ_DRY_RUN` fallback),
`HSQ_DESKTOP_ENTRY` (`CEZ_DESKTOP_ENTRY` fallback),
`HSQ_DESKTOP_CWD` (`CEZ_DESKTOP_CWD` fallback) and
`HSQ_DESKTOP_NO_UPDATE` (`CEZ_DESKTOP_NO_UPDATE` fallback).

Click Local cockpit, check the project list and task view. Create a dry-run task if desired. Quit the app (Cmd+Q on macOS; closing its window keeps it running) and confirm
its owned server exits. The shell closes the server's stdin and gives it 10 seconds
to shut down on its own (store flush, agent and preview cleanup) before it
force-kills it. Try connecting to `http://example.com` (must reject),
and to a separate local cockpit over loopback (must open a separate remote
window). Remote pages must not be able to invoke native commands such as connect.
Use the ordinary app launch without these variables for your real projects.

## App icon

The native app and installer icons use the same Squawk mark as the cockpit
sidebar: `packages/web/public/cezarion-mark-dark.svg`. Regenerate all macOS,
Windows and Linux sizes with `npm run icon --prefix packages/desktop`, then
rebuild the app. The generator uses the installed Tauri CLI and also refreshes
the launcher mark.

## Public release setup

Store these GitHub Actions secrets in the fork:

- `TAURI_SIGNING_PRIVATE_KEY`, optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
  store the matching exported public key in the `TAURI_SIGNING_PUBLIC_KEY` variable.
  The workflow embeds that key in release builds; development builds have no
  upstream key and cannot adopt upstream binaries. Back up the private key.
- `APPLE_CERTIFICATE` (base64 Developer ID P12), `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific),
  `APPLE_TEAM_ID`.
- `WINDOWS_CERTIFICATE` (base64 code-signing PFX), `WINDOWS_CERTIFICATE_PASSWORD`.
  The workflow imports it into the temporary runner's certificate store,
  timestamps the signature and verifies the resulting installer.

Bump `packages/desktop/package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` together, refresh lockfiles, then push the matching
`desktop-v<version>` tag. Manual workflow dispatch defaults to **dry run** and
only uploads artifacts. Public release requires explicitly turning it off.
The shell downloads and verifies a signed update on launch, but installs it only
when you quit the app, after the cockpit has stopped; the next launch runs the new
shell. It never installs or restarts under a running cockpit (on Windows the
installer would end the process), and it does not relaunch itself after the install.

## Desktop identity and bridge validation

The release identity is Squawk, `tools.hearsay.squawk`. It has separate feeds
and artifacts from the old Cezarion app. See the [migration guide](migration.md#desktop-and-mobile).
Development builds with `--rebrand off` keep the old identity. Native environment readers accept `HSQ_*` first and
`CEZ_*` as fallback now. Presence wins, including empty values. The shell pins
both aliases for every generated sidecar control, even in an old-ID build.

Build metadata comes from `packages/cezar/scripts/product-identity.mjs`.
`node scripts/release-config.mjs --rebrand on|off` in `packages/desktop` writes
the matching Tauri overlay. Pass it to `npm run build -- --config
release-config.json`. Tauri passes that overlay to `build.rs`; Rust receives
constants from the same identity source. Until home migration commits, the shell
starts or repairs any existing legacy `versions/` tree in place. It uses the new
data root after commit, or for a fresh install when no legacy versions directory
exists. Pending migration markers and claims block fresh target installation. `--desktop-identity` prints the built
Tauri identifier and product name without starting a webview. The new identity
has its own executable name, release tags, stable installer names and rolling
updater feed. A bridge build keeps the old identity and old feed.

The owner can build a bridge in the Desktop release workflow with `bridge`
selected. Dry run is still the default. The workflow first builds the new app,
embeds it in the old-ID updater, and signs the outer bundle. Development runs
publish no release, tag or feed. Only the owner publishes the final bridge to the old
feed.

The bridge supports macOS `.app`, Windows per-user NSIS and Linux AppImage
installs. It installs the new app beside the old one before transferring state.
It refuses live browser stores, preserves the complete source, and copies
geometry, connections and persistent profiles privately. Connection UUIDs and
trusted sign-in origins stay unchanged. A loopback acknowledgement from the
new app after native setup permits removal of the old app. A journal binds
acknowledgements to the source, target and embedded payload. Failed attempts
keep the old app usable. Retries preserve independent destination changes.
Before acknowledgement, retries retain every profile seen in any attempt and
add newly saved connections. Private source snapshots also preserve a profile
that the user later forgets in the old app. Transfer indices stay stable.
Windows retries repair a partial bridge install until identity and the actual
per-user registry install location both verify. NSIS receives its destination
as the final raw, unquoted argument so paths with spaces work.
Windows removal waits for the old process to exit before running its NSIS
uninstaller. A failed uninstaller leaves the old installation in place.

Linux DEB and Arch installations take the manual path: install the new package,
then remove the old package with the same package manager. The bridge shows a
one-time dismissible notice, keeps all normal app controls, and starts no
installation, profile transfer or removal. It never requests privilege.
These bridge builds also disable shell update checks and update installation
at quit, so a later DEB update cannot request privilege through the updater.
The pinned Tauri updater supports DEBs; the pinned tauri-action emits an
installer-specific `linux-x86_64-deb` manifest key when a DEB signature exists,
with AppImage as the primary `linux-x86_64` target. Arch packages are repackaged
from the DEB after manifest generation. They have no Arch-specific manifest key,
but their binary can retain the DEB bundle marker and select the DEB entry.
The explicit guard applies regardless of feed selection.

macOS 14+ WebKit stores live outside the app data directory:
`~/Library/WebKit/<bundle-id>/WebsiteDataStore/<lowercase-connection-uuid>`.
The bridge copies the entire closed store, including cookies and site storage.
macOS 12/13 remote windows already use temporary profiles. Notification and
automation permission prompts return under the new ID. The app has no
app-managed Keychain or password store.

Desktop check runs both identities on each platform. Its macOS fixture builds
two test apps, seeds a real persistent HttpOnly cookie and local storage in the
old-ID WebKit store, closes it, runs the actual transfer plan, and reads both
in the new-ID app. It also checks geometry, connection UUIDs and trust origins,
then repeats the transfer and read. This fixture uses the `bridge-fixture`
Cargo feature and refuses to run outside a disposable CI runner. Normal
installers omit that feature.

For the owner macOS smoke check: obtain both CI test installers and the old-ID
bridge test artifact. In a disposable user account, save a remote connection
with a trusted sign-in origin, sign in, and move/resize the old app. Quit both
apps, launch the bridge, and confirm the new app opens with the same geometry
and signed-in connection. Confirm the old app is removed only after the new
app opens. Repeat the bridge and confirm no duplicate connection or reset.
Repeat with an unwritable destination and with the new app prevented from
starting; the old app and signed-in profile must remain usable. Record the
macOS version, artifact head SHA and results. No macOS smoke result is claimed
from a Linux workstation.
