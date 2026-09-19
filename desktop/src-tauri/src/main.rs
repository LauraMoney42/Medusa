// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::RngCore;
use tauri::menu::{Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// True once the user has chosen Quit from the tray menu (or another true
/// exit path). Close-to-tray only applies when this is false -- see
/// on_window_event below.
struct QuitRequested(std::sync::atomic::AtomicBool);

/// Resolves the real, on-disk directory holding the built client
/// (client/dist, staged by desktop/scripts/build-sidecar.sh into
/// desktop/src-tauri/resources/public and declared as a Tauri bundle
/// resource in tauri.conf.json). Passed to the sidecar as MEDUSA_STATIC_DIR
/// (see server/src/config.ts), which overrides the server's default
/// __dirname-relative resolution -- necessary because a `bun build
/// --compile` binary flattens every module's import.meta.url, so that
/// default would otherwise resolve inside the bundle's virtual filesystem.
fn resolve_public_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .resolve("resources/public", BaseDirectory::Resource)
        .ok()
        .filter(|p| p.exists())
}

/// Resolves the bundled `medusa-mcp-shim` sidecar binary's absolute path, the
/// same way Tauri itself resolves the `medusa-server` sidecar it spawns
/// below (relative to the current executable's directory -- Contents/MacOS
/// on macOS -- with the target-triple suffix stripped for a packaged
/// bundle). Passed to the server sidecar as MEDUSA_MCP_SHIM_BIN.
///
/// Why this can't just be `resolve_public_dir`'s BaseDirectory::Resource
/// trick: sidecar binaries live in bundle.externalBin, not bundle.resources,
/// and Tauri's `Shell::sidecar()` is the one place that already knows how to
/// turn "medusa-mcp-shim" into that real path (see
/// desktop/scripts/build-sidecar.sh for how the triple-suffixed binary gets
/// there). `Command::new_sidecar` only resolves a path -- it does not touch
/// the process -- so `.into::<std::process::Command>()` reads that resolved
/// program back out without ever spawning it, and needs no `shell:allow-*`
/// capability grant (those gate the frontend's `invoke` commands, not
/// backend Rust calls into the plugin's Rust API).
fn resolve_mcp_shim_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let command = app.shell().sidecar("medusa-mcp-shim").ok()?;
    let std_command: std::process::Command = command.into();
    let path = std::path::PathBuf::from(std_command.get_program());
    if path.exists() {
        Some(path)
    } else {
        eprintln!(
            "[medusa-desktop] medusa-mcp-shim sidecar not found at {}; subagent tools will be unavailable",
            path.display()
        );
        None
    }
}

/// Resolves a real, writable, per-user directory for the server's runtime
/// data (uploads/, default-bots.json, and the auto-generated .env), passed
/// as MEDUSA_DATA_DIR / MEDUSA_ENV_FILE. Falls back to a fixed path under
/// Application Support if Tauri's app-data-dir resolution fails for some
/// reason, matching the directory the old entry.mjs shim used by default.
fn resolve_data_dir(app: &AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| {
            dirs_home_fallback().join("Library/Application Support/Medusa")
        })
        .join("server-data");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn dirs_home_fallback() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// Holds the running sidecar child so it can be killed on window close / app exit.
struct SidecarState(Mutex<Option<CommandChild>>);

/// Prefer this fixed port across launches so the webview's origin
/// (http://127.0.0.1:<port>) stays stable. A stable origin means WKWebView's
/// localStorage for this app is the SAME storage every time, so data written
/// last week is still readable and versioned as expected. A random port
/// every launch (the previous behavior) made each run a distinct origin,
/// which mostly meant a fresh, empty localStorage -- until the OS's ephemeral
/// port allocator happened to recycle a port an EARLIER, unrelated launch had
/// used, at which point WKWebView silently resurrected that old origin's
/// leftover data. If that data predates a schema change (a store shape that
/// no longer matches what the current bundle expects), reading it can throw
/// during module evaluation -- before React even mounts, before any
/// ErrorBoundary exists to catch it -- producing a permanently blank window
/// with no error visible anywhere. A stable port turns that from "rare,
/// unreproducible, silent" into "the same origin every time," so real data
/// migrations are the only source of schema drift, not port-recycling luck.
const PREFERRED_PORT: u16 = 51763;

