#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod backend;
use backend::Backend;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Desktop {
    backend: Arc<Backend>,
    closing: AtomicBool,
}
fn local_navigation(url: &url::Url) -> bool {
    matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("tauri", Some("localhost"), None) | ("http" | "https", Some("tauri.localhost"), None)
    ) || cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420)
}
fn restore(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.destroy();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
fn compact(app: &AppHandle) -> Result<(), String> {
    if let Some(overlay) = app.get_webview_window("overlay") {
        return overlay.show().map_err(|e| e.to_string());
    }
    let main = app
        .get_webview_window("main")
        .ok_or("Main window missing")?;
    let monitor = main
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("Monitor unavailable")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width = 340.0_f64.min(area.size.width as f64 / scale);
    WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .on_navigation(local_navigation)
        .title("Live transcript")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(width, area.size.height as f64 / scale)
        .position(
            (area.position.x as f64 + area.size.width as f64) / scale - width,
            area.position.y as f64 / scale,
        )
        .build()
        .map_err(|e| e.to_string())?;
    main.minimize().map_err(|e| e.to_string())
}
#[tauri::command]
async fn meeting_call(
    app: AppHandle,
    window: WebviewWindow,
    desktop: State<'_, Desktop>,
    method: String,
    mut args: Vec<Value>,
) -> Result<Value, String> {
    if window.label() != "main"
        && !(window.label() == "overlay"
            && ["meeting-state-get", "meeting-compact-control"].contains(&method.as_str()))
    {
        return Err("Request denied.".into());
    }
    if desktop.closing.load(Ordering::Relaxed) {
        return Err("The app is closing.".into());
    }
    match method.as_str() {
        "meeting-compact" => {
            let state = desktop.backend.call("meeting-state-get", vec![]).await?;
            if state["active"] == true {
                compact(&app)?;
            }
            return Ok(Value::Null);
        }
        "meeting-compact-control" => {
            match args.first().and_then(Value::as_str) {
                Some("restore") => restore(&app),
                Some("stop") => {
                    app.emit_to("main", "meeting-stop-request", ())
                        .map_err(|e| e.to_string())?;
                }
                _ => return Err("Invalid window command.".into()),
            };
            return Ok(Value::Null);
        }
        "meeting-source" => {
            let url = url::Url::parse(
                args.first()
                    .and_then(Value::as_str)
                    .ok_or("Invalid source URL")?,
            )
            .map_err(|e| e.to_string())?;
            if !["https", "http"].contains(&url.scheme())
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("Invalid source URL".into());
            }
            app.opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(|e| e.to_string())?;
            return Ok(Value::Null);
        }
        "meeting-pick-transcript-folder" | "meeting-import-transcript" | "meeting-export" => {
            let choice = method.clone();
            let handle = app.clone();
            let format = args
                .first()
                .and_then(Value::as_str)
                .unwrap_or("txt")
                .to_owned();
            if choice == "meeting-export" && !["txt", "md"].contains(&format.as_str()) {
                return Err("Invalid export format".into());
            }
            let export_format = format.clone();
            let selected = tauri::async_runtime::spawn_blocking(move || {
                let dialog = handle.dialog().file();
                match choice.as_str() {
                    "meeting-pick-transcript-folder" => dialog.blocking_pick_folder(),
                    "meeting-import-transcript" => dialog
                        .add_filter("Text transcript", &["txt"])
                        .blocking_pick_file(),
                    "meeting-export" => dialog
                        .set_file_name(format!("Meeting.{}", format))
                        .add_filter("Meeting document", &[&format])
                        .blocking_save_file(),
                    _ => dialog.blocking_pick_file(),
                }
            })
            .await
            .map_err(|e| e.to_string())?;
            let Some(selected) = selected else {
                return Ok(Value::Null);
            };
            let path = selected
                .into_path()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into_owned();
            if method == "meeting-pick-transcript-folder" {
                return Ok(json!(path));
            }
            if method == "meeting-export" {
                args = vec![json!(export_format), json!(path)];
            } else {
                args = vec![json!(path)];
            }
        }
        "meeting-shutdown" => return Err("Request denied.".into()),
        _ => {}
    }
    desktop.backend.call(&method, args).await
}
fn shutdown(app: AppHandle) {
    let desktop = app.state::<Desktop>();
    if desktop.closing.swap(true, Ordering::SeqCst) {
        return;
    }
    let backend = desktop.backend.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            backend.call("meeting-shutdown", vec![]),
        )
        .await;
        backend.kill();
        app.exit(0);
    });
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| restore(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let backend = Backend::start(app.handle())?;
            app.manage(Desktop {
                backend,
                closing: AtomicBool::new(false),
            });
            WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(local_navigation)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![meeting_call])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" {
                    shutdown(window.app_handle().clone());
                } else {
                    let _ = window
                        .app_handle()
                        .emit_to("main", "meeting-stop-request", ());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not start Live Meeting Notes")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<Desktop>().closing.load(Ordering::Relaxed) {
                    api.prevent_exit();
                    shutdown(app.clone());
                }
            }
        });
}
#[cfg(test)]
mod tests {
    #[test]
    fn external_pages_cannot_replace_the_app() {
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/overlay.html",
        ] {
            assert!(super::local_navigation(&url::Url::parse(url).unwrap()));
        }
        for url in [
            "https://example.org",
            "file:///tmp/index.html",
            "http://127.0.0.1:9999",
        ] {
            assert!(!super::local_navigation(&url::Url::parse(url).unwrap()));
        }
    }
}
