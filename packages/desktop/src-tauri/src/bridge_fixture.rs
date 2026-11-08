//! Native CI fixture only. Never compiled into a normal installer.
use std::{fs, io::{Read, Write}, net::TcpListener, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

pub fn run_if_asked() -> bool {
    let args: Vec<_> = std::env::args().collect();
    let value = |key| args.iter().position(|arg| arg == key).and_then(|i| args.get(i + 1));
    let Some(mode) = value("--desktop-browser-fixture") else { return false; };
    assert_eq!(std::env::var("GITHUB_ACTIONS").as_deref(), Ok("true"), "native browser fixture runs only on CI");
    let root = PathBuf::from(value("--fixture-dir").expect("--fixture-dir"));
    let port: u16 = value("--fixture-port").expect("--fixture-port").parse().unwrap();
    if mode == "transfer" {
        super::bridge::fixture_transfer().expect("bridge fixture transfer");
        return true;
    }
    assert!(mode == "seed" || mode == "verify");
    let seed = mode == "seed";
    fs::create_dir_all(&root).unwrap();
    let id_path = root.join("connection-id");
    let id = if seed { let id = Uuid::new_v4(); fs::write(&id_path, id.to_string()).unwrap(); id }
        else { Uuid::parse_str(&fs::read_to_string(id_path).unwrap()).unwrap() };
    let endpoint = format!("http://127.0.0.1:{port}/");
    let connection = serde_json::json!([{ "id": id, "endpoint": endpoint, "signInOrigin": "https://identity.example/" }]);
    let home = super::desktop_home();
    if seed {
        fs::create_dir_all(home.state.join("desktop")).unwrap();
        fs::write(home.state.join("desktop/connections.json"), connection.to_string()).unwrap();
        fs::write(home.state.join("desktop-window.json"), br#"{"x":100,"y":120,"width":1100,"height":800,"maximized":false}"#).unwrap();
    } else {
        let actual: serde_json::Value = serde_json::from_slice(&fs::read(home.state.join("desktop/connections.json")).unwrap()).unwrap();
        assert_eq!(actual, connection, "UUID and trust origins must survive");
        assert_eq!(fs::read(home.state.join("desktop-window.json")).unwrap(), br#"{"x":100,"y":120,"width":1100,"height":800,"maximized":false}"#);
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let passed = Arc::new(AtomicBool::new(false)); let result = passed.clone();
    tauri::Builder::default().setup(move |app| {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(45);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        super::bridge_state::prepare_accepted_stream(&stream).unwrap();
                        let mut bytes = Vec::new(); let mut buffer = [0; 1024];
                        while bytes.len() < 16384 && !bytes.ends_with(b"\r\n\r\n") {
                            let count = stream.read(&mut buffer).unwrap_or(0); if count == 0 { break; }
                            bytes.extend_from_slice(&buffer[..count]);
                        }
                        let request = String::from_utf8_lossy(&bytes);
                        if request.starts_with("GET /report?storage=kept ") {
                            let cookie = request.lines().any(|line| line.to_ascii_lowercase().starts_with("cookie:") && line.contains("bridge_auth=authenticated"));
                            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
                            result.store(cookie, Ordering::SeqCst);
                            handle.exit(if cookie { 0 } else { 1 }); return;
                        }
                        let set_cookie = if seed { "Set-Cookie: bridge_auth=authenticated; Max-Age=86400; HttpOnly; SameSite=Lax\r\n" } else { "" };
                        let seed_script = if seed { "localStorage.setItem('bridge_fixture','kept');" } else { "" };
                        let body = format!("<!doctype html><script>{seed_script}fetch('/report?storage='+encodeURIComponent(localStorage.getItem('bridge_fixture')))</script>");
                        let response = format!("HTTP/1.1 200 OK\r\n{set_cookie}Content-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                        let _ = stream.write_all(response.as_bytes());
                    },
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(25)),
                    Err(_) => break,
                }
            }
            handle.exit(1);
        });
        let builder = WebviewWindowBuilder::new(app, "bridge-fixture", WebviewUrl::External(endpoint.parse().unwrap()));
        #[cfg(target_os = "macos")]
        let builder = builder.data_store_identifier(*id.as_bytes());
        #[cfg(not(target_os = "macos"))]
        let builder = builder.data_directory(home.data.join("desktop/profiles").join(id.to_string()));
        builder.build()?;
        Ok(())
    }).run(tauri::generate_context!()).expect("native browser fixture app");
    assert!(passed.load(Ordering::SeqCst), "native cookie and local storage did not survive");
    true
}