/// Binds to `PREFERRED_PORT` if it's free, else falls back to an OS-assigned
/// ephemeral port (binding to port 0 and reading back the assignment), then
/// immediately releases the listener. There is a small race between
/// releasing the listener and the sidecar binding the same port, but it
/// mirrors what the previous Swift shell already tolerated.
fn pick_free_port() -> u16 {
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)) {
        drop(listener);
        return PREFERRED_PORT;
    }
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

/// How long startup may take before the splash starts telling the user that
/// this is slower than usual. Not a deadline: `wait_for_health` keeps
/// polling past it (see there for why there is no deadline at all).
const SLOW_STARTUP_NOTICE: Duration = Duration::from_secs(20);

/// Polls the health endpoint until it responds, reporting progress to the
/// boot splash as it goes. Returns true once the server answers, or false if
/// `sidecar_dead` is set first (the process exited, so no amount of waiting
/// will produce a healthy server).
///
/// There is deliberately no give-up timeout. This used to stop after 30s and
/// simply `return`, which left the window parked on about:blank forever with
/// no message, no retry and nothing in the UI -- a solid black window that
/// looked exactly like a crashed app even though the server was fine and
/// came up a few seconds later. A cold start blows through any fixed budget
/// easily: the first launch after a rebuild pays for Gatekeeper's first-run
/// scan of a freshly compiled 60MB sidecar binary on top of the server's own
/// startup. Since the sidecar is our own child process, "not healthy yet"
/// only ever means "still starting": waiting is always the right answer, and
/// the splash keeps the user informed while we do.
fn wait_for_health(
    app: &AppHandle,
    port: u16,
    sidecar_dead: &std::sync::atomic::AtomicBool,
) -> bool {
    let start = Instant::now();
    poll_for_health(
        port,
        &|| health_check_ok(port),
        &|| sidecar_dead.load(std::sync::atomic::Ordering::SeqCst),
        &|| start.elapsed(),
        &mut |status, detail| set_boot_status(app, status, detail),
        &|d| std::thread::sleep(d),
    )
}

/// The polling loop behind `wait_for_health`, with every side effect passed
/// in so the waiting policy itself can be unit tested without a real server,
/// a real clock or a real window (see the tests at the bottom of this file).
fn poll_for_health(
    port: u16,
    healthy: &dyn Fn() -> bool,
    dead: &dyn Fn() -> bool,
    elapsed: &dyn Fn() -> Duration,
    report: &mut dyn FnMut(&str, &str),
    sleep: &dyn Fn(Duration),
) -> bool {
    let mut warned = false;
    // The poll runs every 300ms but the status line only counts whole
    // seconds, so repaint at most once per second rather than evaluating JS
    // in the webview three times for the same text.
    let mut last_reported_secs = u64::MAX;
    loop {
        if healthy() {
            return true;
        }
        // Checked after the health probe: a server that answered and then
        // exited in the same tick still counts as healthy, and the window
        // gets its chance to load.
        if dead() {
            return false;
        }
        let waited = elapsed();
        if waited >= SLOW_STARTUP_NOTICE && !warned {
            warned = true;
            eprintln!(
                "[medusa-desktop] server still starting after {}s on port {port}; still waiting",
                waited.as_secs()
            );
        }
        if warned && waited.as_secs() != last_reported_secs {
            last_reported_secs = waited.as_secs();
            report(
                "Still starting the local server…",
                &format!(
                    "This is taking longer than usual ({}s). The first launch after an \
                     update is slower while macOS verifies the new app. Medusa will open \
                     as soon as the server answers on port {port}.",
                    waited.as_secs()
                ),
            );
        }
        sleep(Duration::from_millis(300));
    }
}

