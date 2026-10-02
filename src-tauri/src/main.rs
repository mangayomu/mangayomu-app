// MangaYomu desktop shell.
//
// The app ships two pieces: the compiled client and a Node.js runtime that
// runs the bundled MangaYomu server. On startup the server is spawned as a
// sidecar, the shell waits for /api/health and only then shows the window
// pointing at http://127.0.0.1:<port>. Serving the client from that same
// origin is what puts the app in "hosted" mode (see /mangayomu-runtime.json),
// exactly like the Android with-server flavour. If the server cannot start,
// the window falls back to the bundled static client.

// Keep release builds free of an extra console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const WINDOW_LABEL: &str = "main";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(150);
const SIDECAR: &str = "mangayomu-server";

/// Forwarded to the app's stderr. A packaged desktop app has no logcat, so
/// uncaught webview errors would otherwise be invisible.
#[tauri::command]
fn log_webview_error(message: String) {
    eprintln!("[webview] {message}");
}

/// Installed before any page script runs: reports boot failures that would
/// otherwise leave a blank window.
const ERROR_REPORT_SCRIPT: &str = r#"
(function () {
  function report(kind, text) {
    try {
      var internals = window.__TAURI_INTERNALS__;
      if (internals && internals.invoke) {
        internals.invoke("log_webview_error", { message: kind + ": " + text });
      }
    } catch (error) {}
  }
  window.addEventListener("error", function (event) {
    var where = event.filename ? " (" + event.filename + ":" + event.lineno + ":" + event.colno + ")" : "";
    report("error", (event.message || "unknown") + where);
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    report("unhandled rejection", (reason && (reason.stack || reason.message)) || String(reason));
  });
  var passthrough = console.error;
  console.error = function () {
    var parts = Array.prototype.map.call(arguments, function (argument) {
      if (argument instanceof Error) return argument.stack || argument.message;
      if (typeof argument === "string") return argument;
      try { return JSON.stringify(argument); } catch (error) { return String(argument); }
    });
    report("console.error", parts.join(" "));
    return passthrough.apply(console, arguments);
  };
})();
"#;

/// Owns the embedded server process and the origin it serves.
#[derive(Default)]
struct ServerState {
    child: Mutex<Option<CommandChild>>,
    origin: Mutex<Option<String>>,
}

impl ServerState {
    fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }

    fn set_origin(&self, origin: String) {
        *self.origin.lock().unwrap() = Some(origin);
    }

    fn origin(&self) -> Option<String> {
        self.origin.lock().unwrap().clone()
    }
}

/// Ask the OS for a free loopback port so a busy 4567 never blocks startup.
fn reserve_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(4567)
}

/// Minimal HTTP probe: the shell must not depend on a full HTTP client just to
/// learn that the embedded server is up.
fn health_ok(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));
    if stream
        .write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.") && response.contains(" 200 ")
}

/// The staged server lives in the bundle resources; during `tauri dev` the
/// resources are not copied, so the manifest directory is checked as well.
fn server_entry(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("resources/server/src/index.js"));
        candidates.push(resource_dir.join("server/src/index.js"));
    }
    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        candidates.push(Path::new(manifest_dir).join("resources/server/src/index.js"));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn open_window(app: &tauri::AppHandle, url: WebviewUrl, title: &str) {
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.set_focus();
        return;
    }
    if let Err(error) = WebviewWindowBuilder::new(app, WINDOW_LABEL, url)
        .title(title)
        .inner_size(1280.0, 820.0)
        .min_inner_size(420.0, 420.0)
        .initialization_script(ERROR_REPORT_SCRIPT)
        .build()
    {
        eprintln!("[shell] could not open the window: {error}");
    }
}

fn start_server(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<ServerState>();
        let data_dir = handle
            .path()
            .app_local_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = std::fs::create_dir_all(&data_dir);

        let Some(entry) = server_entry(&handle) else {
            eprintln!("[shell] bundled server not found; starting without it");
            open_client_window(&handle);
            return;
        };

        let port = reserve_port();
        let origin = format!("http://127.0.0.1:{port}");
        let command = match handle.shell().sidecar(SIDECAR) {
            Ok(command) => command
                .args([entry.to_string_lossy().to_string()])
                .env("PORT", port.to_string())
                .env("DB_PATH", data_dir.join("mangayomu.db").to_string_lossy().to_string())
                .env("MANGAYOMU_EXTENSIONS_HOME", data_dir.join("extensions").to_string_lossy().to_string())
                // Serve the bundled client from the same origin as the API.
                .env("MANGAYOMU_SERVE_STATIC", "1"),
            Err(error) => {
                eprintln!("[shell] sidecar unavailable: {error}");
                open_client_window(&handle);
                return;
            }
        };

        let (mut events, child) = match command.spawn() {
            Ok(spawned) => spawned,
            Err(error) => {
                eprintln!("[shell] could not start the embedded server: {error}");
                open_client_window(&handle);
                return;
            }
        };
        state.child.lock().unwrap().replace(child);

        // The server exits on its own when the port is taken or a migration
        // fails; wake the waiter immediately instead of waiting the timeout.
        let exited = Arc::new(AtomicBool::new(false));
        let exit_flag = exited.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                        print!("[server] {}", String::from_utf8_lossy(&line));
                    }
                    CommandEvent::Error(message) => eprintln!("[server] error: {message}"),
                    CommandEvent::Terminated(payload) => {
                        eprintln!("[shell] embedded server stopped (code {:?})", payload.code);
                        exit_flag.store(true, Ordering::SeqCst);
                    }
                    _ => {}
                }
            }
        });

        let deadline = Instant::now() + READY_TIMEOUT;
        let mut ready = false;
        while Instant::now() < deadline {
            if exited.load(Ordering::SeqCst) {
                break;
            }
            if health_ok(port) {
                ready = true;
                break;
            }
            std::thread::sleep(POLL_INTERVAL);
        }

        if !ready {
            eprintln!("[shell] embedded server did not become ready; using the bundled client");
            state.kill();
            open_client_window(&handle);
            return;
        }

        state.set_origin(origin.clone());
        let url = origin.parse().expect("loopback origin is a valid URL");
        let main_thread = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            open_window(&main_thread, WebviewUrl::External(url), "MangaYomu");
        });
    });
}

/// Used when the embedded server is unavailable: the client starts in direct
/// mode and can still connect to a server configured by the user.
fn open_client_window(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        open_window(&handle, WebviewUrl::App("index.html".into()), "MangaYomu");
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![log_webview_error])
        .manage(ServerState::default())
        .setup(|app| {
            start_server(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build MangaYomu")
        .run(|app, event| match event {
            RunEvent::Exit | RunEvent::ExitRequested { .. } => {
                app.state::<ServerState>().kill();
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows, .. } => {
                let state = app.state::<ServerState>();
                if has_visible_windows {
                    return;
                }
                match state.origin().and_then(|origin| origin.parse().ok()) {
                    Some(url) => open_window(app, WebviewUrl::External(url), "MangaYomu"),
                    None => open_client_window(app),
                }
            }
            _ => {}
        });
}
