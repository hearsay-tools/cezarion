//! The old-ID bridge runs before opening a webview. Embedded payloads came through the signed
//! updater, and the old app is removed only after the new-ID process acknowledges its window.
use std::{fs, io::{self, Read, Write}, net::{TcpListener, TcpStream}, path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant}};
use tauri::Manager;
use uuid::Uuid;
use super::{bridge_state::{self, Plan, Transfer, Platform, Outcome}, identity, product};

fn error(message: impl Into<String>) -> io::Error { io::Error::other(message.into()) }
fn bounded_output(command: &mut Command, timeout: Duration) -> io::Result<std::process::Output> {
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    for (index, reader) in [child.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>), child.stderr.take().map(|r| Box::new(r) as Box<dyn Read + Send>)].into_iter().enumerate() {
        let sender = sender.clone();
        std::thread::spawn(move || { let mut bytes = Vec::new(); let result = reader.unwrap().take(65536).read_to_end(&mut bytes).map(|_| bytes); let _ = sender.send((index, result)); });
    }
    drop(sender);
    let deadline = Instant::now() + timeout;
    let result = (|| {
        let status = loop {
            if let Some(status) = child.try_wait()? { break status; }
            if Instant::now() >= deadline { return Err(error("Bridge command timed out; old app retained")); }
            std::thread::sleep(Duration::from_millis(25));
        };
        let mut output = [Vec::new(), Vec::new()];
        for _ in 0..2 {
            let (index, bytes) = receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_| error("Bridge command output timed out"))?;
            output[index] = bytes?;
        }
        let [stdout, stderr] = output;
        Ok(std::process::Output { status, stdout, stderr })
    })();
    if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
    result
}
fn command_ok(command: &mut Command) -> io::Result<()> {
    let result = bounded_output(command, Duration::from_secs(120))?;
    if result.status.success() { Ok(()) } else { Err(error(String::from_utf8_lossy(&result.stderr).into_owned())) }
}

fn app_bundle(exe: &Path) -> io::Result<PathBuf> {
    exe.ancestors().find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf).ok_or_else(|| error("This is not a macOS app bundle"))
}

