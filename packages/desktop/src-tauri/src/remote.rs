//! Remote pages never receive native capabilities or the local shell's initialization script.
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::{Host, Url};
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

#[tauri::command]
pub fn connect_remote(app: AppHandle, window: WebviewWindow, endpoint: String) -> Result<(), String> {
    if !bundled_caller(&window) { return Err("Connections can only be opened from the native connection screen.".into()); }
    let url = validate_endpoint(&endpoint)?;
    let origin = url.origin();
    let label = format!("remote-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let title = format!("Cezarion — {}", origin.ascii_serialization());
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title(&title).inner_size(1360.0, 900.0).min_inner_size(720.0, 480.0)
        // No persistent credentials/cookies, no sharing the local cockpit's web storage.
        .incognito(true)
        .on_navigation(move |target| target.origin() == origin && matches!(target.scheme(), "https" | "http"))
        .on_new_window(|url, _| {
            if url.scheme() == "https" { super::open_url(url.as_str()); }
            tauri::webview::NewWindowResponse::Deny
        })
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn show_connections(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("connections") {
        window.show()?; return window.set_focus();
    }
    WebviewWindowBuilder::new(app, "connections", WebviewUrl::App("connections.html".into()))
        .title("Cezarion — Connect to a server").inner_size(600.0, 440.0).resizable(false)
        .on_navigation(|u| u.scheme() == "tauri" && u.host_str() == Some("localhost") ||
            matches!(u.scheme(), "http" | "https") && u.host_str() == Some("tauri.localhost"))
        .build()?;
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
    fn remote_windows_have_no_capability_grants() {
        let local: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(local["windows"], serde_json::json!(["main"]));
        let connections: serde_json::Value = serde_json::from_str(include_str!("../capabilities/connections.json")).unwrap();
        assert!(connections.get("remote").is_none());
        assert_eq!(connections["windows"], serde_json::json!(["main", "connections"]));
    }
}
