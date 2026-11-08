//! Product environment and managed paths. Build metadata owns the identity selection.
use std::{ffi::{OsStr, OsString}, path::{Path, PathBuf}};

pub fn env_os(suffix: &str) -> Option<OsString> {
    lookup(suffix, |key| std::env::var_os(key))
}
fn lookup(suffix: &str, get: impl Fn(&str) -> Option<OsString>) -> Option<OsString> {
    get(&format!("HSQ_{suffix}")).or_else(|| get(&format!("CEZ_{suffix}")))
}
pub fn env(suffix: &str) -> Option<String> { env_os(suffix).and_then(|v| v.into_string().ok()) }

/// Pin both aliases even in an old-ID shell: a newer sidecar reads HSQ first.
pub fn generated_env(suffix: &str, value: impl AsRef<OsStr>) -> [(String, OsString); 2] {
    [(format!("HSQ_{suffix}"), value.as_ref().into()), (format!("CEZ_{suffix}"), value.as_ref().into())]
}

pub fn package_entry(root: &Path, selected: &str, legacy: &str, next: &str) -> PathBuf {
    [selected, legacy, next].iter().map(|name| root.join("node_modules").join(name).join("dist/index.js"))
        .find(|entry| entry.is_file())
        .unwrap_or_else(|| root.join("node_modules").join(selected).join("dist/index.js"))
}

#[derive(Debug, PartialEq)]
pub struct Home { pub config: PathBuf, pub state: PathBuf, pub data: PathBuf, pub legacy: PathBuf }

