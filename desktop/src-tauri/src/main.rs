// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::RngCore;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Resolves the real, on-disk directory holding the built client
/// (client/dist, staged by desktop/scripts/build-sidecar.sh into
/// desktop/src-tauri/resources/public and declared as a Tauri bundle
/// resource in tauri.conf.json). The sidecar binary can't serve its static
/// assets straight out of its own bunfs embed (see
/// desktop/src-tauri/sidecar-src/entry.mjs), so it needs this as a real
/// path via the MEDUSA_SIDECAR_PUBLIC_DIR env var.
fn resolve_public_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .resolve("resources/public", BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
}

/// Holds the running sidecar child so it can be killed on window close / app exit.
struct SidecarState(Mutex<Option<CommandChild>>);

/// Picks a free TCP port on 127.0.0.1 by binding to port 0 and reading back
/// the OS-assigned port, then immediately releasing the listener. There is a
/// small race between releasing the listener and the sidecar binding the same
/// port, but it mirrors what the previous Swift shell already tolerated.
fn pick_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind to an ephemeral port");
    let port = listener.local_addr().expect("failed to read local addr").port();
    drop(listener);
    port
}

/// Generates a random 32-byte hex auth token, matching the format the Node
/// server itself would generate in server/src/config.ts if AUTH_TOKEN is unset.
fn generate_auth_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Synchronously GETs http://127.0.0.1:<port>/api/health and returns true on
/// a 200 response. Implemented with a raw TcpStream instead of an HTTP crate
/// to keep the dependency footprint (and compile time) small for this
/// localhost-only health check.
fn health_check_ok(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect(&addr) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() && response.is_empty() {
        return false;
    }

    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

/// Polls the health endpoint until it responds or `timeout` elapses.
fn wait_for_health(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if health_check_ok(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

/// Creates the main window up front, pointed at about:blank, with an
/// initialization script that injects the auth token into localStorage on
/// *every* page load in this window (including the redirect to the sidecar
/// URL once it's healthy). This mirrors what the old Swift
/// WebViewController did for the WKWebView after each navigation finished
/// (see app/Sources/WebViewController.swift), but as an init script instead
/// of a one-shot post-load evaluate, since here the token must be present
/// before the redirected page's own JS (client/src/socket.ts) runs.
fn create_main_window(app: &AppHandle, auth_token: &str) -> tauri::Result<()> {
    let init_script = format!("localStorage.setItem('auth-token', '{auth_token}');");

    // WebviewUrl::App treats its string as a path *within* frontendDist, so
    // "about:blank" there would resolve to a missing file in client/dist and
    // render a blank/errored page. WebviewUrl::External with a real
    // "about:blank" URL is what actually gives a blank starting page here.
    let blank = "about:blank".parse().expect("about:blank is a valid URL");

    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(blank))
        .title("Medusa")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .initialization_script(&init_script)
        .build()?;

    Ok(())
}

/// Spawns the bundled medusa-server sidecar with PORT/HOST/AUTH_TOKEN set,
/// waits for its health endpoint, then navigates the main window to it.
fn start_sidecar_and_navigate(app: &AppHandle, port: u16, auth_token: String) {
    let shell = app.shell();
    let mut command = shell
        .sidecar("medusa-server")
        .expect("failed to resolve medusa-server sidecar")
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("AUTH_TOKEN", auth_token.clone());

    if let Some(public_dir) = resolve_public_dir(app) {
        command = command.env("MEDUSA_SIDECAR_PUBLIC_DIR", public_dir.to_string_lossy().to_string());
    }
    // If no bundled resource is found (e.g. `cargo run` without a `tauri
    // build`/`tauri dev` resource copy step having run yet), entry.mjs falls
    // back to the co-located server/dist/public on disk.

    let (mut rx, child) = command.spawn().expect("failed to spawn medusa-server sidecar");

    // Drain the sidecar's stdout/stderr into the terminal Tauri was launched
    // from, so `npm run tauri dev` shows server logs like scripts/dev.sh does.
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    print!("[medusa-server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprint!("[medusa-server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(err) => {
                    eprintln!("[medusa-server] error: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[medusa-server] exited: {:?}", payload.code);
                    break;
                }
                _ => {}
            }
        }
    });

    app.state::<SidecarState>()
        .0
        .lock()
        .unwrap()
        .replace(child);

    let app_handle = app.clone();
    std::thread::spawn(move || {
        // Same 30s startup budget the Swift ServerManager used (pollHealth timeout).
        let healthy = wait_for_health(port, Duration::from_secs(30));

        if !healthy {
            eprintln!("[medusa-desktop] server did not become healthy within 30s on port {port}");
            return;
        }

        let url = format!("http://127.0.0.1:{port}");
        if let Some(window) = app_handle.get_webview_window("main") {
            match url.parse() {
                Ok(target) => {
                    // The window's initialization_script (see
                    // create_main_window) reruns on this navigation and sets
                    // the auth token before client/src/socket.ts runs.
                    if let Err(e) = window.navigate(target) {
                        eprintln!("[medusa-desktop] failed to navigate window: {e}");
                    }
                }
                Err(e) => eprintln!("[medusa-desktop] failed to parse server URL {url}: {e}"),
            }
        } else {
            eprintln!("[medusa-desktop] main window not found when trying to navigate");
        }
    });
}

fn kill_sidecar(app: &AppHandle) {
    if let Some(child) = app.state::<SidecarState>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let port = pick_free_port();
            let auth_token = generate_auth_token();

            create_main_window(app.handle(), &auth_token)?;
            start_sidecar_and_navigate(app.handle(), port, auth_token);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                kill_sidecar(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Medusa desktop app")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_sidecar(app_handle);
            }
        });
}
