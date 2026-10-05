//! Remote pages never receive native capabilities or the local shell's initialization script.
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::{Host, Url};
mod profiles;
use profiles::{Connection, load, save, persistent_sessions_supported};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

pub fn validate_endpoint(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Enter an absolute HTTPS address.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("Use an address without embedded credentials, query parameters or fragments. Sign in on the server's page.".into());
    }
    let loopback = match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(host)) => host == "localhost",
        None => false,
    };
    if url.host().is_none() || !(url.scheme() == "https" || (url.scheme() == "http" && loopback)) {
        return Err("Remote connections require HTTPS. HTTP is allowed only on loopback for an SSH tunnel.".into());
    }
    Ok(url)
}

fn bundled_caller(window: &WebviewWindow) -> bool {
    matches!(window.label(), "main" | "connections") && window.url().map(|u| {
        u.scheme() == "tauri" && u.host_str() == Some("localhost") ||
        matches!(u.scheme(), "http" | "https") && u.host_str() == Some("tauri.localhost")
    }).unwrap_or(false)
}

/// A separately trusted sign-in server must be an HTTPS origin, never a credential URL.
fn validate_sign_in_origin(raw: Option<&str>) -> Result<Option<Url>, String> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else { return Ok(None); };
    let url = validate_endpoint(raw)?;
    if url.scheme() != "https" || url.path() != "/" {
        return Err("The trusted sign-in origin must be HTTPS with no path, for example https://auth.example.com.".into());
    }
    Ok(Some(url))
}

fn navigation_allowed(target: &Url, endpoint: &Url, sign_in: Option<&Url>) -> bool {
    target.username().is_empty() && target.password().is_none()
        && matches!(target.scheme(), "https" | "http")
        && (target.origin() == endpoint.origin() || sign_in.is_some_and(|url| target.origin() == url.origin()))
}

#[tauri::command]
pub async fn connect_remote(app: AppHandle, window: WebviewWindow, endpoint: String, sign_in_origin: Option<String>, remember: Option<bool>) -> Result<(), String> {
    if !bundled_caller(&window) { return Err("Connections can only be opened from the native connection screen.".into()); }
    let url = validate_endpoint(&endpoint)?;
    let sign_in = validate_sign_in_origin(sign_in_origin.as_deref())?;
    let profile = if remember.unwrap_or(false) {
        let _guard = profiles::STORE_LOCK.lock().map_err(|e| e.to_string())?;
        let mut entries = load(&profiles::store_path());
        let connection = profiles::find_or_create(&mut entries, &url, sign_in.as_ref())?;
        save(&profiles::store_path(), &entries)?;
        Some(connection)
    } else { None };
    let origin = url.origin();
    let label = profile.as_ref().map(|p| format!("remote-{}", p.id)).unwrap_or_else(|| format!("remote-temporary-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)));
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }
    let title = format!("Cezarion — {}", origin.ascii_serialization());
    let endpoint = url.clone();
    let navigation_app = app.clone();
    let builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url));
    let builder = profile_builder(builder, profile.as_ref());
    builder
        .title(&title).inner_size(1360.0, 900.0).min_inner_size(720.0, 480.0)
        .on_navigation(move |target| {
            if navigation_allowed(target, &endpoint, sign_in.as_ref()) { return true; }
            // Never include the redirect query/fragment: it may contain an SSO token.
            // The blocked origin is informational; it is NOT automatically trusted.
            let message = format!("Blocked redirect to {}. If this is your sign-in provider, enter its HTTPS origin in Trusted sign-in origin and reconnect.", target.origin().ascii_serialization());
            let feedback = ConnectionFeedback {
                endpoint: endpoint.as_str().to_string(),
                sign_in_origin: sign_in.as_ref().map(|url| url.origin().ascii_serialization()).unwrap_or_default(),
                message,
            };
            let app = navigation_app.clone();
            let _ = navigation_app.run_on_main_thread(move || { let _ = show_connection_form(&app, Some(feedback)); });
            false
        })
        .on_new_window(|url, _| {
            if url.scheme() == "https" { super::open_url(url.as_str()); }
            tauri::webview::NewWindowResponse::Deny
        })
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

// Persistent profiles never share the local cockpit's or another connection's storage.
fn profile_builder<'a>(builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>, profile: Option<&Connection>) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    if let Some(profile) = profile.filter(|_| persistent_sessions_supported()) {
        #[cfg(target_os = "macos")]
        { return builder.data_store_identifier(*profile.id.as_bytes()); }
        #[cfg(not(target_os = "macos"))]
        { return builder.data_directory(profiles::profile_path(profile.id)); }
    }
    builder.incognito(true)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionList {
    connections: Vec<Connection>,
    persistent_sessions: bool,
}

#[tauri::command]
pub fn list_connections(window: WebviewWindow) -> Result<ConnectionList, String> {
    if !bundled_caller(&window) { return Err("Only the connection screen can read saved connections.".into()); }
    Ok(ConnectionList { connections: load(&profiles::store_path()), persistent_sessions: persistent_sessions_supported() })
}

