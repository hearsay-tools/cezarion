//! Filesystem-only bridge transaction. Sources are never moved or removed.
use std::{fs, io::{self, Write}, path::{Path, PathBuf}};

#[derive(Clone, Debug, PartialEq)]
pub struct Transfer { pub source: PathBuf, pub target: PathBuf }
pub struct Plan { pub journal: PathBuf, pub transfers: Vec<Transfer>, pub binding: Vec<u8> }
#[derive(Debug, PartialEq)]
pub enum Outcome { Manual, Complete }

/// BSD and Windows can inherit the listener's nonblocking mode on accepted sockets.
pub fn prepare_accepted_stream(stream: &std::net::TcpStream) -> io::Result<()> {
    stream.set_nonblocking(false).map_err(|e| io::Error::new(e.kind(), format!("set accepted socket blocking mode: {e}")))?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .map_err(|e| io::Error::new(e.kind(), format!("set accepted socket read timeout: {e}")))
}

/// One failed/preconnected socket must not abort either listener's overall wait.
/// None reads through EOF (acknowledgement); Some reads through the HTTP header terminator.
pub fn read_accepted_message(stream: &mut std::net::TcpStream, terminator: Option<&[u8]>, limit: usize, deadline: std::time::Instant) -> io::Result<Vec<u8>> {
    use std::io::Read;
    prepare_accepted_stream(stream)?;
    let deadline = deadline.min(std::time::Instant::now() + std::time::Duration::from_secs(2));
    let mut bytes = Vec::new();
    let mut buffer = [0; 1024];
    while bytes.len() < limit {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() { return Err(io::Error::new(io::ErrorKind::TimedOut, "accepted socket message deadline")); }
        stream.set_read_timeout(Some(remaining)).map_err(|e| io::Error::new(e.kind(), format!("set accepted socket remaining timeout: {e}")))?;
        let count = stream.read(&mut buffer[..1024.min(limit - bytes.len())])
            .map_err(|e| io::Error::new(e.kind(), format!("read accepted socket message: {e}")))?;
        if count == 0 {
            if terminator.is_none() && !bytes.is_empty() { return Ok(bytes); }
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "accepted socket closed before a complete message"));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if terminator.is_some_and(|end| bytes.ends_with(end)) { return Ok(bytes); }
    }
    Err(io::Error::new(io::ErrorKind::InvalidData, "accepted socket message exceeds limit"))
}

#[cfg(windows)]
pub fn powershell_script_command(script: &Path) -> std::process::Command {
    let mut command = std::process::Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]).arg(script);
    command
}

pub trait Platform {
    fn supported(&self) -> bool;
    fn quiescent(&self, transfers: &[Transfer]) -> io::Result<()>;
    fn install(&mut self) -> io::Result<()>;
    /// Return only after the new app confirms that its native window started.
    fn start_and_acknowledge(&mut self) -> io::Result<()>;
    fn remove_old_app(&mut self) -> io::Result<bool>;
}

struct Lease(fs::File);
impl Lease {
    fn acquire(file: fs::File) -> io::Result<Self> {
        file.try_lock().map_err(|e| io::Error::other(format!("another bridge is running: {e}")))?;
        Ok(Self(file))
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        // A concurrent fork can retain the open file description until exec. Closing
        // only our descriptor would leave its flock held across an immediate retry.
        if let Err(reason) = self.0.unlock() { eprintln!("Could not release bridge lease: {reason}"); }
    }
}

pub fn execute(plan: &Plan, platform: &mut impl Platform) -> io::Result<Outcome> {
    if !platform.supported() { return Ok(Outcome::Manual); }
    private_dir(&plan.journal)?;
    let lock_path = plan.journal.join("run.lock");
    if fs::symlink_metadata(&lock_path).is_ok_and(|m| m.is_symlink()) { return Err(io::Error::other("bridge lock is a symlink")); }
    let mut options = fs::OpenOptions::new(); options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let _lease = Lease::acquire(options.open(lock_path)?)?;
    let receipt = plan.journal.join("plan");
    if receipt.exists() {
        if fs::read(&receipt)? != plan.binding { return Err(io::Error::other("bridge app or payload changed; old app retained")); }
    } else { private_bytes(&receipt, &plan.binding)?; }
    if plan.journal.join("removed").is_file() { return Ok(Outcome::Complete); }
    let acknowledged = plan.journal.join("acknowledged").is_file();
    let transfers = registered_transfers(plan, acknowledged)?;
    if !acknowledged {
        platform.quiescent(&transfers)?;
        // An installer may fail before any target transfer. Keep a private source snapshot
        // now, so forgetting a connection in the fallback app cannot discard its only copy.
        for (index, transfer) in transfers.iter().enumerate() {
            snapshot_source(&transfer.source, &plan.journal.join(format!("source-{index}")))?;
        }
        platform.install()?;
        platform.quiescent(&transfers)?;
        for (index, transfer) in transfers.iter().enumerate() {
            let source = plan.journal.join(format!("source-{index}"));
            snapshot_source(&transfer.source, &source)?;
            transfer_one(&Transfer { source, target: transfer.target.clone() }, &plan.journal.join(format!("copy-{index}")))?;
        }
        platform.start_and_acknowledge()?;
        marker(&plan.journal.join("acknowledged"))?;
    }
    if platform.remove_old_app()? { marker(&plan.journal.join("removed"))?; }
    Ok(Outcome::Complete)
}

