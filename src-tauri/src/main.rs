use serde::Serialize;
use std::sync::Mutex;
use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct ServerProcess(Mutex<Option<CommandChild>>);

#[derive(Debug, Serialize)]
struct MonitorInfo {
    name: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[tauri::command]
fn get_monitors(app: tauri::AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("Failed to get monitors: {}", e))?;

    Ok(monitors
        .iter()
        .map(|m| MonitorInfo {
            name: m.name().cloned(),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect())
}

#[tauri::command]
fn get_work_area(app: tauri::AppHandle) -> Result<WorkArea, String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("Failed to get primary monitor: {}", e))?;

    if let Some(m) = monitor {
        Ok(WorkArea {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height.saturating_sub(48),
        })
    } else {
        Ok(WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1032,
        })
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let shell = app.shell();
            let dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| ".".into());
            let mut root = dir.clone();
            for _ in 0..5 {
                if root.join("src/server.ts").exists() {
                    break;
                }
                if let Some(p) = root.parent() {
                    root = p.into();
                }
            }

            let cmd = if cfg!(target_os = "windows") {
                shell
                    .command("cmd")
                    .args(["/c", "npx", "tsx", "src/server.ts"])
                    .current_dir(&root)
            } else {
                shell
                    .command("npx")
                    .args(["tsx", "src/server.ts"])
                    .current_dir(&root)
            };

            let (rx, child) = cmd.spawn().expect("Failed to start server");
            app.manage(ServerProcess(Mutex::new(Some(child))));

            tauri::async_runtime::spawn(async move {
                let mut rx = rx;
                while let Some(e) = rx.recv().await {
                    match e {
                        CommandEvent::Stdout(l) => {
                            if let Ok(s) = String::from_utf8(l) {
                                eprintln!("[rag] {}", s.trim());
                            }
                        }
                        CommandEvent::Stderr(l) => {
                            if let Ok(s) = String::from_utf8(l) {
                                eprintln!("[rag] {}", s.trim());
                            }
                        }
                        CommandEvent::Terminated(_) => break,
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { .. } = e {
                let s = w.state::<ServerProcess>();
                let mut g = s.0.lock().unwrap();
                if let Some(c) = g.take() {
                    let _ = c.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_monitors,
            get_work_area,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