struct Native {
    source: PathBuf,
    destination: PathBuf,
    executable: PathBuf,
    payload: PathBuf,
    journal: PathBuf,
    supported: bool,
    binding: Vec<u8>,
}
impl Native {
    fn new(resources: &Path, journal: PathBuf) -> io::Result<Self> {
        let exe = std::env::current_exe()?;
        let manifest: serde_json::Value = serde_json::from_slice(&fs::read(resources.join("bridge/manifest.json"))?)?;
        if manifest["desktopAppId"] != identity::NEXT_APP_ID || manifest["rebrand"] != true { return Err(error("Bridge payload identity mismatch")); }
        let (source, destination, executable, format, supported) = if cfg!(target_os = "macos") {
            let source = app_bundle(&exe)?;
            let destination = source.parent().unwrap().join(format!("{}.app", identity::NEXT_DISPLAY_NAME));
            let executable = destination.join("Contents/MacOS").join(identity::NEXT_EXECUTABLE);
            (source, destination, executable, "app.tar.gz", true)
        } else if cfg!(windows) {
            let source = exe.parent().ok_or_else(|| error("No application directory"))?.to_path_buf();
            let destination = source.parent().ok_or_else(|| error("No installation parent"))?.join(identity::NEXT_DISPLAY_NAME);
            let executable = destination.join(format!("{}.exe", identity::NEXT_EXECUTABLE));
            let supported = source.join("uninstall.exe").is_file()
                && std::env::var_os("LOCALAPPDATA").is_some_and(|root| source.starts_with(root));
            (source, destination, executable, "setup.exe", supported)
        } else {
            let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
            let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
            let supported = bridge_state::appimage_install(&exe, appimage.as_deref(), appdir.as_deref());
            let source = appimage.unwrap_or(exe);
            let destination = source.parent().unwrap().join(format!("{}.AppImage", identity::NEXT_DISPLAY_NAME));
            (source, destination.clone(), destination, "AppImage", supported)
        };
        if manifest["format"] != format { return Err(error("Bridge payload platform mismatch")); }
        if source == destination { return Err(error("Bridge would replace the source app")); }
        let binding = serde_json::to_vec(&serde_json::json!({ "sourceApp": source, "destinationApp": destination, "payload": manifest }))?;
        Ok(Self { source, destination, executable, payload: resources.join(format!("bridge/payload.{format}")), journal, supported, binding })
    }
    fn verify_identity(&self) -> io::Result<()> {
        let result = bounded_output(Command::new(&self.executable).arg("--desktop-identity"), Duration::from_secs(15))?;
        let value: serde_json::Value = serde_json::from_slice(&result.stdout)?;
        if !result.status.success() || value["identifier"] != identity::NEXT_APP_ID {
            return Err(error("Installed app did not report the new identifier"));
        }
        Ok(())
    }
    fn install_nsis(&self) -> io::Result<()> {
        #[cfg(windows)] {
            bridge_state::install_verified(&self.journal, &self.destination,
                || command_ok(&mut bridge_state::nsis_command(&self.payload, &self.destination)?),
                || {
                    self.verify_identity()?;
                    // Tauri CLI 2.11.5 installer.nsi writes the actual $INSTDIR here.
                    // Read HKCU only: this bridge supports per-user NSIS installations.
                    let key = format!("Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}", identity::NEXT_DISPLAY_NAME).replace('\'', "''");
                    let script = format!("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-ItemPropertyValue -LiteralPath '{key}' -Name InstallLocation -ErrorAction Stop | ConvertTo-Json -Compress");
                    let result = bounded_output(Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]), Duration::from_secs(15))?;
                    if !result.status.success() { return Err(error("Could not verify the NSIS installation location")); }
                    let location: String = serde_json::from_slice(&result.stdout)?;
                    bridge_state::verify_install_location(&self.destination, Path::new(location.trim_matches('"')))
                })
        }
        #[cfg(not(windows))]
        unreachable!()
    }
}
impl Platform for Native {
    fn supported(&self) -> bool { self.supported }
    fn quiescent(&self, transfers: &[Transfer]) -> io::Result<()> {
        // WebView2 and WebKit workers can outlive their host window. Inspect the store handles,
        // as well as refusing another shell process. Never copy a live SQLite/cookie store.
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match closed_profiles(transfers) {
                Ok(()) => return Ok(()),
                Err(reason) if Instant::now() >= deadline => return Err(reason),
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    }
    fn install(&mut self) -> io::Result<()> {
        if cfg!(windows) { return self.install_nsis(); }
        if self.destination.exists() { return self.verify_identity(); }
        let staging = self.destination.with_extension("bridge-stage");
        let reserved = self.journal.join("installation-staging");
        if reserved.is_file() {
            if let Ok(metadata) = fs::symlink_metadata(&staging) {
                if metadata.is_dir() && !metadata.is_symlink() { fs::remove_dir_all(&staging)?; } else { fs::remove_file(&staging)?; }
            }
        } else {
            if fs::symlink_metadata(&staging).is_ok() { return Err(error("Bridge installation staging already exists")); }
            bridge_state::marker(&reserved)?;
        }
        if cfg!(target_os = "macos") {
            fs::create_dir(&staging)?;
            command_ok(Command::new("/usr/bin/tar").args(["-xzf"]).arg(&self.payload).arg("-C").arg(&staging))?;
            let app = staging.join(format!("{}.app", identity::NEXT_DISPLAY_NAME));
            command_ok(Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(&app))?;
            fs::rename(app, &self.destination)?; fs::remove_dir(&staging)?;
        } else {
            let temporary = staging;
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
            io::copy(&mut fs::File::open(&self.payload)?, &mut file)?; file.sync_all()?;
            #[cfg(unix)]
            { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))?; }
            fs::rename(temporary, &self.destination)?;
        }
        self.verify_identity()
    }
    fn start_and_acknowledge(&mut self) -> io::Result<()> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let token = Uuid::new_v4().to_string();
        let mut child = Command::new(&self.executable)
            .args(["--desktop-bridge-ack-port", &listener.local_addr()?.port().to_string(), "--desktop-bridge-token", &token])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
        let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((stream, _)) => {
                    bridge_state::prepare_accepted_stream(&stream)?;
                    let mut bytes = Vec::new(); stream.take(4096).read_to_end(&mut bytes)?;
                    return validate_acknowledgement(&bytes, &token);
                },
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => (),
                Err(e) => return Err(e),
            }
            if child.try_wait()?.is_some() { return Err(error("New app exited before acknowledgement")); }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(error("New app did not acknowledge startup; old app retained"))
        })();
        // Every failure closes the unconfirmed app before an operator retries transfer.
        if result.is_err() { let _ = child.kill(); let _ = child.wait(); }
        result
    }
    fn remove_old_app(&mut self) -> io::Result<bool> {
        if cfg!(windows) { schedule_windows_removal(&self.source, &self.journal)?; return Ok(false); }
        if cfg!(target_os = "macos") { fs::remove_dir_all(&self.source)?; } else { fs::remove_file(&self.source)?; }
        Ok(true)
    }
}