/// Transfer records keep their original index, even when the current connection list changes.
/// The stable receipt above binds the apps/payload; only pre-ACK profile membership can grow.
fn registered_transfers(plan: &Plan, acknowledged: bool) -> io::Result<Vec<Transfer>> {
    let directory = plan.journal.join("transfers");
    private_dir(&directory)?;
    let mut records = Vec::new();
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        if entry.file_name() == "next" { continue; }
        let index = entry.file_name().to_string_lossy().parse::<usize>().map_err(|_| io::Error::other("invalid bridge transfer record"))?;
        records.push((index, entry.path()));
    }
    records.sort_by_key(|(index, _)| *index);
    let mut transfers = Vec::new();
    for (index, path) in records {
        if index != transfers.len() { return Err(io::Error::other("missing bridge transfer record")); }
        transfers.push(decode_transfer(&fs::read(path)?)?);
    }
    for transfer in &plan.transfers {
        let transfer = Transfer { source: std::path::absolute(&transfer.source)?, target: std::path::absolute(&transfer.target)? };
        if transfer.source == transfer.target { return Err(io::Error::other("bridge source equals target")); }
        if transfers.contains(&transfer) { continue; }
        if acknowledged || transfers.iter().any(|old| old.source == transfer.source || old.target == transfer.target) {
            return Err(io::Error::other("bridge transfer changed after acknowledgement or conflicts with a saved path"));
        }
        let mut bytes = Vec::new();
        for path in [&transfer.source, &transfer.target] {
            let encoded = encode_path(path);
            bytes.extend_from_slice(&(encoded.len() as u64).to_le_bytes()); bytes.extend(encoded);
        }
        let next = directory.join("next"); remove_staging(&next)?;
        private_bytes(&next, &bytes)?;
        fs::rename(next, directory.join(transfers.len().to_string()))?;
        transfers.push(transfer);
    }
    Ok(transfers)
}
#[cfg(unix)]
fn encode_path(path: &Path) -> Vec<u8> { use std::os::unix::ffi::OsStrExt; path.as_os_str().as_bytes().to_vec() }
#[cfg(windows)]
fn encode_path(path: &Path) -> Vec<u8> { use std::os::windows::ffi::OsStrExt; path.as_os_str().encode_wide().flat_map(u16::to_le_bytes).collect() }
#[cfg(unix)]
fn decode_path(bytes: &[u8]) -> io::Result<PathBuf> { use std::os::unix::ffi::OsStringExt; Ok(std::ffi::OsString::from_vec(bytes.to_vec()).into()) }
#[cfg(windows)]
fn decode_path(bytes: &[u8]) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    if bytes.len() % 2 != 0 { return Err(io::Error::other("invalid Windows bridge path")); }
    Ok(std::ffi::OsString::from_wide(&bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>()).into())
}
fn decode_transfer(mut bytes: &[u8]) -> io::Result<Transfer> {
    fn read_path(bytes: &mut &[u8]) -> io::Result<PathBuf> {
        let invalid = || io::Error::other("invalid bridge transfer record");
        let size = bytes.get(..8).ok_or_else(invalid)?;
        let length = usize::try_from(u64::from_le_bytes(size.try_into().unwrap())).map_err(|_| invalid())?;
        *bytes = &bytes[8..];
        let path = decode_path(bytes.get(..length).ok_or_else(invalid)?)?;
        *bytes = &bytes[length..];
        if !path.is_absolute() { return Err(invalid()); }
        Ok(path)
    }
    let source = read_path(&mut bytes)?; let target = read_path(&mut bytes)?;
    if !bytes.is_empty() { return Err(io::Error::other("trailing bridge transfer bytes")); }
    Ok(Transfer { source, target })
}
fn snapshot_source(source: &Path, snapshot: &Path) -> io::Result<()> {
    let previous = snapshot.with_extension("previous");
    if !snapshot.exists() && previous.exists() { fs::rename(&previous, snapshot)?; }
    match fs::symlink_metadata(source) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
        Ok(_) => (),
    }
    if snapshot.exists() && same_tree(source, snapshot)? { return Ok(()); }
    let next = snapshot.with_extension("next"); remove_staging(&next)?;
    copy_tree(source, &next)?;
    if !same_tree(source, &next)? { return Err(io::Error::other("bridge source changed during snapshot")); }
    remove_staging(&previous)?;
    if snapshot.exists() { fs::rename(snapshot, &previous)?; }
    fs::rename(next, snapshot)?;
    remove_staging(&previous)
}

