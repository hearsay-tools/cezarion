//! Bookmarks contain addresses and a random browser-profile identifier, never passwords.
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, sync::Mutex};
use url::Url;
use uuid::Uuid;
pub(super) static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: Uuid,
    pub endpoint: String,
    pub sign_in_origin: Option<String>,
}

pub fn store_path() -> PathBuf { super::super::cezar_home().join("desktop/connections.json") }
#[cfg(not(target_os = "macos"))]
pub fn profile_path(id: Uuid) -> PathBuf { super::super::cezar_home().join("desktop/profiles").join(id.to_string()) }

pub fn persistent_sessions_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *SUPPORTED.get_or_init(|| std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|version| version.trim().split('.').next()?.parse::<u32>().ok())
            .is_some_and(|major| major >= 14))
    }
    #[cfg(not(target_os = "macos"))]
    { true }
}

pub fn load(path: &Path) -> Vec<Connection> {
    let rows: Vec<serde_json::Value> = fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    let mut entries = Vec::new();
    for row in rows.into_iter().take(100) {
        let Ok(entry) = serde_json::from_value::<Connection>(row) else { continue; };
        if entry.id.is_nil() || entries.iter().any(|p: &Connection| p.id == entry.id) { continue; }
        let Ok(endpoint) = super::validate_endpoint(&entry.endpoint) else { continue; };
        let Ok(sign_in) = super::validate_sign_in_origin(entry.sign_in_origin.as_deref()) else { continue; };
        entries.push(Connection { id: entry.id, endpoint: endpoint.to_string(), sign_in_origin: sign_in.map(|u| u.to_string()) });
    }
    entries
}

pub fn find_or_create(entries: &mut Vec<Connection>, endpoint: &Url, sign_in: Option<&Url>) -> Result<Connection, String> {
    let endpoint = endpoint.to_string();
    let sign_in_origin = sign_in.map(|u| u.to_string());
    if let Some(entry) = entries.iter().find(|p| p.endpoint == endpoint && p.sign_in_origin == sign_in_origin) { return Ok(entry.clone()); }
    if entries.len() >= 100 { return Err("Forget an unused connection before adding another.".into()); }
    let entry = Connection { id: Uuid::new_v4(), endpoint, sign_in_origin };
    entries.push(entry.clone());
    Ok(entry)
}

pub fn save(path: &Path, entries: &[Connection]) -> Result<(), String> {
    let write = || -> std::io::Result<()> {
        let parent = path.parent().expect("connection store parent");
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?; }
        let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let result = (|| {
            use std::io::Write;
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec_pretty(entries)?)?;
            file.sync_all()?;
            fs::rename(&temporary, path)
        })();
        if result.is_err() { let _ = fs::remove_file(temporary); }
        result
    };
    write().map_err(|_| "Could not save this connection. Uncheck Remember to open a temporary session.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_survives_reload_and_trust_changes_are_isolated() {
        let dir = std::env::temp_dir().join(format!("cezar-profiles-{}", Uuid::new_v4()));
        let path = dir.join("connections.json");
        let endpoint = Url::parse("https://cockpit.example/").unwrap();
        let auth = Url::parse("https://auth.example/").unwrap();
        let mut entries = vec![];
        let first = find_or_create(&mut entries, &endpoint, Some(&auth)).unwrap();
        save(&path, &entries).unwrap();
        let mut restored = load(&path);
        assert_eq!(first.id, find_or_create(&mut restored, &endpoint, Some(&auth)).unwrap().id);
        assert_ne!(first.id, find_or_create(&mut restored, &endpoint, None).unwrap().id);
        assert_ne!(first.id, find_or_create(&mut restored, &Url::parse("https://other.example/").unwrap(), Some(&auth)).unwrap().id);
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600); }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn malformed_entries_do_not_remove_valid_bookmarks() {
        let dir = std::env::temp_dir().join(format!("cezar-profiles-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("connections.json");
        let id = Uuid::new_v4();
        fs::write(&path, serde_json::json!([
            {"id": id, "endpoint":"https://ok.example", "signInOrigin":null},
            {"id": Uuid::new_v4(), "endpoint":"https://user:password@bad.example"},
            {"id": "../../escape", "endpoint":"https://bad.example"},
            {"id": Uuid::new_v4(), "endpoint":"https://bad.example", "signInOrigin":"http://auth.example"},
            {"id": id, "endpoint":"https://duplicate.example"}, null
        ]).to_string()).unwrap();
        assert_eq!(load(&path).len(), 1);
        fs::write(&path, "broken").unwrap();
        assert!(load(&path).is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
