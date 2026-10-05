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
pub fn connect_remote(app: AppHandle, window: WebviewWindow, endpoint: String, sign_in_origin: Option<String>) -> Result<(), String> {
    if !bundled_caller(&window) { return Err("Connections can only be opened from the native connection screen.".into()); }
    let url = validate_endpoint(&endpoint)?;
    let sign_in = validate_sign_in_origin(sign_in_origin.as_deref())?;
    let origin = url.origin();
    let label = format!("remote-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let title = format!("Cezarion — {}", origin.ascii_serialization());
    let endpoint = url.clone();
    let navigation_app = app.clone();
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title(&title).inner_size(1360.0, 900.0).min_inner_size(720.0, 480.0)
        // No persistent credentials/cookies, no sharing the local cockpit's web storage.
        .incognito(true)
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
            document.getElementById('endpoint').value = data.endpoint;
            document.getElementById('sign-in-origin').value = data.sign_in_origin;
            document.getElementById('error').textContent = data.message;
        }};
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, {{ once: true }});
        else apply();
    }})()"#, serde_json::to_string(&feedback).expect("serializable feedback")));
    if let Some(window) = app.get_webview_window("connections") {
        if let Some(script) = script { window.eval(&script)?; }
        window.show()?; return window.set_focus();
    }
    let builder = WebviewWindowBuilder::new(app, "connections", WebviewUrl::App("connections.html".into()))
        .title("Cezarion — Connect to a server").inner_size(640.0, 620.0).resizable(false)
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