/// An incomplete bridge-owned NSIS directory is repaired, never mistaken for an install.
pub fn install_verified(journal: &Path, destination: &Path, install: impl FnOnce() -> io::Result<()>, verify: impl Fn() -> io::Result<()>) -> io::Result<()> {
    let completed = journal.join("installation-complete");
    let started = journal.join("installation-started");
    if completed.is_file() { return verify(); }
    if !started.is_file() {
        // An independently installed app is accepted only after verification. Never repair
        // an unknown directory or overwrite someone else's installation.
        if fs::symlink_metadata(destination).is_ok() { verify()?; return marker(&completed); }
        marker(&started)?;
    }
    install()?;
    verify()?;
    marker(&completed)
}

/// NSIS scans the raw command line for a trailing unquoted /D= value, including spaces.
pub fn nsis_destination_arg(destination: &Path) -> io::Result<std::ffi::OsString> {
    if destination.as_os_str().to_string_lossy().contains(['"', '\r', '\n']) { return Err(io::Error::other("invalid NSIS destination")); }
    let mut argument = std::ffi::OsString::from("/D="); argument.push(destination); Ok(argument)
}
#[cfg(windows)]
fn append_nsis_destination(command: &mut std::process::Command, destination: &Path) -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    command.raw_arg(nsis_destination_arg(destination)?);
    Ok(())
}
#[cfg(windows)]
pub fn nsis_command(payload: &Path, destination: &Path) -> io::Result<std::process::Command> {
    let mut command = std::process::Command::new(payload);
    command.arg("/S");
    append_nsis_destination(&mut command, destination)?;
    Ok(command)
}
pub fn verify_install_location(expected: &Path, reported: &Path) -> io::Result<()> {
    if fs::canonicalize(expected)? != fs::canonicalize(reported)? { return Err(io::Error::other("NSIS installed at a different location; old app retained")); }
    Ok(())
}

pub fn shell_updates_allowed(bridge: bool, platform: &str, appimage: bool) -> bool {
    !bridge || platform != "linux" || appimage
}

/// A system-package binary cannot opt into removal merely by inheriting APPIMAGE.
pub fn appimage_install(exe: &Path, image: Option<&Path>, appdir: Option<&Path>) -> bool {
    let (Some(image), Some(appdir)) = (image, appdir) else { return false; };
    if !image.is_absolute() || !appdir.is_absolute() || !exe.starts_with(appdir) { return false; }
    let Ok(mut file) = fs::File::open(image) else { return false; };
    use std::io::Read;
    let mut header = [0; 11];
    file.read_exact(&mut header).is_ok() && &header[..4] == b"\x7fELF" && &header[8..] == b"AI\x02"
}