/// Paints the boot splash into whatever document this window is currently
/// showing. Runs as part of the window's initialization script, so it also
/// covers the about:blank document the window starts on -- before the
/// sidecar is healthy there is no app to show, and an unpainted about:blank
/// renders as a featureless black rectangle that is indistinguishable from a
/// crashed app. `set_boot_status` updates the message in place as startup
/// progresses; the whole splash is discarded by the navigation to the real
/// UI, since that replaces the document.
/// Updates the boot splash message shown by client/public/boot.html, the
/// page this window starts on.
///
/// Best-effort, and guarded on the function existing: once the window has
/// navigated to the real app the splash is gone and this is a no-op. A
/// failure here only means the user sees a slightly staler status line,
/// never a broken startup, so errors are swallowed rather than propagated.
fn set_boot_status(app: &AppHandle, status: &str, detail: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let script = format!(
            "window.__medusaBootStatus && window.__medusaBootStatus({}, {});",
            serde_json::to_string(status).unwrap_or_else(|_| "\"\"".into()),
            serde_json::to_string(detail).unwrap_or_else(|_| "\"\"".into()),
        );
        let _ = window.eval(&script);
    }
}

/// Creates the main window up front, pointed at about:blank, with an
/// initialization script that injects the auth token into localStorage on
/// *every* page load in this window (including the redirect to the sidecar
/// URL once it's healthy). This mirrors what the old Swift
/// WebViewController did for the WKWebView after each navigation finished
/// (see app/Sources/WebViewController.swift), but as an init script instead
/// of a one-shot post-load evaluate, since here the token must be present
/// before the redirected page's own JS (client/src/socket.ts) runs.
///
/// The window starts on client/public/boot.html (a real bundled page), not
/// about:blank. about:blank is why a slow server start looked like a crashed
/// app: it paints as a solid black rectangle, and neither an initialization
/// script nor a `WebviewWindow::eval` from Rust reaches that initial empty
/// document -- both were tried against a real build and neither drew
/// anything. A bundled page has neither problem, and `set_boot_status` can
/// talk to it.
fn create_main_window(app: &AppHandle, auth_token: &str) -> tauri::Result<()> {
    let init_script = format!("localStorage.setItem('auth-token', '{auth_token}');");

    // WebviewUrl::App resolves its path within frontendDist (client/dist),
    // where vite copies client/public/boot.html verbatim.
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("boot.html".into()))
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
        .env("AUTH_TOKEN", auth_token.clone())
        // Tells the server it is running inside the desktop shell (see
        // server/src/config.ts: isDesktop) so future desktop-only features
        // (folder picker, Finder integration) can branch on it. No
        // behavior change today.
        .env("MEDUSA_DESKTOP", "1");

    if let Some(public_dir) = resolve_public_dir(app) {
        command = command.env("MEDUSA_STATIC_DIR", public_dir.to_string_lossy().to_string());
    }
    // If no bundled resource is found (e.g. `cargo run` without a `tauri
    // build`/`tauri dev` resource copy step having run yet), the server
    // falls back to its own default (server/dist/public, next to the
    // compiled sidecar) -- see server/src/config.ts.

    // MEDUSA_MCP_SHIM_BIN tells server/src/mcp/descriptor.ts to hand engines
    // this bundled binary directly instead of `node <shim path>` -- inside
    // the compiled server sidecar that script path resolves inside its own
    // virtual filesystem, so `node` can never find it and every engine's MCP
    // connection (and with it, the whole turn) fails. If the shim binary is
    // missing (e.g. a `cargo run` dev build with no sidecar build step),
    // this is left unset and server/src/mcp/config.ts's descriptorForSession
    // degrades gracefully: it logs a warning and spawns engines without
    // --mcp-config rather than failing chat entirely.
    if let Some(shim_path) = resolve_mcp_shim_path(app) {
        command = command.env("MEDUSA_MCP_SHIM_BIN", shim_path.to_string_lossy().to_string());
    }

    let data_dir = resolve_data_dir(app);
    command = command
        .env("MEDUSA_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env("MEDUSA_ENV_FILE", data_dir.join(".env").to_string_lossy().to_string());

    let (mut rx, child) = command.spawn().expect("failed to spawn medusa-server sidecar");

    // Set when the sidecar process goes away. `wait_for_health` waits
    // indefinitely for a *starting* server, so it needs to be told when there
    // is no longer a server to wait for -- otherwise a sidecar that dies on
    // startup would spin the poll loop forever behind the splash.
    let sidecar_dead = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let sidecar_dead_writer = sidecar_dead.clone();

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
                    sidecar_dead_writer.store(true, std::sync::atomic::Ordering::SeqCst);
                    break;
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[medusa-server] exited: {:?}", payload.code);
                    sidecar_dead_writer.store(true, std::sync::atomic::Ordering::SeqCst);
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

    // Paint the splash straight away. Until the server answers there is
    // nothing else in this window, and an unpainted about:blank is a solid
    // black rectangle that reads as a hung app.
    set_boot_status(app, "Starting the local server…", "");

    let app_handle = app.clone();
    std::thread::spawn(move || {
        // Waits for as long as the sidecar is alive and still starting; the
        // only way out without a healthy server is the sidecar dying.
        let healthy = wait_for_health(&app_handle, port, &sidecar_dead);

        if !healthy {
            eprintln!("[medusa-desktop] medusa-server exited before it became healthy");
            set_boot_status(
                &app_handle,
                "The local server stopped unexpectedly.",
                "Medusa could not start its server, so there is nothing to show. \
                 Quit Medusa from the menu bar icon and open it again; if this keeps \
                 happening, the server's output is in Console.app under medusa-server.",
            );
            return;
        }

        // The auth token rides in the URL fragment (never a query string):
        // fragments are not transmitted to the server and never appear in
        // server access logs or the RateLimit-tracked request path, but
        // client/src/api.ts can still read them from location.hash on boot.
        let url = format!("http://127.0.0.1:{port}/#medusa-auth={auth_token}");
        if let Some(window) = app_handle.get_webview_window("main") {
            match url.parse() {
                Ok(target) => {
                    // The window's initialization_script (see
                    // create_main_window) is a secondary path: it reruns on
                    // this navigation and sets the auth token before
                    // client/src/socket.ts runs, but init scripts are not
                    // guaranteed to fire on a navigate() of an existing
                    // window in every webview engine. The primary handoff is
                    // the URL fragment below: client/src/api.ts reads
                    // location.hash on boot, pulls the token out of it, and
                    // clears the fragment with history.replaceState. A
                    // fragment (not a query string) never leaves the
                    // browser: it is not sent to the server and never shows
                    // up in server access logs.
                    if let Err(e) = window.navigate(target) {
                        eprintln!("[medusa-desktop] failed to navigate window: {e}");
                        // The splash is still the live document here, so say
                        // so rather than leaving it on "Starting…" forever.
                        set_boot_status(
                            &app_handle,
                            "Could not open the Medusa interface.",
                            &format!("The server is running on port {port}, but the window \
                                      could not load it ({e}). Quit Medusa from the menu bar \
                                      icon and open it again."),
                        );
                    }
                }
                Err(e) => eprintln!("[medusa-desktop] failed to parse server URL {url}: {e}"),
            }
        } else {
            eprintln!("[medusa-desktop] main window not found when trying to navigate");
        }
    });
}

