pub mod adapters;
pub mod monitoring;

use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Manager, State, WindowEvent, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri::menu::{Menu, MenuItem};

use adapters::filesystem::{FileInfo, FilesystemAdapter, SearchResult};
use adapters::input_control::{self, InputActionResult};
use adapters::system::{DiskUsage, GpuStats, NetworkStats, ProcessInfo, SystemAdapter, SystemStats, TemperatureStats};
use adapters::window_control::{self, WindowInfo};
use monitoring::file_watcher::FileWatcherService;
use monitoring::store::MonitorStore;

/// Owned local service; terminate it when the desktop application exits.
pub struct ServerProcess(Mutex<Option<CommandChild>>);

fn stop_server(app: &tauri::AppHandle) {
    if let Some(process) = app.try_state::<ServerProcess>() {
        if let Ok(mut child) = process.0.lock() {
            if let Some(child) = child.take() {
                if let Err(error) = child.kill() {
                    eprintln!("[rag] Failed to stop local service: {}", error);
                }
            }
        }
    }
}

#[derive(Clone, Serialize)]
pub struct RuntimeConfig {
    api_base_url: String,
    local_token: String,
}

#[derive(Debug, Serialize)]
pub struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

pub struct AppState {
    pub system_adapter: SystemAdapter,
    pub filesystem_adapter: FilesystemAdapter,
    pub data_dir: std::path::PathBuf,
}

/// 系统托盘状态：是否已最小化到托盘
#[derive(Clone, Serialize)]
pub struct TrayState {
    pub minimized_to_tray: bool,
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
    stop_server(&app);
    app.exit(0);
}

/// 显示宠物窗口（从托盘恢复）
#[tauri::command]
fn show_pet_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("pet") {
        // 重新置顶，避免被其他窗口遮挡
        let _ = win.set_always_on_top(true);
        win.show().map_err(|e| format!("show failed: {}", e))?;
        win.set_focus().map_err(|e| format!("focus failed: {}", e))?;
        // 向前端发送事件，让前端展开聊天面板
        let _ = win.emit("tray-restored", ());
    }
    Ok(())
}

/// 隐藏宠物窗口到托盘
#[tauri::command]
fn hide_pet_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("pet") {
        win.hide().map_err(|e| format!("hide failed: {}", e))?;
    }
    Ok(())
}

/// 切换宠物窗口显示/隐藏（全局快捷键调用）
#[tauri::command]
fn toggle_pet_window(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window("pet") {
        if win.is_visible().unwrap_or(false) {
            win.hide().map_err(|e| format!("hide failed: {}", e))?;
            Ok(false)
        } else {
            // 显示前先重新置顶，避免被其他窗口遮挡
            let _ = win.set_always_on_top(true);
            win.show().map_err(|e| format!("show failed: {}", e))?;
            win.set_focus().map_err(|e| format!("focus failed: {}", e))?;
            let _ = win.emit("tray-restored", ());
            Ok(true)
        }
    } else {
        Err("pet window not found".to_string())
    }
}

/// 显示系统通知（让小伴的主动提醒走 OS 通知中心）
#[tauri::command]
async fn show_system_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("notification failed: {}", e))?;
    Ok(())
}

#[tauri::command]
fn get_runtime_config(state: State<'_, RuntimeConfig>) -> RuntimeConfig {
    state.inner().clone()
}

#[tauri::command]
fn move_pet_window(app: tauri::AppHandle, x: i32, y: i32) {
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
            x, y,
        )));
    }
}

#[tauri::command]
fn resize_pet_window(app: tauri::AppHandle, width: u32, height: u32) {
    if let Some(win) = app.get_webview_window("pet") {
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            width as f64,
            height as f64,
        )));
    }
}

#[tauri::command]
async fn get_disk_usage(volume: String, state: State<'_, AppState>) -> Result<DiskUsage, String> {
    state.system_adapter.get_disk_usage(&volume)
}

#[tauri::command]
async fn get_system_stats(state: State<'_, AppState>) -> Result<SystemStats, String> {
    state.system_adapter.get_system_stats()
}

