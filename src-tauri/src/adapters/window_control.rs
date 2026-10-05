//! 窗口控制适配器 — 贾维斯系统操控能力
//!
//! 提供窗口枚举（标题/进程名/PID）与窗口操作（最小化/最大化/恢复/关闭/置顶/激活/移动/调整大小/几何查询）。
//! Windows 平台使用 Win32 EnumWindows + GetWindowTextW + SetWindowPos API；
//! 非 Windows 平台返回空列表并提示不支持，保证编译通过。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub hwnd: usize,
    pub title: String,
    pub process_id: u32,
    pub is_visible: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowRect {
    pub hwnd: usize,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 列出所有可见且有标题的顶层窗口。
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        list_windows_win32()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

/// 根据窗口标题（部分匹配）或 HWND 执行操作。
/// action: "minimize" | "maximize" | "restore" | "close" | "topmost" | "not_topmost" | "activate"
pub fn control_window(title_query: &str, hwnd: Option<usize>, action: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        control_window_win32(title_query, hwnd, action)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title_query, hwnd, action);
        Err("窗口控制仅支持 Windows 平台".into())
    }
}

/// 移动并调整窗口位置与尺寸
pub fn move_window(title_query: &str, hwnd: Option<usize>, x: i32, y: i32, width: Option<i32>, height: Option<i32>) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        move_window_win32(title_query, hwnd, x, y, width, height)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title_query, hwnd, x, y, width, height);
        Err("窗口移动仅支持 Windows 平台".into())
    }
}

/// 查询窗口几何信息（位置+尺寸）
pub fn get_window_rect(title_query: &str, hwnd: Option<usize>) -> Result<WindowRect, String> {
    #[cfg(target_os = "windows")]
    {
        get_window_rect_win32(title_query, hwnd)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title_query, hwnd);
        Err("窗口几何查询仅支持 Windows 平台".into())
    }
}

// ===== Windows 实现 =====
#[cfg(target_os = "windows")]
mod win32_impl {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
        PostMessageW, SetForegroundWindow, SetWindowPos, ShowWindow,
        SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WM_CLOSE,
        HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
    };

    use super::{WindowInfo, WindowRect};

    // EnumWindows 回调通过 LPARAM 传递收集容器的可变引用
    struct EnumContext {
        windows: Vec<WindowInfo>,
    }

    extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let ctx = &mut *(lparam.0 as *mut EnumContext);
            if IsWindowVisible(hwnd).as_bool() {
                let mut buf = [0u16; 512];
                let len = GetWindowTextW(hwnd, &mut buf);
                if len > 0 {
                    let title = String::from_utf16_lossy(&buf[..len as usize]);
                    let mut pid: u32 = 0;
                    GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
                    ctx.windows.push(WindowInfo {
                        hwnd: hwnd.0 as usize,
                        title,
                        process_id: pid,
                        is_visible: true,
                    });
                }
            }
            TRUE
        }
    }

    pub fn list_windows_win32() -> Result<Vec<WindowInfo>, String> {
        unsafe {
            let mut ctx = EnumContext { windows: Vec::new() };
            let lparam = LPARAM(&mut ctx as *mut _ as isize);
            let _ = EnumWindows(Some(enum_proc), lparam);
            // 按标题排序，方便查找
            ctx.windows.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
            Ok(ctx.windows)
        }
    }

    /// 通过标题部分匹配或 hwnd 定位窗口句柄
    fn resolve_hwnd(title_query: &str, hwnd: Option<usize>) -> Result<HWND, String> {
        match hwnd {
            Some(h) => Ok(HWND(h as *mut _)),
            None => {
                let windows = list_windows_win32()?;
                let q = title_query.to_lowercase();
                let found = windows
                    .iter()
                    .find(|w| w.title.to_lowercase().contains(&q))
                    .ok_or_else(|| format!("未找到标题包含 '{}' 的窗口", title_query))?;
                Ok(HWND(found.hwnd as *mut _))
            }
        }
    }

    pub fn control_window_win32(
        title_query: &str,
        hwnd: Option<usize>,
        action: &str,
    ) -> Result<String, String> {
        let target = resolve_hwnd(title_query, hwnd)?;

        unsafe {
            match action {
                "minimize" => {
                    let _ = ShowWindow(target, SW_MINIMIZE);
                    Ok("已最小化窗口".into())
                }
                "maximize" => {
                    let _ = ShowWindow(target, SW_MAXIMIZE);
                    Ok("已最大化窗口".into())
                }
                "restore" => {
                    let _ = ShowWindow(target, SW_RESTORE);
                    Ok("已恢复窗口".into())
                }
                "close" => {
                    let _ = PostMessageW(target, WM_CLOSE, None, None);
                    Ok("已发送关闭指令".into())
                }
                "topmost" => {
                    // 置顶：HWND_TOPMOST + 保持现有尺寸（SWP_NOSIZE）不激活（SWP_NOACTIVATE）
                    let _ = SetWindowPos(target, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
                    Ok("已将窗口置顶".into())
                }
                "not_topmost" => {
                    // 取消置顶
                    let _ = SetWindowPos(target, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
                    Ok("已取消窗口置顶".into())
                }
                "activate" => {
                    // 激活到前台
                    let _ = SetForegroundWindow(target);
                    Ok("已将窗口激活到前台".into())
                }
                _ => Err(format!(
                    "不支持的操作: {}（支持: minimize/maximize/restore/close/topmost/not_topmost/activate）",
                    action
                )),
            }
        }
    }

    pub fn move_window_win32(
        title_query: &str,
        hwnd: Option<usize>,
        x: i32,
        y: i32,
        width: Option<i32>,
        height: Option<i32>,
    ) -> Result<String, String> {
        let target = resolve_hwnd(title_query, hwnd)?;
        unsafe {
            // 若未提供尺寸，则保持现有尺寸（SWP_NOSIZE）
            let (w, h, flags) = match (width, height) {
                (Some(w), Some(h)) => (w, h, SWP_NOZORDER | SWP_SHOWWINDOW),
                _ => (0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW),
            };
            let _ = SetWindowPos(target, None, x, y, w, h, flags);
            Ok(format!("已移动窗口到 ({}, {}){}", x, y, if width.is_some() { format!("，尺寸 {}x{}", width.unwrap(), height.unwrap()) } else { String::new() }))
        }
    }

    pub fn get_window_rect_win32(title_query: &str, hwnd: Option<usize>) -> Result<WindowRect, String> {
        let target = resolve_hwnd(title_query, hwnd)?;
        unsafe {
            let mut rect = RECT::default();
            let _ = GetWindowRect(target, &mut rect);
            // 获取标题用于回显
            let mut buf = [0u16; 512];
            let len = GetWindowTextW(target, &mut buf);
            let title = if len > 0 { String::from_utf16_lossy(&buf[..len as usize]) } else { String::new() };
            Ok(WindowRect {
                hwnd: target.0 as usize,
                title,
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            })
        }
    }
}

#[cfg(target_os = "windows")]
use win32_impl::{control_window_win32, get_window_rect_win32, list_windows_win32, move_window_win32};