/// System-package bridge builds must never reach the updater's privileged DEB installer.
pub fn shell_updates_allowed() -> bool {
    if !identity::BRIDGE || !cfg!(target_os = "linux") { return true; }
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    let supported = std::env::current_exe().is_ok_and(|exe| bridge_state::appimage_install(&exe, appimage.as_deref(), appdir.as_deref()));
    bridge_state::shell_updates_allowed(identity::BRIDGE, super::platform_name(), supported)
}

fn validate_acknowledgement(bytes: &[u8], token: &str) -> io::Result<()> {
    let response: serde_json::Value = serde_json::from_slice(bytes)?;
    if response["token"] == token && response["identifier"] == identity::NEXT_APP_ID { Ok(()) }
    else { Err(error("New app acknowledgement mismatch")) }
}

fn closed_profiles(transfers: &[Transfer]) -> io::Result<()> {
    #[cfg(unix)] {
        let processes = Command::new("pgrep").args(["-x", &format!("{}|{}", identity::LEGACY_EXECUTABLE, identity::NEXT_EXECUTABLE)]).output()?;
        if !processes.status.success() && processes.status.code() != Some(1) { return Err(error("Cannot inspect desktop processes")); }
        let me = std::process::id().to_string();
        if String::from_utf8_lossy(&processes.stdout).lines().any(|pid| pid != me) { return Err(error("Close both desktop apps before transfer")); }
        #[cfg(target_os = "linux")]
        bridge_state::linux_profiles_closed(&transfers.iter().flat_map(|transfer| [transfer.source.clone(), transfer.target.clone()]).collect::<Vec<_>>())?;
        #[cfg(target_os = "macos")]
        for path in transfers.iter().flat_map(|transfer| [&transfer.source, &transfer.target]) {
            if !path.is_dir() { continue; }
            let handles = Command::new("/usr/sbin/lsof").arg("+D").arg(path).output()?;
            if handles.status.success() || !handles.stdout.is_empty() { return Err(error("A browser profile is still open; retry after it closes")); }
            if handles.status.code() != Some(1) { return Err(error("Could not inspect browser profile handles")); }
        }
    }
    #[cfg(windows)] {
        fn unlocked(path: &Path) -> io::Result<()> {
            use std::os::windows::fs::OpenOptionsExt;
            if path.is_dir() { for entry in fs::read_dir(path)? { unlocked(&entry?.path())?; } }
            else { fs::OpenOptions::new().read(true).share_mode(0).open(path)?; }
            Ok(())
        }
        let processes = Command::new("tasklist.exe").args(["/FO", "CSV", "/NH"]).output()?;
        if !processes.status.success() { return Err(error("Cannot inspect desktop processes")); }
        let me = std::process::id().to_string();
        for row in String::from_utf8_lossy(&processes.stdout).lines() {
            let fields: Vec<_> = row.split(',').map(|s| s.trim_matches('"')).collect();
            if fields.first().is_some_and(|name| [identity::LEGACY_EXECUTABLE, identity::NEXT_EXECUTABLE].iter().any(|exe| name.eq_ignore_ascii_case(&format!("{exe}.exe")))) && fields.get(1).is_some_and(|pid| *pid != me) { return Err(error("Close both desktop apps before transfer")); }
        }
        for path in transfers.iter().flat_map(|transfer| [&transfer.source, &transfer.target]) { if path.exists() { unlocked(path)?; } }
    }
    Ok(())
}
#[cfg(windows)]
fn schedule_windows_removal(source: &Path, journal: &Path) -> io::Result<()> {
    let uninstall = source.join("uninstall.exe");
    if !uninstall.is_file() { return Err(error("No per-user NSIS uninstaller; old app retained")); }
    let script = journal.join("remove-old.ps1");
    let escaped = uninstall.to_string_lossy().replace('\'', "''");
    let removed = journal.join("removed").to_string_lossy().replace('\'', "''");
    fs::write(&script, format!("Wait-Process -Id {} -ErrorAction SilentlyContinue\n$p = Start-Process -FilePath '{escaped}' -ArgumentList '/S' -Wait -PassThru\nif ($p.ExitCode -eq 0) {{ New-Item -ItemType File -Path '{removed}' -Force | Out-Null }}\n", std::process::id()))?;
    // This private script is generated above. The policy applies only to this child.
    bridge_state::powershell_script_command(&script).spawn()?;
    Ok(())
}
#[cfg(not(windows))]
fn schedule_windows_removal(_: &Path, _: &Path) -> io::Result<()> { unreachable!() }

