# Cezarion Desktop

The desktop app uses Tauri 2 and the existing React cockpit. The Rust shell owns
local process supervision, a bundled connection screen and isolated remote windows.
The shell is versioned independently from the service. Source provenance:
open-mercato/cezar#1132, open-mercato/cezar#1137, open-mercato/cezar#1138,
open-mercato/cezar#1140, open-mercato/cezar#1142, open-mercato/cezar#1143,
open-mercato/cezar#1144 and desktop/development portions of open-mercato/cezar#1195
and open-mercato/cezar#1196. This fork retains its existing npm installation updater.

## Install

The Desktop check workflow attaches test installers to PRs: macOS DMG, Windows
NSIS setup EXE, Linux AppImage and DEB. Test macOS builds are sealed ad-hoc;
test Windows installers are unsigned. These are review artifacts, not notarized
public releases. A local build can be opened on its build machine.

Public releases use `desktop-v<shell-version>` tags and the Desktop release
workflow. They require Apple Developer ID signing and notarization, Windows
Authenticode signing, and the separate Tauri updater key. Missing credentials
fail the release; they never silently publish an unsigned installer.

DMG: drag Cezarion into Applications. Windows: run setup (WebView2 is handled by
Tauri's installer). DEB: `sudo apt install ./cezarion-linux-x86_64.deb`.
AppImage: make executable and run. The release also includes an Arch package,
built and dependency-checked in an Arch container. Checksums accompany release
assets. Stable links are under the fork's `desktop-latest` GitHub release; the
rolling tag is never force-moved. A public download link exists only after a
signed release succeeds.

## Local mode

Click **Start local cockpit**. Node.js 20+ and npm must be installed; the shell
finds tools through your login shell on macOS/Linux. When Node is absent, it
shows a download link and retry. Remote mode remains available from the app menu.
The first local start installs `@wjarka/cezarion` under `~/.cezar/versions`.
The cockpit and server come from that installation, not from the shell bundle.

**Versions & updates** supports stable, nightly and development channels,
installed-version rollback, linked worktrees and published fork PR builds.
Restart interrupts active tasks; the dialog warns first. The app menu also
provides version switching and recovery updates for older cockpit versions.
The normal browser cockpit's existing npm updater remains available unchanged.

CLI equivalents: `cez install`, `cez update --channel nightly`, `cez versions`,
`cez use <id>`, `cez link /path/to/checkout --use`, and `cez unlink <id>`.
A development checkout must be built; the picker can build an unbuilt/stale
checkout before switching. The development channel never auto-selects a release.

## Remote mode and trust boundary

Enter the address on the launch screen, or choose **Connect to a server…**
(Cmd/Ctrl+Shift+K). No Node, local cockpit, npm install or agent is started by
connecting. Use an HTTPS server with a valid certificate and authentication
provided by its reverse proxy. Cezarion itself has no built-in server auth.
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
should use its remote-mode protections (`CEZ_REMOTE=1`).

Every connection gets an incognito webview with no Tauri capability grants,
no local shell initialization script and no access to local version switching.
The native title identifies the selected origin. Sessions are not persisted by
the app. This does not add a local reverse proxy or weaken server CORS/CSRF rules.
External HTTPS links open in the system browser. Full-page identity-provider
redirects are supported through the explicit trusted sign-in origin; popup login
flows and an app-managed Basic Auth credential form are not supported. For the
installer’s default Basic-Auth reverse proxy, connect through an SSH tunnel to
the server’s loopback cockpit port; SSH provides the authentication.

## Build and test locally

From a fresh worktree, install dependencies there first:

```sh
npm ci
npm run build
npm ci --prefix packages/desktop
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --locked --lib
npm run build --prefix packages/desktop -- --debug --bundles app,dmg # macOS
```

Rust and the platform's Tauri build prerequisites are required to compile. They
are not required to run an installed app. The desktop package intentionally sits
outside the npm workspaces so normal CLI builds do not require Rust.

For an isolated local smoke test on macOS, launch the built executable directly
so it receives the test environment:

```sh
CEZ_HOME="$(mktemp -d)" CEZ_DRY_RUN=1 CEZ_SKILLS_AUTO_UPDATE=0 \
CEZ_DESKTOP_ENTRY="$PWD/packages/cezar/dist/index.js" \
CEZ_DESKTOP_CWD="$PWD" CEZ_DESKTOP_NO_UPDATE=1 \
"$PWD/packages/desktop/src-tauri/target/debug/bundle/macos/Cezarion.app/Contents/MacOS/cezar-desktop"
```

Click Start local cockpit, check the project list and task view, then open
Versions & updates. Create a dry-run task if desired. Quit the app (Cmd+Q on macOS; closing its window keeps it running) and confirm
its owned server exits. Try connecting to `http://example.com` (must reject),
and to a separate local cockpit over loopback (must open a separate remote
window). Remote pages must not be able to invoke native update/connect commands.
Use the ordinary app launch without these variables for your real projects.

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
The shell downloads signed updates on launch and applies them on the next launch;
it never forcibly restarts a running cockpit to update itself.