#[tauri::command]
async fn list_processes(
    sort_by: String,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<Vec<ProcessInfo>, String> {
    state.system_adapter.list_processes(&sort_by, limit)
}

#[tauri::command]
async fn search_files(
    scope: Vec<String>,
    query: Option<String>,
    modified_after: Option<String>,
    modified_before: Option<String>,
    file_types: Vec<String>,
    state: State<'_, AppState>,
) -> Result<SearchResult, String> {
    state.filesystem_adapter.search(
        scope,
        query,
        modified_after,
        modified_before,
        file_types,
        200,
    )
}

#[tauri::command]
async fn list_recent_files(
    scope: Vec<String>,
    hours: u32,
    state: State<'_, AppState>,
) -> Result<Vec<FileInfo>, String> {
    state.filesystem_adapter.list_recent_files(scope, hours)
}

#[tauri::command]
async fn list_directory(path: String, state: State<'_, AppState>) -> Result<Vec<FileInfo>, String> {
    state.filesystem_adapter.list_directory(path)
}

#[tauri::command]
async fn get_metrics_history(
    hours: u32,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let store = MonitorStore::new(&state.data_dir)?;
    store.get_metrics_history(hours)
}

#[tauri::command]
async fn get_recent_alerts(
    limit: u32,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let store = MonitorStore::new(&state.data_dir)?;
    store.get_recent_alerts(limit)
}

/// Scan the user's Desktop directory and return all files (non-recursive).
/// Returns name, path, extension, size, and modified time. Files only —
/// directories are skipped. Handles Windows ACL denials by skipping entries
/// we cannot stat rather than failing the whole scan.
#[derive(Debug, Serialize)]
struct DesktopFileEntry {
    name: String,
    path: String,
    extension: String,
    size_bytes: u64,
    modified_at: Option<String>,
}

#[tauri::command]
async fn scan_desktop_files() -> Result<Vec<DesktopFileEntry>, String> {
    let desktop = dirs::desktop_dir()
        .ok_or_else(|| "Could not resolve desktop directory".to_string())?;

    let mut entries: Vec<DesktopFileEntry> = Vec::new();
    let read = match std::fs::read_dir(&desktop) {
        Ok(r) => r,
        Err(e) => return Err(format!("Failed to read desktop directory: {}", e)),
    };

    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() { continue; }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // ACL-denied entry — skip silently
        };
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| {
                chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            });
        entries.push(DesktopFileEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            extension,
            size_bytes: meta.len(),
            modified_at,
        });
    }

    // Sort by modified time descending (newest first); None sorts last
    entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(entries)
}

/// Capture the primary screen and return as base64-encoded PNG.
/// Uses xcap which works on Windows (DXGI), macOS (ScreenCaptureKit),
/// and Linux (X11). The base64 string can be sent to Ollama llava as a
/// standard data URL (data:image/png;base64,...).
#[tauri::command]
async fn capture_screen() -> Result<String, String> {
    use xcap::Monitor;
    use base64::Engine;

    let monitors = Monitor::all().map_err(|e| format!("Failed to list monitors: {}", e))?;
    let primary = monitors
        .into_iter()
        .next()
        .ok_or_else(|| "No monitor available".to_string())?;

    let image = primary
        .capture_image()
        .map_err(|e| format!("Screen capture failed: {}", e))?;

    let mut png_buf = std::io::Cursor::new(Vec::with_capacity(image.len() * 2));
    image
        .write_to(&mut png_buf, image::ImageFormat::Png)
        .map_err(|e| format!("PNG encode failed: {}", e))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_buf.into_inner());
    Ok(b64)
}

// ===== 贾维斯系统操控能力 =====

/// 列出所有可见且有标题的顶层窗口
#[tauri::command]
async fn list_windows() -> Result<Vec<WindowInfo>, String> {
    window_control::list_windows()
}

/// 控制指定窗口（最小化/最大化/恢复/关闭/置顶/激活）
#[tauri::command]
async fn control_window(title: String, hwnd: Option<usize>, action: String) -> Result<String, String> {
    window_control::control_window(&title, hwnd, &action)
}

/// 移动并调整窗口位置与尺寸
#[tauri::command]
async fn move_window(title: String, hwnd: Option<usize>, x: i32, y: i32, width: Option<i32>, height: Option<i32>) -> Result<String, String> {
    window_control::move_window(&title, hwnd, x, y, width, height)
}

/// 查询窗口几何信息（位置+尺寸）
#[tauri::command]
async fn get_window_rect(title: String, hwnd: Option<usize>) -> Result<window_control::WindowRect, String> {
    window_control::get_window_rect(&title, hwnd)
}

/// 模拟鼠标点击
#[tauri::command]
async fn mouse_click(x: i32, y: i32, button: String) -> Result<InputActionResult, String> {
    input_control::mouse_click(x, y, &button)
}

/// 模拟鼠标双击
#[tauri::command]
async fn mouse_double_click(x: i32, y: i32, button: String) -> Result<InputActionResult, String> {
    input_control::mouse_double_click(x, y, &button)
}