fn transfer_plan(journal: PathBuf, binding: Vec<u8>) -> io::Result<Plan> {
    let old = product::home(&super::home_dir(), super::platform_name(), false, |key| std::env::var_os(key));
    let next = product::home(&super::home_dir(), super::platform_name(), true, |key| std::env::var_os(key));
    // Only profile membership can change during a retry. App/payload/home roots stay bound.
    let binding = serde_json::to_vec(&serde_json::json!({ "app": binding, "legacy": old.legacy, "config": next.config, "state": next.state, "data": next.data }))?;
    let mut transfers = vec![
        Transfer { source: old.state.join("desktop-window.json"), target: next.state.join("desktop-window.json") },
        Transfer { source: old.state.join("desktop/connections.json"), target: next.state.join("desktop/connections.json") },
    ];
    // Strict deserialization prevents a malformed bookmark store from silently losing profiles.
    let connections = old.state.join("desktop/connections.json");
    let mut ids = if connections.exists() {
        let rows: Vec<super::remote::Connection> = serde_json::from_slice(&fs::read(connections)?)?;
        rows.into_iter().map(|row| row.id).collect::<Vec<_>>()
    } else { Vec::new() };
    ids.sort(); ids.dedup();
    for id in ids {
        let (source, target) = if cfg!(target_os = "macos") {
            let root = super::home_dir().join("Library/WebKit");
            // WebKit uses WTF::UUID::toString for this directory (lowercase UUID).
            let name = id.to_string();
            (root.join(identity::LEGACY_APP_ID).join("WebsiteDataStore").join(&name), root.join(identity::NEXT_APP_ID).join("WebsiteDataStore").join(name))
        } else {
            (old.data.join("desktop/profiles").join(id.to_string()), next.data.join("desktop/profiles").join(id.to_string()))
        };
        transfers.push(Transfer { source, target });
    }
    Ok(Plan { journal, transfers, binding })
}