/// Tauri command backing the client's Tauri capture path (see
/// client/src/components/Input/captureScreen.ts). Shells out to the macOS
/// `screencapture` CLI as a first pass -- good enough for full-screen,
/// interactive-window, and interactive-region capture without pulling in
/// ScreenCaptureKit bindings. Returns the PNG as a base64 string, or an Err
/// string (surfaced to JS as a rejected promise) if the user cancels or the
/// capture otherwise fails.
///
/// mode: None/"fullscreen" -> whole screen, "windowPicker" -> click-a-window,
/// "regionPicker" -> drag-to-select region.
#[tauri::command]
fn capture_screen(mode: Option<String>) -> Result<String, String> {
    use base64::Engine;
    use std::process::Command;

    let tmp = std::env::temp_dir().join(format!("medusa-capture-{}.png", std::process::id()));
    let _ = std::fs::remove_file(&tmp);

    let mut cmd = Command::new("screencapture");
    match mode.as_deref() {
        Some("windowPicker") => {
            cmd.args(["-i", "-w"]); // interactive, restricted to window selection
        }
        Some("regionPicker") => {
            cmd.arg("-i"); // interactive drag-to-select region
        }
        _ => {
            cmd.arg("-x"); // silent full-screen capture
        }
    }
    cmd.arg(&tmp);

    let status = cmd
        .status()
        .map_err(|e| format!("failed to run screencapture: {e}"))?;

    if !status.success() || !tmp.exists() {
        // screencapture exits 0 even when the user hits Esc during an
        // interactive selection, so the file's presence is the real signal.
        let _ = std::fs::remove_file(&tmp);
        return Err("capture_cancelled".to_string());
    }

    let bytes = std::fs::read(&tmp).map_err(|e| format!("failed to read capture: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Tauri command backing the New Chat modal's folder picker (see
/// client/src/components/Sidebar/NewChatModal.tsx: pickFolderViaTauri).
///
/// This is the reliable path: `window.__TAURI__.dialog.open` never exists in
/// this app's webview, because `withGlobalTauri` only injects the core
/// `invoke`/`event`/`path`/`window` bindings, not per-plugin JS wrappers --
/// those come from separate `@tauri-apps/plugin-*` npm packages, and this
/// project never added `@tauri-apps/plugin-dialog`. Rather than pull in that
/// package, the frontend calls this command by name (also reachable, as a
/// second path, via `core.invoke('plugin:dialog|open', ...)` directly),
/// which runs tauri-plugin-dialog's blocking picker on the Rust side, where
/// the plugin is actually registered (see `.plugin(tauri_plugin_dialog::init())`
/// below). Returns `None` if the user cancels or the path can't be
/// represented as a plain filesystem path.
#[tauri::command]
fn pick_folder(app: AppHandle, default_path: Option<String>) -> Option<String> {
    let mut builder = app.dialog().file();
    if let Some(dir) = default_path.filter(|d| !d.trim().is_empty()) {
        builder = builder.set_directory(dir);
    }
    builder
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

/// Tauri command backing the chat header's folder-chip click (see
/// client/src/components/Chat/ChatView.tsx: handleFolderChipClick). Same
/// rationale as `pick_folder` above: `window.__TAURI__.shell.open` never
/// exists without the `@tauri-apps/plugin-shell` JS package, so this reveals
/// the path in Finder directly from Rust instead, via the `open` CLI (macOS)
/// with a `-R` (reveal, don't launch) flag. Falls back to just opening the
/// path if it isn't macOS-specific `open -R` behavior that's wanted, since
/// this app only ships for macOS today.
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| format!("failed to run open -R: {e}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("open -R exited with status {status}"))
            }
        })
}

/// Shows and focuses the main window; used by both the tray "Show" item and
/// the global Cmd+Shift+M hotkey.
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.unminimize();
    }
}