/// 模拟鼠标拖拽（从起点按住拖到终点释放）
#[tauri::command]
async fn mouse_drag(
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    button: String,
    steps: Option<u32>,
) -> Result<InputActionResult, String> {
    input_control::mouse_drag(from_x, from_y, to_x, to_y, &button, steps.unwrap_or(20))
}

/// 模拟鼠标滚轮滚动
#[tauri::command]
async fn mouse_scroll(axis: String, amount: i32) -> Result<InputActionResult, String> {
    input_control::mouse_scroll(&axis, amount)
}

/// 输入文本
#[tauri::command]
async fn type_text(text: String) -> Result<InputActionResult, String> {
    input_control::type_text(&text)
}

/// 按下按键或组合键（如 "ctrl+c"、"alt+f4"、"win+e"）
#[tauri::command]
async fn press_keys(key: String) -> Result<InputActionResult, String> {
    input_control::press_keys(&key)
}

/// 打开文件/文件夹/URL（通过系统默认处理器）
#[tauri::command]
async fn open_path(path: String) -> Result<InputActionResult, String> {
    input_control::open_path(&path)
}

/// 启动一个程序
#[tauri::command]
async fn launch_program(program: String, args: Vec<String>) -> Result<InputActionResult, String> {
    input_control::launch_program(&program, &args)
}

/// 获取网络接口实时速率
#[tauri::command]
async fn get_network_stats(state: State<'_, AppState>) -> Result<NetworkStats, String> {
    state.system_adapter.get_network_stats()
}

/// 获取温度传感器读数
#[tauri::command]
async fn get_temperature_stats(state: State<'_, AppState>) -> Result<TemperatureStats, String> {
    state.system_adapter.get_temperature_stats()
}

/// 获取 GPU 状态（仅 NVIDIA 显卡；非 NVIDIA 显卡返回错误供前端容错）
#[tauri::command]
async fn get_gpu_stats(state: State<'_, AppState>) -> Result<GpuStats, String> {
    state.system_adapter.get_gpu_stats()
}

/// 列出所有已挂载盘符的使用情况（多盘符监控）
#[tauri::command]
async fn list_all_disks(state: State<'_, AppState>) -> Result<Vec<DiskUsage>, String> {
    state.system_adapter.list_all_disks()
}

/// 暂停/恢复硬件监控轮询（性能优化：窗口收缩态暂停采集降低 CPU 占用）
#[tauri::command]
async fn set_monitoring_paused(
    monitor: State<'_, monitoring::service::MonitoringService>,
    paused: bool,
) -> Result<(), String> {
    monitor.set_paused(paused);
    Ok(())
}

/// 读取系统剪贴板文本
#[tauri::command]
async fn read_clipboard() -> Result<String, String> {
    adapters::clipboard::read_clipboard()
}

/// 写入文本到系统剪贴板
#[tauri::command]
async fn write_clipboard(text: String) -> Result<String, String> {
    adapters::clipboard::write_clipboard(&text)
}

/// 调节系统音量（action: up/down/mute/set，level: 0-100 仅 set 使用）
#[tauri::command]
async fn set_system_volume(action: String, level: Option<u32>) -> Result<String, String> {
    adapters::multimedia::set_system_volume(&action, level)
}

/// 设置桌面壁纸
#[tauri::command]
async fn set_wallpaper(path: String) -> Result<String, String> {
    adapters::multimedia::set_wallpaper(&path)
}

