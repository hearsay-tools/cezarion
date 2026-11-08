//! Filesystem-only bridge transaction. Sources are never moved or removed.
use std::{fs, io::{self, Write}, path::{Path, PathBuf}};

pub struct Transfer { pub source: PathBuf, pub target: PathBuf }
pub struct Plan { pub journal: PathBuf, pub transfers: Vec<Transfer>, pub binding: Vec<u8> }
#[derive(Debug, PartialEq)]
pub enum Outcome { Manual, Complete }

pub trait Platform {
    fn supported(&self) -> bool;
    fn quiescent(&self, transfers: &[Transfer]) -> io::Result<()>;
    fn install(&mut self) -> io::Result<()>;
    /// Return only after the new app confirms that its native window started.
    fn start_and_acknowledge(&mut self) -> io::Result<()>;
    fn remove_old_app(&mut self) -> io::Result<bool>;
}

pub fn execute(plan: &Plan, platform: &mut impl Platform) -> io::Result<Outcome> {
    if !platform.supported() { return Ok(Outcome::Manual); }
    private_dir(&plan.journal)?;
    let lock_path = plan.journal.join("run.lock");
    if fs::symlink_metadata(&lock_path).is_ok_and(|m| m.is_symlink()) { return Err(io::Error::other("bridge lock is a symlink")); }
    let mut options = fs::OpenOptions::new(); options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let lease = options.open(lock_path)?;
    lease.try_lock().map_err(|e| io::Error::other(format!("another bridge is running: {e}")))?;
    let mut binding = plan.binding.clone();
    for transfer in &plan.transfers {
        for path in [&transfer.source, &transfer.target] {
            let absolute = std::path::absolute(path)?;
            let bytes = absolute.as_os_str().as_encoded_bytes();
            binding.extend_from_slice(&(bytes.len() as u64).to_le_bytes()); binding.extend_from_slice(bytes);
        }
    }
    let receipt = plan.journal.join("plan");
    if receipt.exists() {
        if fs::read(&receipt)? != binding { return Err(io::Error::other("bridge inputs changed; old app retained")); }
    } else { private_bytes(&receipt, &binding)?; }
    if plan.journal.join("removed").is_file() { return Ok(Outcome::Complete); }
    if !plan.journal.join("acknowledged").is_file() {
        platform.quiescent(&plan.transfers)?;
        platform.install()?;
        platform.quiescent(&plan.transfers)?;
        for (index, transfer) in plan.transfers.iter().enumerate() {
            transfer_one(transfer, &plan.journal.join(format!("copy-{index}")))?;
        }
        platform.start_and_acknowledge()?;
        marker(&plan.journal.join("acknowledged"))?;
    }
    if platform.remove_old_app()? { marker(&plan.journal.join("removed"))?; }
    Ok(Outcome::Complete)
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
    if regular(source)?.is_dir() {
        private_dir(target)?;
        for name in entries(source)? { copy_tree(&source.join(&name), &target.join(name))?; }
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
        let who = std::process::Command::new("whoami.exe").args(["/user", "/fo", "csv", "/nh"]).output()?;
        if !who.status.success() { return Err(io::Error::other("could not identify the bridge operator")); }
        let text = String::from_utf8_lossy(&who.stdout);
        let sid = text.trim().rsplit(',').next().unwrap_or("").trim_matches('"');
        if !sid.starts_with("S-1-") { return Err(io::Error::other("invalid bridge operator SID")); }
        let account = format!("*{sid}");
        let result = std::process::Command::new("icacls.exe").arg(path).args(["/inheritance:r", "/grant:r", &format!("{account}:(OI)(CI)F")]).output()?;
        if !result.status.success() { return Err(io::Error::other("could not protect private bridge data")); }
    }
    Ok(())
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