#[tauri::command]
pub async fn forget_connection(app: AppHandle, window: WebviewWindow, id: String) -> Result<(), String> {
    if !bundled_caller(&window) { return Err("Only the connection screen can forget connections.".into()); }
    let id = uuid::Uuid::parse_str(&id).map_err(|_| "Invalid connection ID.")?;
    let connection = load(&profiles::store_path()).into_iter().find(|p| p.id == id).ok_or("Connection no longer exists.")?;
    // Wait until the live webview is gone before deleting its profile. Otherwise a
    // page still running could recreate cookies during sign-out.
    if let Some(active) = app.get_webview_window(&format!("remote-{}", id)) {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        active.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) { let _ = tx.try_send(()); }
        });
        active.close().map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(5)))
            .await.map_err(|e| e.to_string())?.map_err(|_| "Close the remote window, then try forgetting it again.")?;
    }
    #[cfg(target_os = "macos")]
    if persistent_sessions_supported() {
        for attempt in 0..30 {
            match app.remove_data_store(*connection.id.as_bytes()).await {
                Ok(()) => break,
                Err(e) if attempt == 29 => return Err(format!("Could not clear the saved sign-in: {e}")),
                Err(_) => {
                    // WKWebView can retain its data store briefly after Destroyed.
                    tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(100)))
                        .await.map_err(|e| e.to_string())?;
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let directory = profiles::profile_path(connection.id);
        tauri::async_runtime::spawn_blocking(move || {
            // WebView2 can briefly hold profile files after its window is destroyed.
            for attempt in 0..30 {
                match std::fs::remove_dir_all(&directory) {
                    Ok(()) => return Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                    Err(e) if attempt == 29 => return Err(e.to_string()),
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
                }
            }
            unreachable!()
        }).await.map_err(|e| e.to_string())??;
    }
    let _guard = profiles::STORE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut entries = load(&profiles::store_path());
    entries.retain(|p| p.id != id);
    save(&profiles::store_path(), &entries)
}

#[derive(serde::Serialize)]
struct ConnectionFeedback {
    endpoint: String,
    sign_in_origin: String,
    message: String,
}

pub fn show_connections(app: &AppHandle) -> tauri::Result<()> {
    show_connection_form(app, None)
}

fn show_connection_form(app: &AppHandle, feedback: Option<ConnectionFeedback>) -> tauri::Result<()> {
    // This script executes only in the bundled, navigation-restricted connection form.
    let script = feedback.map(|feedback| format!(r#"(() => {{
        const data = {};
        const apply = () => {{
            window.connectionFeedback = data;
            document.getElementById('endpoint').value = data.endpoint;
            document.getElementById('sign-in-origin').value = data.sign_in_origin;
            document.getElementById('error').textContent = data.message;
            document.dispatchEvent(new Event('connection-feedback'));
        }};
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, {{ once: true }});
        else apply();
    }})()"#, serde_json::to_string(&feedback).expect("serializable feedback")));
    if let Some(window) = app.get_webview_window("connections") {
        if let Some(script) = script { window.eval(&script)?; }
        window.show()?; return window.set_focus();
    }
    let builder = WebviewWindowBuilder::new(app, "connections", WebviewUrl::App("connections.html".into()))
        .title("Cezarion — Connect to a server").inner_size(960.0, 700.0).min_inner_size(740.0, 600.0)
        .on_navigation(|u| u.scheme() == "tauri" && u.host_str() == Some("localhost") ||
            matches!(u.scheme(), "http" | "https") && u.host_str() == Some("tauri.localhost"));
    let builder = if let Some(script) = script { builder.initialization_script(script) } else { builder };
    builder.build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_remote_and_loopback_tunnels_only() {
        for value in ["https://cockpit.example/", "https://192.168.1.2:8443/", "http://127.0.0.1:4321/", "http://[::1]:4321/", "http://localhost:4321/"] {
            assert!(validate_endpoint(value).is_ok(), "{value}");
        }
        for value in ["http://cockpit.example/", "http://192.168.1.2/", "http://127.evil.example/", "http://localhost.evil.example/", "file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com/", "https://example.com/?token=secret", "https://example.com/#token", "not a URL"] {
            assert!(validate_endpoint(value).is_err(), "{value}");
        }
    }
    #[test]
    fn sign_in_origin_is_optional_and_https_only() {
        assert!(validate_sign_in_origin(None).unwrap().is_none());
        assert!(validate_sign_in_origin(Some(" ")).unwrap().is_none());
        assert!(validate_sign_in_origin(Some("https://auth.example.com")).unwrap().is_some());
        for raw in ["http://localhost", "https://auth.example.com/login", "https://u:p@auth.example.com", "https://auth.example.com/?token=x", "https://auth.example.com/#x"] {
            assert!(validate_sign_in_origin(Some(raw)).is_err(), "{raw}");
        }
    }

    #[test]
    fn only_the_explicit_sign_in_origin_and_cockpit_may_navigate() {
        let endpoint = Url::parse("https://cockpit.example.com").unwrap();
        let auth = Url::parse("https://auth.example.com").unwrap();
        let login = Url::parse("https://auth.example.com/?rd=https%3A%2F%2Fcockpit.example.com").unwrap();
        assert!(!navigation_allowed(&login, &endpoint, None));
        assert!(navigation_allowed(&login, &endpoint, Some(&auth)));
        assert!(navigation_allowed(&Url::parse("https://cockpit.example.com/p/project/?code=secret").unwrap(), &endpoint, Some(&auth)));
        for raw in ["http://auth.example.com", "https://auth.example.com.evil.test", "https://elsewhere.example.com", "https://auth.example.com:8443", "https://u:p@auth.example.com", "file:///etc/passwd", "https://127.0.0.1"] {
            assert!(!navigation_allowed(&Url::parse(raw).unwrap(), &endpoint, Some(&auth)), "{raw}");
        }
    }

    #[test]
    fn remote_windows_have_no_capability_grants() {
        let local: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(local["windows"], serde_json::json!(["main"]));
        let connections: serde_json::Value = serde_json::from_str(include_str!("../capabilities/connections.json")).unwrap();
        assert!(connections.get("remote").is_none());
        assert_eq!(connections["windows"], serde_json::json!(["main", "connections"]));
    }
}