fn kill_sidecar(app: &AppHandle) {
    if let Some(child) = app.state::<SidecarState>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![capture_screen, pick_folder, reveal_in_finder])
        .manage(SidecarState(Mutex::new(None)))
        .manage(QuitRequested(std::sync::atomic::AtomicBool::new(false)))
        .setup(|app| {
            let port = pick_free_port();
            let auth_token = generate_auth_token();

            create_main_window(app.handle(), &auth_token)?;
            start_sidecar_and_navigate(app.handle(), port, auth_token);

            // --- System tray: Show / Hide / Quit -------------------------
            let show_item = MenuItem::with_id(app, "show", "Show Medusa", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "Hide Medusa", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .tooltip("Medusa")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "quit" => {
                        app.state::<QuitRequested>()
                            .0
                            .store(true, std::sync::atomic::Ordering::SeqCst);
                        kill_sidecar(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // --- Global hotkey: Cmd+Shift+M shows/focuses the window -----
            let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyM);
            let app_handle_for_shortcut = app.handle().clone();
            app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    show_main_window(&app_handle_for_shortcut);
                }
            })?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let quitting = app
                    .state::<QuitRequested>()
                    .0
                    .load(std::sync::atomic::Ordering::SeqCst);
                if quitting {
                    // Real quit (from the tray Quit item, or RunEvent::Exit
                    // below): let the close proceed and kill the sidecar.
                    kill_sidecar(app);
                } else {
                    // Closing the window hides to tray instead of quitting --
                    // quitting here would also kill the sidecar for no
                    // reason, since the app (and server) are meant to keep
                    // running in the background until Quit is chosen.
                    api.prevent_close();
                    let _ = window.hide();
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// Drives `poll_for_health` with a fake clock that advances 300ms per
    /// poll, matching the real sleep interval.
    struct Harness {
        polls: Cell<u32>,
        healthy_after: u32,
        dead_after: Option<u32>,
    }

    impl Harness {
        fn run(&self) -> (bool, Vec<String>) {
            let reports = std::cell::RefCell::new(Vec::new());
            let ok = poll_for_health(
                4321,
                &|| {
                    let n = self.polls.get() + 1;
                    self.polls.set(n);
                    n >= self.healthy_after
                },
                &|| self.dead_after.is_some_and(|d| self.polls.get() >= d),
                &|| Duration::from_millis(300 * u64::from(self.polls.get())),
                &mut |status, _detail| reports.borrow_mut().push(status.to_string()),
                &|_| {},
            );
            (ok, reports.into_inner())
        }
    }

    /// The regression this file's fix exists for: a server that takes longer
    /// than the old fixed 30s budget must still be waited for. Before the
    /// fix, `wait_for_health` returned false here and the caller silently
    /// returned, leaving the window on an unpainted about:blank forever --
    /// the "solid black window, no UI, indefinitely" bug.
    #[test]
    fn waits_past_the_old_thirty_second_budget() {
        // 30s at one poll per 300ms is 100 polls; become healthy at 400
        // (two minutes), far beyond any fixed deadline.
        let h = Harness { polls: Cell::new(0), healthy_after: 400, dead_after: None };
        let (ok, _) = h.run();
        assert!(ok, "a slow-starting server must still be waited for");
        assert_eq!(h.polls.get(), 400);
    }

    /// A server that comes up promptly must not be delayed, and must not
    /// show the "taking longer than usual" notice.
    #[test]
    fn returns_immediately_when_already_healthy() {
        let h = Harness { polls: Cell::new(0), healthy_after: 1, dead_after: None };
        let (ok, reports) = h.run();
        assert!(ok);
        assert_eq!(h.polls.get(), 1);
        assert!(reports.is_empty(), "no slow-start notice for a fast start");
    }

    /// Waiting forever is only correct while there is still a process to
    /// wait for. A sidecar that exits must end the wait so the caller can
    /// tell the user, rather than spinning behind the splash.
    #[test]
    fn gives_up_when_the_sidecar_dies() {
        let h = Harness { polls: Cell::new(0), healthy_after: u32::MAX, dead_after: Some(5) };
        let (ok, _) = h.run();
        assert!(!ok, "a dead sidecar must end the wait");
    }

    /// Past the notice threshold the user must be told what is happening;
    /// the black window was as much a reporting failure as a timeout one.
    #[test]
    fn reports_slow_startup_to_the_splash() {
        // SLOW_STARTUP_NOTICE is 20s == 67 polls at 300ms.
        let h = Harness { polls: Cell::new(0), healthy_after: 120, dead_after: None };
        let (ok, reports) = h.run();
        assert!(ok);
        assert!(
            reports.iter().any(|r| r.contains("Still starting")),
            "expected a slow-startup status, got {reports:?}"
        );
    }
}