/// The event-loop Ready event, after all fallible setup, is the receipt. The new app reports its compiled ID, not a caller value.
pub fn acknowledge() -> io::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let value = |key| args.iter().position(|arg| arg == key).and_then(|index| args.get(index + 1));
    let Some(port) = value("--desktop-bridge-ack-port") else { return Ok(()); };
    if !identity::REBRAND { return Err(error("Old app cannot acknowledge the new app transfer")); }
    let token = value("--desktop-bridge-token").ok_or_else(|| error("Missing bridge token"))?;
    Uuid::parse_str(token).map_err(|_| error("Invalid bridge token"))?;
    let port = port.parse::<u16>().map_err(|_| error("Invalid bridge port"))?;
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    stream.write_all(serde_json::json!({ "token": token, "identifier": identity::APP_ID }).to_string().as_bytes())
}

/// None: ordinary app. Some(Ok): old bridge can exit. Some(Err): old app stays usable.
pub fn attempt(app: &tauri::AppHandle) -> Option<io::Result<Outcome>> {
    if !identity::BRIDGE { return None; }
    Some((|| {
        let journal = super::desktop_home().state.join("desktop/identity-bridge-v1");
        let mut native = Native::new(&app.path().resource_dir().map_err(|e| error(e.to_string()))?, journal.clone())?;
        if !native.supported { return Ok(Outcome::Manual); }
        bridge_state::execute(&transfer_plan(journal, native.binding.clone())?, &mut native)
    })())
}

/// The system-package path keeps every normal app control and can dismiss this once.
pub fn show_notice(app: &tauri::AppHandle, result: Option<io::Result<Outcome>>) {
    let mut manual_marker = None;
    let message = match result {
        Some(Ok(Outcome::Manual)) => {
            let seen = super::desktop_home().state.join("desktop/identity-bridge-manual-notice");
            if seen.exists() { return; }
            manual_marker = Some(seen);
            format!("Install the new {} package with your package manager, then remove the old {} package with that same package manager. Your old app remains usable until you choose to move. No system package was installed or removed by this bridge.", identity::NEXT_DISPLAY_NAME, identity::DISPLAY_NAME)
        },
        Some(Err(reason)) => format!("The move to {} did not finish: {reason}. The old app and its data remain available. Close both apps before retrying.", identity::NEXT_DISPLAY_NAME),
        _ => return,
    };
    if let Some(window) = app.get_webview_window("main") {
        let script = format!("(() => {{ const show = () => alert({}); if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', show, {{ once: true }}); else show(); }})();", serde_json::to_string(&message).unwrap());
        if let Some(seen) = manual_marker {
            let _ = bridge_state::show_manual_notice(&seen, || window.eval(&script).map_err(|e| error(e.to_string())));
        } else { let _ = window.eval(script); }
    }
}

#[cfg(feature = "bridge-fixture")]
pub fn fixture_transfer() -> io::Result<()> {
    struct Fixture;
    impl Platform for Fixture {
        fn supported(&self) -> bool { true }
        fn quiescent(&self, transfers: &[Transfer]) -> io::Result<()> {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                match closed_profiles(transfers) {
                    Ok(()) => return Ok(()),
                    Err(reason) if Instant::now() >= deadline => return Err(reason),
                    Err(_) => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        }
        fn install(&mut self) -> io::Result<()> { Ok(()) }
        fn start_and_acknowledge(&mut self) -> io::Result<()> { Ok(()) }
        fn remove_old_app(&mut self) -> io::Result<bool> { Ok(true) }
    }
    let journal = super::desktop_home().state.join("desktop/fixture-transfer");
    bridge_state::execute(&transfer_plan(journal, b"native CI fixture".to_vec())?, &mut Fixture)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acknowledgement_requires_both_the_token_and_new_identity() {
        let bytes = |token, identifier| serde_json::to_vec(&serde_json::json!({ "token": token, "identifier": identifier })).unwrap();
        validate_acknowledgement(&bytes("expected", identity::NEXT_APP_ID), "expected").unwrap();
        assert!(validate_acknowledgement(&bytes("wrong", identity::NEXT_APP_ID), "expected").is_err());
        assert!(validate_acknowledgement(&bytes("expected", identity::LEGACY_APP_ID), "expected").is_err());
        assert!(validate_acknowledgement(b"not json", "expected").is_err());
    }
}