/// Matches resolveHome / kind-roots.ts. HOME deliberately has separate (non-alias) rules.
pub fn home(user: &Path, platform: &str, rebrand: bool, get: impl Fn(&str) -> Option<OsString>) -> Home {
    let value = |key: &str| get(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    let legacy_default = user.join(".cezar");
    let legacy = value("CEZ_HOME").unwrap_or_else(|| legacy_default.clone());
    if !rebrand { return Home { config: legacy.clone(), state: legacy.clone(), data: legacy.clone(), legacy }; }
    let preferred = value("HSQ_HOME").or_else(|| {
        // Windows paths are case insensitive. Normalize lexical components as resolveHome does.
        let normalize = |p: &Path| {
            let absolute = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
            let mut clean = PathBuf::new();
            for component in absolute.components() {
                match component { std::path::Component::CurDir => {}, std::path::Component::ParentDir => { clean.pop(); }, other => clean.push(other.as_os_str()) }
            }
            let text = clean.to_string_lossy().into_owned();
            if platform == "windows" { text.to_lowercase() } else { text }
        };
        (normalize(&legacy) != normalize(&legacy_default)).then(|| legacy.clone())
    });
    if let Some(root) = preferred {
        return Home { config: root.join("config"), state: root.join("state"), data: root.join("data"), legacy };
    }
    let (config, state, data) = match platform {
        "macos" => {
            let support = user.join("Library/Application Support/Hearsay Squawk");
            (support.join("config"), support.join("state"), support.join("data"))
        },
        "windows" => {
            let roaming = value("APPDATA").unwrap_or_else(|| user.join("AppData/Roaming")).join("Hearsay Squawk");
            let local = value("LOCALAPPDATA").unwrap_or_else(|| user.join("AppData/Local")).join("Hearsay Squawk");
            (roaming, local.join("state"), local.join("data"))
        },
        _ => {
            let xdg = |key, fallback| value(key).filter(|p| p.is_absolute()).unwrap_or_else(|| user.join(fallback)).join("hearsay-squawk");
            (xdg("XDG_CONFIG_HOME", ".config"), xdg("XDG_STATE_HOME", ".local/state"), xdg("XDG_DATA_HOME", ".local/share"))
        }
    };
    Home { config, state, data, legacy }
}

/// D13: boot/repair from the source tree until the P2 copy commits. Never run from a
/// target installation that migration may replace underneath the running process.
pub fn versions_root(home: &Home, rebrand: bool, committed: bool, pending: bool) -> Result<PathBuf, &'static str> {
    let target = home.data.join("versions");
    if !rebrand { return Ok(target); }
    if home.config.join(".migrating").exists() || home.legacy.join(".migrating").exists() {
        return Err("Home migration is in progress. Retry after it finishes.");
    }
    if committed { return Ok(target); }
    let legacy = home.legacy.join("versions");
    if legacy.exists() { return Ok(legacy); }
    if pending { return Err("Home migration is pending; a fresh target installation cannot start yet."); }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_use_presence_including_empty() {
        let get = |k: &str| match k { "HSQ_DESKTOP_NODE" => Some("".into()), "CEZ_DESKTOP_NODE" => Some("old".into()), _ => None };
        assert_eq!(lookup("DESKTOP_NODE", get), Some("".into()));
        assert_eq!(lookup("ONLY", |k| (k == "CEZ_ONLY").then(|| "legacy".into())), Some("legacy".into()));
        assert_eq!(lookup("MISSING", |_| None), None);
    }
    #[test]
    fn generated_values_replace_inherited_aliases() {
        for rebrand in [false, true] {
            for suffix in ["DESKTOP", "SUPERVISED", "SUPERVISOR_PID", "SUPERVISOR_STDIN", "DISCLAIM_EXEC"] {
                let mut command = std::process::Command::new("unused");
                command.env(format!("HSQ_{suffix}"), "hostile").env(format!("CEZ_{suffix}"), "old");
                command.envs(generated_env(suffix, "generated"));
                for (key, value) in command.get_envs() {
                    assert_eq!(value, Some(OsStr::new("generated")), "{rebrand}: {key:?}");
                }
            }
        }
    }
    #[test]
    fn home_roots_follow_p2_and_keep_legacy_override_separate() {
        let user = Path::new("/users/test");
        let empty = |_: &str| None;
        let old = home(user, "linux", false, |k| (k == "HSQ_HOME").then(|| "/ignored".into()));
        assert_eq!(old.config, user.join(".cezar"));
        let linux = home(user, "linux", true, empty);
        assert_eq!(linux.config, user.join(".config/hearsay-squawk"));
        assert_eq!(linux.state, user.join(".local/state/hearsay-squawk"));
        assert_eq!(linux.data, user.join(".local/share/hearsay-squawk"));
        assert_eq!(home(user, "macos", true, empty).data, user.join("Library/Application Support/Hearsay Squawk/data"));
        assert_eq!(home(user, "windows", true, empty).config, user.join("AppData/Roaming/Hearsay Squawk"));
        for prefix in ["HSQ_HOME", "CEZ_HOME"] {
            let custom = home(user, "linux", true, |k| (k == prefix).then(|| "/custom".into()));
            assert_eq!(custom.config, Path::new("/custom/config"));
            assert_eq!(custom.data, Path::new("/custom/data"));
        }
        assert_eq!(home(user, "linux", true, |k| (k == "XDG_DATA_HOME").then(|| "relative".into())).data, linux.data);
        let both = home(user, "linux", true, |k| match k { "HSQ_HOME" => Some("/new".into()), "CEZ_HOME" => Some("/old".into()), _ => None });
        assert_eq!(both.config, Path::new("/new/config"));
        assert_eq!(both.legacy, Path::new("/old"));
    }
    #[test]
    fn managed_root_order_keeps_the_running_legacy_tree_outside_the_copy_target() {
        let root = std::env::temp_dir().join(format!("desktop-order-{}", std::process::id()));
        let home = Home { config: root.join("new/config"), state: root.join("new/state"), data: root.join("new/data"), legacy: root.join("old") };
        std::fs::create_dir_all(&home.config).unwrap();
        let old = home.legacy.join("versions"); let new = home.data.join("versions");
        // Fresh: no legacy versions directory. An initial new install is safe from P2 copy.
        assert_eq!(versions_root(&home, true, false, false).unwrap(), new);
        let write_entry = |versions: &Path, contents: &str| {
            let entry = versions.join("current/node_modules/@old/package/dist/index.js");
            std::fs::create_dir_all(entry.parent().unwrap()).unwrap(); std::fs::write(entry, contents).unwrap();
        };
        write_entry(&new, "target entry");
        assert_eq!(versions_root(&home, true, false, false).unwrap(), new);
        // Empty and interrupted legacy directories select source-side repair. Even an
        // existing target entry cannot win before the migration commits.
        for name in ["", ".staging/incomplete"] {
            std::fs::create_dir_all(old.join(name)).unwrap();
            let chosen = versions_root(&home, true, false, false).unwrap();
            assert_eq!(chosen, old);
            assert!(!package_entry(&chosen.join("current"), "@old/package", "@old/package", "@new/package").is_file());
            assert_eq!(versions_root(&home, true, false, true).unwrap(), old);
        }
        write_entry(&old, "running legacy entry");
        let chosen = versions_root(&home, true, false, false).unwrap();
        assert_eq!(std::fs::read_to_string(package_entry(&chosen.join("current"), "@old/package", "@old/package", "@new/package")).unwrap(), "running legacy entry");
        // Only a committed migration selects the new managed tree while legacy still exists.
        let chosen = versions_root(&home, true, true, false).unwrap();
        assert_eq!(chosen, new);
        assert_eq!(std::fs::read_to_string(package_entry(&chosen.join("current"), "@old/package", "@old/package", "@new/package")).unwrap(), "target entry");
        std::fs::remove_dir_all(&old).unwrap();
        assert!(versions_root(&home, true, false, true).is_err());
        for claim in [home.config.join(".migrating"), home.legacy.join(".migrating")] {
            std::fs::create_dir_all(claim.parent().unwrap()).unwrap(); std::fs::write(&claim, "claimed").unwrap();
            assert!(versions_root(&home, true, false, false).is_err());
            // Ordinary switch-off behavior stays at its own data root.
            assert_eq!(versions_root(&home, false, false, true).unwrap(), new);
            std::fs::remove_file(claim).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn both_package_names_remain_openable() {
        let root = std::env::temp_dir().join(format!("desktop-product-{}", std::process::id()));
        for name in ["@old/package", "@new/package"] {
            let entry = root.join("node_modules").join(name).join("dist/index.js");
            std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
            std::fs::write(&entry, "// fixture").unwrap();
            assert_eq!(package_entry(&root, "@new/package", "@old/package", "@new/package"), entry);
            std::fs::remove_dir_all(root.join("node_modules")).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