pub fn run() {
    // Install a panic hook so panics are written to stderr (captured by our log redirect)
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        eprintln!("[rag PANIC] {}", info);
        eprintln!("[rag PANIC] backtrace: {}", std::backtrace::Backtrace::force_capture());
        default_hook(info);
    }));

    eprintln!("[rag] Building Tauri app...");
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            eprintln!("[rag] Setup started");
            let mut token_bytes = [0u8; 32];
            OsRng.fill_bytes(&mut token_bytes);
            let local_token = token_bytes
                .iter()
                .map(|byte| format!("{:02x}", byte))
                .collect::<String>();
            app.manage(RuntimeConfig {
                api_base_url: "http://127.0.0.1:3000".to_string(),
                local_token: local_token.clone(),
            });
            app.manage(TrayState { minimized_to_tray: false });

            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| ".".into());
            eprintln!("[rag] data_dir = {:?}", data_dir);
            std::fs::create_dir_all(&data_dir).ok();

            // === 显式启用 always-on-top（tauri.conf.json 的 alwaysOnTop 在 Win11 上偶发失效）===
            if let Some(win) = app.get_webview_window("pet") {
                let _ = win.set_always_on_top(true);
                let _ = win.show();
                let _ = win.set_focus();
                eprintln!("[rag] Pet window always_on_top enabled");
            }

            // === 全局快捷键 ===
            // Ctrl+Alt+X: 显示/隐藏小伴窗口
            // Ctrl+Alt+M: 启动/停止录音（语音入口）
            // Ctrl+Alt+, : 显示设置面板
            let app_handle_for_shortcut = app.handle().clone();
            let shortcut_result = app.global_shortcut().on_shortcut("ctrl+alt+x", move |_app, _shortcut, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    let _ = toggle_pet_window(app_handle_for_shortcut.clone());
                }
            });
            if let Err(e) = shortcut_result {
                eprintln!("[rag] Warning: failed to register ctrl+alt+x: {}", e);
            }

            let app_handle_for_mic = app.handle().clone();
            let mic_result = app.global_shortcut().on_shortcut("ctrl+alt+m", move |_app, _shortcut, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    // 通知前端切换录音状态
                    if let Some(win) = app_handle_for_mic.get_webview_window("pet") {
                        // 确保窗口可见
                        let _ = win.show();
                        let _ = win.set_focus();
                        let _ = win.emit("global-mic-toggle", ());
                    }
                }
            });
            if let Err(e) = mic_result {
                eprintln!("[rag] Warning: failed to register ctrl+alt+m: {}", e);
            }

            let app_handle_for_settings = app.handle().clone();
            let settings_result = app.global_shortcut().on_shortcut("ctrl+alt+,", move |_app, _shortcut, event| {
                if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    if let Some(win) = app_handle_for_settings.get_webview_window("pet") {
                        let _ = win.show();
                        let _ = win.set_focus();
                        let _ = win.emit("global-open-settings", ());
                    }
                }
            });
            if let Err(e) = settings_result {
                eprintln!("[rag] Warning: failed to register ctrl+alt+,: {}", e);
            }
            eprintln!("[rag] Global shortcuts registered (Ctrl+Alt+X / Ctrl+Alt+M / Ctrl+Alt+,)");

            // === 系统托盘 ===
            let show_item = MenuItem::with_id(app, "tray_show", "显示小伴", true, None::<&str>)
                .expect("failed to create tray_show item");
            let hide_item = MenuItem::with_id(app, "tray_hide", "隐藏小伴", true, None::<&str>)
                .expect("failed to create tray_hide item");
            let quit_item = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)
                .expect("failed to create tray_quit item");
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &quit_item])
                .expect("failed to create tray menu");
            let _tray = tauri::tray::TrayIconBuilder::with_id("main-tray")
                .tooltip("小伴 - AI 桌面助手")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "tray_show" => { let _ = show_pet_window(app.clone()); }
                        "tray_hide" => { let _ = hide_pet_window(app.clone()); }
                        "tray_quit" => { stop_server(app); app.exit(0); }
                        _ => {}
                    }
                })
                .build(app)
                .expect("failed to build tray");
            eprintln!("[rag] System tray initialized");

            // Initialize monitoring - never fail setup if this fails
            // 性能优化：monitor_service 注册到 app.manage，供 set_monitoring_paused 命令访问
            let monitor_store = MonitorStore::new(&data_dir)
                .or_else(|_| MonitorStore::new_in_memory())
                .or_else(|_| MonitorStore::new_in_memory());
            let monitor_service = match monitor_store {
                Ok(store) => {
                    let svc = monitoring::service::MonitoringService::new(store);
                    svc.start(app.handle().clone());
                    eprintln!("[rag] Monitoring started");
                    svc
                }
                Err(_) => {
                    // 兜底：in-memory store 几乎不会失败，此处仅防御性处理
                    eprintln!("[rag] Warning: MonitorStore init failed completely, monitoring disabled");
                    let store = MonitorStore::new_in_memory()
                        .expect("in-memory store must not fail");
                    monitoring::service::MonitoringService::new(store)
                }
            };
            app.manage(monitor_service);

            // 启动桌面文件监听服务 — 文件新增/修改时通过 Tauri 事件推送提醒
            let file_watcher = FileWatcherService::new();
            file_watcher.start(app.handle().clone());
            app.manage(file_watcher);
            eprintln!("[rag] File watcher started");

            app.manage(AppState {
                system_adapter: SystemAdapter::new(),
                filesystem_adapter: FilesystemAdapter::new(),
                data_dir,
            });
            let shell = app.shell();
            let dir = app.path().resource_dir().unwrap_or_else(|_| ".".into());
            let packaged_root = dir.join("runtime");
            let packaged = packaged_root.join("node.exe").is_file()
                && packaged_root.join("dist/server.js").is_file();
            let mut root = if packaged { packaged_root } else { dir.clone() };
            if !packaged && cfg!(debug_assertions) {
                for _ in 0..5 {
                    if root.join("src/server.ts").exists() {
                        break;
                    }
                    if let Some(p) = root.parent() {
                        root = p.into();
                    }
                }
                if !root.join("src/server.ts").exists() {
                    root = std::env::current_dir().unwrap_or_else(|_| ".".into());
                }
            }

            // Strip the \\?\ extended-length prefix — cmd.exe / npx can't handle it
            let root_str = root.to_string_lossy().into_owned();
            let root_str = if root_str.starts_with(r"\\?\") {
                root_str[4..].to_string()
            } else {
                root_str
            };
            let root = std::path::PathBuf::from(&root_str);
            eprintln!("[rag] server root = {:?}", root);

            let cmd = if packaged || !cfg!(debug_assertions) {
                shell
                    .command(root.join("node.exe"))
                    .arg("dist/server.js")
                    .current_dir(&root)
                    .env("RAG_PET_LOCAL_TOKEN", &local_token)
                    .env("RAG_PET_REQUIRE_LOCAL_TOKEN", "true")
            } else if cfg!(target_os = "windows") {
                shell
                    .command("cmd")
                    .args(["/c", "npx", "tsx", "src/server.ts"])
                    .current_dir(&root)
                    .env("RAG_PET_LOCAL_TOKEN", &local_token)
                    .env("RAG_PET_REQUIRE_LOCAL_TOKEN", "true")
            } else {
                shell
                    .command("npx")
                    .args(["tsx", "src/server.ts"])
                    .current_dir(&root)
                    .env("RAG_PET_LOCAL_TOKEN", &local_token)
                    .env("RAG_PET_REQUIRE_LOCAL_TOKEN", "true")
            };

            eprintln!("[rag] Spawning server command...");
            match cmd.spawn() {
                Ok((rx, child)) => {
                    eprintln!("[rag] Server spawned successfully");
                    app.manage(ServerProcess(Mutex::new(Some(child))));
                    tauri::async_runtime::spawn(async move {
                        let mut rx = rx;
                        while let Some(e) = rx.recv().await {
                            match e {
                                CommandEvent::Stdout(l) => {
                                    if let Ok(s) = String::from_utf8(l) {
                                        eprintln!("[server:out] {}", s.trim());
                                    }
                                }
                                CommandEvent::Stderr(l) => {
                                    if let Ok(s) = String::from_utf8(l) {
                                        eprintln!("[server:err] {}", s.trim());
                                    }
                                }
                                CommandEvent::Terminated(status) => {
                                    eprintln!("[server] process terminated: {:?}", status);
                                    break;
                                }
                                _ => {}
                            }
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[rag] Failed to start server: {}", e);
                    // Continue without server - UI will show connection error
                }
            }

            eprintln!("[rag] Setup complete, returning Ok(())");
            Ok(())
        })
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                // 阻止真正关闭 — 改为隐藏到托盘
                api.prevent_close();
                let _ = w.hide();
                // 通过事件通知前端更新 UI 状态
                let _ = w.emit("tray-hidden", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_work_area,
            get_runtime_config,
            quit_app,
            move_pet_window,
            resize_pet_window,
            get_disk_usage,
            get_system_stats,
            list_processes,
            search_files,
            list_recent_files,
            list_directory,
            get_metrics_history,
            get_recent_alerts,
            scan_desktop_files,
            capture_screen,
            // 贾维斯系统操控能力
            list_windows,
            control_window,
            move_window,
            get_window_rect,
            mouse_click,
            mouse_double_click,
            mouse_drag,
            mouse_scroll,
            type_text,
            press_keys,
            open_path,
            launch_program,
            get_network_stats,
            get_temperature_stats,
            // GPU 与多盘符监控
            get_gpu_stats,
            list_all_disks,
            // 剪贴板与多媒体
            read_clipboard,
            write_clipboard,
            set_system_volume,
            set_wallpaper,
            // 性能优化：收缩态暂停硬件监控轮询
            set_monitoring_paused,
            // 系统级集成：托盘常驻 + 全局快捷键 + 系统通知
            show_pet_window,
            hide_pet_window,
            toggle_pet_window,
            show_system_notification,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    eprintln!("[rag] Event loop exited.");
}