#[cfg(target_os = "linux")]
pub fn linux_profiles_closed(paths: &[PathBuf]) -> io::Result<()> {
    let uid = |text: &str| text.lines().find(|line| line.starts_with("Uid:")).and_then(|line| line.split_whitespace().nth(1)).map(str::to_owned);
    let mine = uid(&fs::read_to_string("/proc/self/status")?).ok_or_else(|| io::Error::other("no process uid"))?;
    let roots: Vec<_> = paths.iter().filter(|path| path.is_dir()).map(|path| fs::canonicalize(path)).collect::<io::Result<_>>()?;
    for process in fs::read_dir("/proc")? {
        let process = process?;
        if !process.file_name().to_string_lossy().bytes().all(|byte| byte.is_ascii_digit()) { continue; }
        let Ok(status) = fs::read_to_string(process.path().join("status")) else { continue; };
        if uid(&status).as_deref() != Some(&mine) { continue; }
        let is_browser = status.lines().any(|line| line.strip_prefix("Name:").is_some_and(|name| name.trim().starts_with("WebKit")));
        // Non-browser processes such as a hardened Chromium instance can deny /proc fd reads
        // even to the same uid. Shell peers are checked separately; inspect WebKit workers
        // and ourselves, whose profile handles are the ones this bridge must close.
        if process.file_name() != std::process::id().to_string().as_str() && !is_browser { continue; }
        let handles = match fs::read_dir(process.path().join("fd")) {
            Ok(handles) => handles,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for handle in handles {
            let path = match handle.and_then(|handle| fs::read_link(handle.path())) {
                Ok(path) => path,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            if roots.iter().any(|root| path.starts_with(root)) { return Err(io::Error::other("a browser profile is still open")); }
        }
    }
    Ok(())
}

/// Persist only after the window accepted the notice. Read-only homes still see the notice.
pub fn show_manual_notice(path: &Path, show: impl FnOnce() -> io::Result<()>) -> io::Result<bool> {
    if path.is_file() { return Ok(false); }
    show()?;
    let _ = marker(path);
    Ok(true)
}

fn transfer_one(transfer: &Transfer, staging: &Path) -> io::Result<()> {
    match fs::symlink_metadata(&transfer.source) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
        Ok(_) => (),
    }
    if transfer.source == transfer.target { return Err(io::Error::other("bridge source equals target")); }
    let baseline = staging.with_extension("baseline");
    let sibling = transfer.target.with_extension("squawk-bridge-stage");
    let backup = transfer.target.with_extension("squawk-bridge-previous");
    let ownership = staging.with_extension("owned");
    // Recover a crash between the two destination renames before comparing or changing data.
    if ownership.is_file() && !transfer.target.exists() && backup.exists() {
        fs::rename(&backup, &transfer.target)?;
    }
    if transfer.target.exists() || fs::symlink_metadata(&transfer.target).is_ok() {
        if staging.exists() && same_tree(staging, &transfer.target)? {
            remove_staging(&baseline)?; fs::rename(staging, &baseline)?;
        }
        let owned = baseline.exists() && same_tree(&baseline, &transfer.target)?;
        if same_tree(&transfer.source, &transfer.target)? { return Ok(()); }
        if !owned { return Err(io::Error::other(format!("bridge refuses existing destination {}", transfer.target.display()))); }
    }
    remove_staging(staging)?;
    private_dir(staging.parent().ok_or_else(|| io::Error::other("staging parent"))?)?;
    copy_tree(&transfer.source, staging)?;
    if !same_tree(&transfer.source, staging)? { return Err(io::Error::other("bridge copy verification failed")); }
    private_dir(transfer.target.parent().ok_or_else(|| io::Error::other("destination parent"))?)?;
    if ownership.is_file() { remove_staging(&sibling)?; remove_staging(&backup)?; }
    else {
        if fs::symlink_metadata(&sibling).is_ok() || fs::symlink_metadata(&backup).is_ok() { return Err(io::Error::other("bridge staging destination exists")); }
        marker(&ownership)?;
    }
    copy_tree(staging, &sibling)?;
    if !same_tree(staging, &sibling)? { return Err(io::Error::other("bridge destination verification failed")); }
    if transfer.target.exists() { fs::rename(&transfer.target, &backup)?; }
    fs::rename(&sibling, &transfer.target)?;
    remove_staging(&baseline)?; fs::rename(staging, &baseline)?;
    remove_staging(&backup)
}

fn ephemeral(name: &std::ffi::OsStr) -> bool {
    ["SingletonLock", "SingletonSocket", "SingletonCookie"].iter().any(|entry| name == *entry)
}
fn entries(path: &Path) -> io::Result<Vec<std::ffi::OsString>> {
    let mut names = fs::read_dir(path)?.map(|entry| entry.map(|e| e.file_name())).collect::<io::Result<Vec<_>>>()?;
    names.retain(|name| !ephemeral(name)); names.sort(); Ok(names)
}
fn regular(path: &Path) -> io::Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err(io::Error::other(format!("bridge refuses non-regular path {}", path.display())));
    }
    Ok(metadata)
}
pub fn same_tree(left: &Path, right: &Path) -> io::Result<bool> {
    let a = regular(left)?; let b = regular(right)?;
    if a.is_dir() != b.is_dir() { return Ok(false); }
    if a.is_file() {
        if a.len() != b.len() { return Ok(false); }
        use std::io::Read;
        let mut left = fs::File::open(left)?; let mut right = fs::File::open(right)?;
        let mut a = [0; 16384]; let mut b = [0; 16384];
        loop { let count = left.read(&mut a)?; right.read_exact(&mut b[..count])?; if a[..count] != b[..count] { return Ok(false); } if count == 0 { return Ok(true); } }
    }
    let names = entries(left)?;
    if names != entries(right)? { return Ok(false); }
    for name in names { if !same_tree(&left.join(&name), &right.join(name))? { return Ok(false); } }
    Ok(true)
}
pub fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    copy_tree_inner(source, target, true)
}
fn copy_tree_inner(source: &Path, target: &Path, root: bool) -> io::Result<()> {
    if regular(source)?.is_dir() {
        #[cfg(windows)]
        if !root {
            // New children inherit the protected root's (OI)(CI) grant.
            fs::create_dir(target)?;
        } else { private_dir(target)?; }
        #[cfg(not(windows))]
        { let _ = root; private_dir(target)?; }
        for name in entries(source)? { copy_tree_inner(&source.join(&name), &target.join(name), false)?; }
    } else {
        let mut options = fs::OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut output = options.open(target)?;
        io::copy(&mut fs::File::open(source)?, &mut output)?; output.sync_all()?;
    }
    Ok(())
}
pub fn private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    if fs::symlink_metadata(path)?.is_symlink() { return Err(io::Error::other("bridge directory is a symlink")); }
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; fs::set_permissions(path, fs::Permissions::from_mode(0o700))?; }
    #[cfg(windows)] {
        let account = operator_account()?;
        let result = std::process::Command::new("icacls.exe").arg(path).args(["/inheritance:r", "/grant:r", &format!("{account}:(OI)(CI)F")]).output()?;
        if !result.status.success() { return Err(io::Error::other("could not protect private bridge data")); }
    }
    Ok(())
}
#[cfg(windows)]
fn operator_account() -> io::Result<&'static str> {
    static ACCOUNT: std::sync::OnceLock<Result<String, String>> = std::sync::OnceLock::new();
    ACCOUNT.get_or_init(|| {
        let who = std::process::Command::new("whoami.exe").args(["/user", "/fo", "csv", "/nh"]).output().map_err(|e| e.to_string())?;
        if !who.status.success() { return Err("could not identify the bridge operator".into()); }
        let text = String::from_utf8_lossy(&who.stdout);
        let sid = text.trim().rsplit(',').next().unwrap_or("").trim_matches('"');
        if !sid.starts_with("S-1-") { return Err("invalid bridge operator SID".into()); }
        Ok(format!("*{sid}"))
    }).as_ref().map(String::as_str).map_err(|message| io::Error::other(message.clone()))
}
fn remove_staging(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
fn private_bytes(path: &Path, bytes: &[u8]) -> io::Result<()> {
    private_dir(path.parent().unwrap())?;
    let mut options = fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(path)?; file.write_all(bytes)?; file.sync_all()
}
pub fn marker(path: &Path) -> io::Result<()> { private_bytes(path, &[]) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture { root: PathBuf, plan: Plan }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("desktop-bridge-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            private_dir(&root).unwrap();
            let transfers = ["desktop-window.json", "connections.json", "profile/Cookies/cookies", "profile/LocalStorage/data"].iter().map(|name| {
                let source = root.join("old").join(name); private_dir(source.parent().unwrap()).unwrap();
                fs::write(&source, format!("fixture {name}: UUID/trust/cookie preserved")).unwrap();
                Transfer { source, target: root.join("new").join(name) }
            }).collect();
            Self { plan: Plan { journal: root.join("journal"), transfers, binding: b"fixture payload/app".to_vec() }, root }
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
    struct Fake { supported: bool, fail: &'static str, calls: Vec<&'static str> }
    impl Fake {
        fn new() -> Self { Self { supported: true, fail: "", calls: vec![] } }
        fn step(&mut self, name: &'static str) -> io::Result<()> { self.calls.push(name); if self.fail == name { Err(io::Error::other(name)) } else { Ok(()) } }
    }
    impl Platform for Fake {
        fn supported(&self) -> bool { self.supported }
        fn quiescent(&self, _: &[Transfer]) -> io::Result<()> { if self.fail == "busy" { Err(io::Error::other("busy")) } else { Ok(()) } }
        fn install(&mut self) -> io::Result<()> { self.step("install") }
        fn start_and_acknowledge(&mut self) -> io::Result<()> { self.step("start") }
        fn remove_old_app(&mut self) -> io::Result<bool> { self.step("remove")?; Ok(true) }
    }
    fn accept_when_ready(listener: &std::net::TcpListener) -> std::net::TcpStream {
        use std::time::{Duration, Instant};
        // bound: accept is the connection-ready signal; guard a lost connection.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match listener.accept() {
                Ok((stream, _)) => return stream,
                Err(reason) if reason.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline => std::thread::yield_now(),
                Err(reason) => panic!("test connection did not become ready: {reason}"),
            }
        }
    }
    fn closed_peer_then_valid_message(terminator: Option<&[u8]>, message: &[u8]) {
        use std::{net::{TcpListener, TcpStream, Shutdown}, time::{Duration, Instant}};
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let mut closed = accept_when_ready(&listener);
        // The peer closes after accept, before either mode/timeout preparation or read.
        drop(peer);
        // bound: exercise the real socket close; only guards a hung test.
        let deadline = Instant::now() + Duration::from_secs(3);
        assert!(read_accepted_message(&mut closed, terminator, 4096, deadline).is_err());
        let mut peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let mut accepted = accept_when_ready(&listener);
        peer.write_all(message).unwrap();
        if terminator.is_none() { peer.shutdown(Shutdown::Write).unwrap(); }
        // bound: a bad first connection must leave the listener able to receive this one.
        let deadline = Instant::now() + Duration::from_secs(3);
        assert_eq!(read_accepted_message(&mut accepted, terminator, 4096, deadline).unwrap(), message);
    }
    #[test]
    fn acknowledgement_listener_survives_peer_close_before_prepare() {
        closed_peer_then_valid_message(None, b"{\"token\":\"expected\"}");
    }
    #[test]
    fn fixture_listener_survives_peer_close_before_prepare() {
        closed_peer_then_valid_message(Some(b"\r\n\r\n"), b"GET /report?storage=kept HTTP/1.1\r\nCookie: bridge_auth=authenticated\r\n\r\n");
    }
    #[test]
    fn accepted_stream_waits_for_bytes_after_accept() {
        use std::{io::Read, net::{TcpListener, TcpStream}, sync::mpsc, time::Duration};
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut sender = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let mut receiver = accept_when_ready(&listener);
        // Force BSD/Windows accept semantics on every platform.
        receiver.set_nonblocking(true).unwrap();
        prepare_accepted_stream(&receiver).unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            entered_tx.send(()).unwrap();
            let mut bytes = [0; 3];
            result_tx.send(receiver.read_exact(&mut bytes).map(|_| bytes)).unwrap();
        });
        // bound: the reader signals immediately; only guards a thread startup failure.
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        // Real sockets are required to test mode inheritance. No bytes exist yet;
        // a nonblocking regression returns immediately instead of waiting for the sender.
        assert!(matches!(result_rx.recv_timeout(Duration::from_millis(50)), Err(mpsc::RecvTimeoutError::Timeout)));
        sender.write_all(b"ack").unwrap();
        // bound: the socket read timeout is two seconds; this only guards a hung test.
        assert_eq!(result_rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap(), *b"ack");
        reader.join().unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn generated_script_runs_under_restricted_process_policy() {
        let f = Fixture::new();
        let script = f.root.join("script with spaces.ps1");
        let receipt = f.root.join("script-ran");
        fs::write(&script, format!("[IO.File]::WriteAllText('{}', 'executed')", receipt.to_string_lossy().replace('\'', "''"))).unwrap();
        let restricted = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-File"]).arg(&script)
            .env("PSExecutionPolicyPreference", "Restricted").output().unwrap();
        assert!(!restricted.status.success());
        assert!(!receipt.exists());
        let output = powershell_script_command(&script).env("PSExecutionPolicyPreference", "Restricted").output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(fs::read_to_string(receipt).unwrap(), "executed");
    }
    #[cfg(windows)]
    #[test]
    fn copied_nested_directories_inherit_private_root_acl() {
        let f = Fixture::new();
        let source = f.root.join("profile-source");
        private_dir(&source.join("nested/deep")).unwrap();
        fs::write(source.join("nested/deep/Cookies"), "secret").unwrap();
        let target = f.root.join("profile-copy");
        copy_tree(&source, &target).unwrap();
        let script = f.root.join("check-acl.ps1");
        let nested = target.join("nested/deep").to_string_lossy().replace('\'', "''");
        let sid = operator_account().unwrap().trim_start_matches('*');
        fs::write(&script, format!("$acl = Get-Acl -LiteralPath '{nested}'\nif ($acl.AreAccessRulesProtected) {{ exit 1 }}\nforeach ($rule in $acl.Access) {{ if (-not $rule.IsInherited -or $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne '{sid}') {{ exit 2 }} }}\n")).unwrap();
        let output = powershell_script_command(&script).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(fs::read(target.join("nested/deep/Cookies")).unwrap(), b"secret");
    }
    #[test]
    fn partial_nsis_install_is_repaired_until_verification_commits() {
        for fail_installer in [false, true] {
            let f = Fixture::new(); private_dir(&f.plan.journal).unwrap();
            let destination = f.root.join("User Name/Programs/Squawk");
            let executable = destination.join("app.exe");
            let verify = || {
                if fs::read(&executable)? == b"verified" { Ok(()) } else { Err(io::Error::other("incomplete identity")) }
            };
            assert!(install_verified(&f.plan.journal, &destination, || {
                private_dir(&destination)?; fs::write(&executable, "partial")?;
                if fail_installer { Err(io::Error::other("NSIS failed")) } else { Ok(()) }
            }, &verify).is_err());
            assert!(!f.plan.journal.join("installation-complete").exists());
            install_verified(&f.plan.journal, &destination, || { fs::write(&executable, "verified") }, &verify).unwrap();
            assert!(f.plan.journal.join("installation-complete").is_file());
            install_verified(&f.plan.journal, &destination, || panic!("verified install must not rerun"), &verify).unwrap();
            assert!(f.plan.transfers[0].source.is_file());
        }
    }
    #[test]
    fn incomplete_independent_install_is_never_claimed_for_repair() {
        let f = Fixture::new(); private_dir(&f.plan.journal).unwrap();
        let destination = f.root.join("independent"); private_dir(&destination).unwrap();
        assert!(install_verified(&f.plan.journal, &destination, || panic!("not bridge owned"), || Err(io::Error::other("independent"))).is_err());
        assert!(!f.plan.journal.join("installation-started").exists());
    }
    #[test]
    fn nsis_destination_is_unquoted_and_registry_location_must_match() {
        let destination = Path::new(r"C:\Users\User Name\AppData\Local\Programs\Squawk");
        assert_eq!(nsis_destination_arg(destination).unwrap(), std::ffi::OsStr::new(r"/D=C:\Users\User Name\AppData\Local\Programs\Squawk"));
        assert!(nsis_destination_arg(Path::new("bad\"path")).is_err());
        let f = Fixture::new();
        let requested = f.root.join("User Name/Programs/Squawk"); let fallback = f.root.join("User Name/Squawk");
        private_dir(&requested).unwrap(); private_dir(&fallback).unwrap();
        verify_install_location(&requested, &requested).unwrap();
        assert!(verify_install_location(&requested, &fallback).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn windows_process_receives_the_raw_nsis_destination_with_spaces() {
        let destination = Path::new(r"C:\Users\User Name\AppData\Local\Programs\Squawk");
        let mut command = std::process::Command::new("powershell.exe");
        // The comment makes PowerShell ignore the NSIS tail while reporting the actual
        // process command line. Use the same raw-argument helper as the installer builder.
        command.args(["-NoProfile", "-NonInteractive", "-Command", "[Environment]::CommandLine #"]);
        append_nsis_destination(&mut command, destination).unwrap();
        let output = command.output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let raw = String::from_utf8_lossy(&output.stdout);
        assert!(raw.trim_end().ends_with(&format!(" {}", nsis_destination_arg(destination).unwrap().to_string_lossy())), "{raw}");
    }
    #[test]
    fn changed_connection_lists_replan_and_preserve_every_profile_before_ack() {
        for step in ["install", "start"] {
            let mut f = Fixture::new(); let mut platform = Fake::new(); platform.fail = step;
            f.plan.transfers.truncate(2);
            let forgotten = Transfer { source: f.root.join("old/profile"), target: f.root.join("new/profile") };
            f.plan.transfers.push(forgotten.clone());
            assert!(execute(&f.plan, &mut platform).is_err());
            // Forget deletes its source store in the old app. The durable union still owns
            // the earlier snapshot, even when the installer failed before target copying.
            fs::remove_dir_all(&forgotten.source).unwrap(); f.plan.transfers.pop();
            let added = Transfer { source: f.root.join("old/added-profile"), target: f.root.join("new/added-profile") };
            private_dir(&added.source).unwrap(); fs::write(added.source.join("cookie"), "new authenticated session").unwrap();
            // Insert first to prove old copy indices and their ownership records stay stable.
            f.plan.transfers.insert(0, added.clone());
            fs::write(&f.plan.transfers[2].source, "current connection list after add/forget").unwrap();
            platform.fail = ""; execute(&f.plan, &mut platform).unwrap();
            assert!(forgotten.target.join("Cookies/cookies").is_file());
            assert!(forgotten.target.join("LocalStorage/data").is_file());
            assert!(same_tree(&added.source, &added.target).unwrap());
            assert_eq!(fs::read_to_string(&f.plan.transfers[2].target).unwrap(), "current connection list after add/forget");
            assert!(!forgotten.source.exists());
            execute(&f.plan, &mut platform).unwrap();
        }
    }
    #[test]
    fn acknowledged_profile_set_cannot_be_extended_before_old_app_removal() {
        let mut f = Fixture::new(); let mut platform = Fake::new(); platform.fail = "remove";
        assert!(execute(&f.plan, &mut platform).is_err());
        f.plan.transfers.push(Transfer { source: f.root.join("old/late"), target: f.root.join("new/late") });
        platform.calls.clear(); platform.fail = "";
        assert!(execute(&f.plan, &mut platform).is_err()); assert!(platform.calls.is_empty());
    }
    #[test]
    fn manual_linux_bridge_blocks_update_check_and_install() {
        for format in ["deb", "arch"] {
            assert!(!shell_updates_allowed(true, "linux", false), "{format} must not invoke install_deb");
        }
        assert!(shell_updates_allowed(true, "linux", true));
        for platform in ["linux", "macos", "windows"] {
            assert!(shell_updates_allowed(false, platform, false));
        }
        assert!(shell_updates_allowed(true, "macos", false));
        assert!(shell_updates_allowed(true, "windows", false));
    }
    #[test]
    fn transfers_state_before_ack_then_removes_and_never_overwrites_new_state() {
        let f = Fixture::new(); let mut platform = Fake::new();
        assert_eq!(execute(&f.plan, &mut platform).unwrap(), Outcome::Complete);
        assert_eq!(platform.calls, ["install", "start", "remove"]);
        for transfer in &f.plan.transfers { assert!(same_tree(&transfer.source, &transfer.target).unwrap()); }
        fs::write(&f.plan.transfers[0].target, "new geometry").unwrap();
        platform.calls.clear(); execute(&f.plan, &mut platform).unwrap();
        assert!(platform.calls.is_empty());
        assert_eq!(fs::read_to_string(&f.plan.transfers[0].target).unwrap(), "new geometry");
    }
    #[test]
    fn every_failure_preserves_source_and_retry_is_idempotent() {
        for step in ["busy", "install", "start", "remove"] {
            let f = Fixture::new(); let mut platform = Fake::new(); platform.fail = step;
            assert!(execute(&f.plan, &mut platform).is_err());
            for transfer in &f.plan.transfers { assert!(fs::read_to_string(&transfer.source).unwrap().starts_with("fixture")); }
            if step != "remove" { assert!(!platform.calls.contains(&"remove")); }
            platform.fail = ""; platform.calls.clear(); execute(&f.plan, &mut platform).unwrap();
            if step == "remove" { assert_eq!(platform.calls, ["remove"]); }
        }
    }
    #[test]
    fn conflicting_target_or_failed_transfer_never_starts_or_removes() {
        let f = Fixture::new(); let mut platform = Fake::new();
        private_dir(f.plan.transfers[1].target.parent().unwrap()).unwrap();
        fs::write(&f.plan.transfers[1].target, "existing independent connection").unwrap();
        assert!(execute(&f.plan, &mut platform).is_err());
        assert_eq!(platform.calls, ["install"]);
        assert_eq!(fs::read_to_string(&f.plan.transfers[1].target).unwrap(), "existing independent connection");
        fs::remove_file(&f.plan.transfers[1].target).unwrap();
        execute(&f.plan, &mut platform).unwrap();
    }
    #[test]
    fn system_packages_do_not_start_any_bridge_operation() {
        for _format in ["deb", "arch"] {
            let f = Fixture::new(); let mut platform = Fake::new(); platform.supported = false;
            assert_eq!(execute(&f.plan, &mut platform).unwrap(), Outcome::Manual);
            assert!(platform.calls.is_empty()); assert!(!f.plan.journal.exists()); assert!(!f.root.join("new").exists());
        }
    }
    #[test]
    fn retry_refreshes_unchanged_bridge_owned_state_but_keeps_independent_edits() {
        let f = Fixture::new(); let mut platform = Fake::new(); platform.fail = "start";
        assert!(execute(&f.plan, &mut platform).is_err());
        fs::write(&f.plan.transfers[0].source, "old app moved its window").unwrap();
        platform.fail = ""; execute(&f.plan, &mut platform).unwrap();
        assert_eq!(fs::read_to_string(&f.plan.transfers[0].target).unwrap(), "old app moved its window");
        let f = Fixture::new(); let mut platform = Fake::new(); platform.fail = "start";
        assert!(execute(&f.plan, &mut platform).is_err());
        fs::write(&f.plan.transfers[0].target, "independent new window").unwrap();
        platform.fail = ""; assert!(execute(&f.plan, &mut platform).is_err());
        assert_eq!(fs::read_to_string(&f.plan.transfers[0].target).unwrap(), "independent new window");
    }
    #[test]
    fn changed_inputs_never_reuse_an_acknowledgement_to_remove_another_app() {
        let mut f = Fixture::new(); let mut platform = Fake::new(); platform.fail = "remove";
        assert!(execute(&f.plan, &mut platform).is_err());
        f.plan.binding = b"another installation".to_vec(); platform.calls.clear();
        assert!(execute(&f.plan, &mut platform).is_err()); assert!(platform.calls.is_empty());
    }
    #[test]
    fn deb_and_arch_cannot_be_mistaken_for_an_appimage() {
        let f = Fixture::new(); let image = f.root.join("old.AppImage"); let appdir = f.root.join(".mount");
        let exe = appdir.join("usr/bin/cezar-desktop");
        fs::write(&image, b"\x7fELF\0\0\0\0AI\x02").unwrap();
        assert!(appimage_install(&exe, Some(&image), Some(&appdir)));
        for package_exe in [Path::new("/usr/bin/cezar-desktop"), Path::new("/opt/cezar-desktop")] {
            assert!(!appimage_install(package_exe, Some(&image), Some(&appdir)));
        }
        assert!(!appimage_install(&exe, None, Some(&appdir)));
        fs::write(&image, "not an appimage").unwrap();
        assert!(!appimage_install(&exe, Some(&image), Some(&appdir)));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn refuses_a_live_profile_file_until_its_owner_closes_it() {
        let f = Fixture::new(); let profile = f.root.join("old/profile");
        let file = fs::File::open(profile.join("Cookies/cookies")).unwrap();
        assert!(linux_profiles_closed(&[profile.clone()]).is_err());
        drop(file);
        linux_profiles_closed(&[profile]).unwrap();
    }
    #[test]
    fn manual_notice_is_dismissible_once_and_a_failed_show_does_not_hide_it() {
        let f = Fixture::new(); let seen = f.root.join("notice-seen");
        assert!(show_manual_notice(&seen, || Err(io::Error::other("no window"))).is_err());
        assert!(!seen.exists());
        assert!(show_manual_notice(&seen, || Ok(())).unwrap());
        assert!(!show_manual_notice(&seen, || panic!("already shown")).unwrap());
    }
    #[test]
    fn another_bridge_cannot_start_the_same_transaction() {
        let f = Fixture::new(); private_dir(&f.plan.journal).unwrap();
        let lease = fs::OpenOptions::new().read(true).write(true).create_new(true).open(f.plan.journal.join("run.lock")).unwrap();
        lease.try_lock().unwrap();
        let mut platform = Fake::new(); assert!(execute(&f.plan, &mut platform).is_err());
        assert!(platform.calls.is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn lease_drop_unlocks_even_when_a_fork_retains_its_file_description() {
        let f = Fixture::new(); private_dir(&f.plan.journal).unwrap();
        let lock = f.plan.journal.join("run.lock");
        let lease = Lease::acquire(fs::OpenOptions::new().read(true).write(true).create_new(true).open(&lock).unwrap()).unwrap();
        // dup and fork share the same open file description and flock ownership.
        let inherited = lease.0.try_clone().unwrap();
        let contender = fs::OpenOptions::new().read(true).write(true).open(lock).unwrap();
        assert!(contender.try_lock().is_err());
        drop(lease);
        // Reacquire while the inherited description is still open; dropping just the
        // parent descriptor would leave the original lock held and fail this assertion.
        contender.try_lock().unwrap();
        contender.unlock().unwrap();
        drop(inherited);
    }
    #[test]
    fn profile_tree_is_private_and_refuses_symlink_escape() {
        let f = Fixture::new(); let source = f.root.join("old/profile"); let target = f.root.join("copy");
        copy_tree(&source, &target).unwrap(); assert!(same_tree(&source, &target).unwrap());
        #[cfg(unix)] {
            use std::os::unix::{fs::PermissionsExt, fs::symlink};
            assert_eq!(fs::metadata(target.join("Cookies/cookies")).unwrap().permissions().mode() & 0o777, 0o600);
            symlink("/outside", source.join("unexpected-link")).unwrap();
            assert!(copy_tree(&source, &f.root.join("unsafe")).is_err());
        }
    }
}
