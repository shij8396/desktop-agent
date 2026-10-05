//! 桌面文件监听服务 — 贾维斯自主感知能力
//!
//! 监听用户桌面目录的文件新增/修改事件，通过 Tauri 事件推送提醒。
//! 使用 notify 的 RecommendedWatcher + RecursiveMode，独立线程运行。
//! 内置 2 秒去抖，避免编辑器保存时触发多次事件。

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct FileChangeEvent {
    pub kind: String,
    pub path: String,
    pub file_name: String,
    pub timestamp: String,
}

pub struct FileWatcherService {
    running: Arc<AtomicBool>,
    watcher_handle: Mutex<Option<thread::JoinHandle<()>>>,
}

impl FileWatcherService {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            watcher_handle: Mutex::new(None),
        }
    }

    /// 启动桌面文件监听。监听 Desktop 目录（非递归，仅顶层文件）。
    pub fn start(&self, app: AppHandle) {
        if self.running.load(Ordering::SeqCst) {
            return;
        }

        let desktop_dir = match dirs::desktop_dir() {
            Some(d) => d,
            None => {
                eprintln!("[file-watcher] 无法解析桌面目录，监听未启动");
                return;
            }
        };

        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();
        let app = app.clone();

        let handle = thread::spawn(move || {
            // 简单去抖：同一文件 2 秒内只推送一次
            let last_emit: Arc<Mutex<std::collections::HashMap<PathBuf, Instant>>> =
                Arc::new(Mutex::new(std::collections::HashMap::new()));

            let (tx, rx) = std::sync::mpsc::channel();
            let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("[file-watcher] 创建 watcher 失败: {}", e);
                    return;
                }
            };

            // 监听桌面目录（非递归，避免子目录噪音）
            if let Err(e) = watcher.watch(&desktop_dir, RecursiveMode::NonRecursive) {
                eprintln!("[file-watcher] 监听桌面目录失败: {} - {}", desktop_dir.display(), e);
                return;
            }

            eprintln!("[file-watcher] 已开始监听桌面: {}", desktop_dir.display());

            while running.load(Ordering::SeqCst) {
                match rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(Ok(event)) => {
                        let kind_str = match event.kind {
                            EventKind::Create(_) => "created",
                            EventKind::Modify(_) => "modified",
                            EventKind::Remove(_) => "removed",
                            _ => continue,
                        };
                        // 仅关注文件（非目录）
                        for path in &event.paths {
                            if path.is_dir() {
                                continue;
                            }
                            let now = Instant::now();
                            let mut map = last_emit.lock().unwrap();
                            if let Some(last) = map.get(path) {
                                if now.duration_since(*last) < Duration::from_secs(2) {
                                    continue;
                                }
                            }
                            map.insert(path.clone(), now);

                            let file_name = path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string();
                            let change = FileChangeEvent {
                                kind: kind_str.to_string(),
                                path: path.to_string_lossy().to_string(),
                                file_name,
                                timestamp: chrono::Utc::now().to_rfc3339(),
                            };
                            let _ = app.emit("desktop-file-changed", &change);
                        }
                    }
                    Ok(Err(e)) => {
                        eprintln!("[file-watcher] 事件错误: {}", e);
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => break,
                }
            }
            eprintln!("[file-watcher] 监听已停止");
        });

        *self.watcher_handle.lock().unwrap() = Some(handle);
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        // 线程会在下次循环检测到 running=false 后退出
    }
}

impl Default for FileWatcherService {
    fn default() -> Self {
        Self::new()
    }
}
