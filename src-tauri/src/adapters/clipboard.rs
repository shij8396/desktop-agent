//! 剪贴板适配器 — 读取/写入系统剪贴板文本
//!
//! Windows 平台使用 Win32 OpenClipboard + GetClipboardData/SetClipboardData API；
//! 非 Windows 平台返回错误，保证编译通过。

/// 读取剪贴板文本
pub fn read_clipboard() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        read_clipboard_win32()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("剪贴板操作仅支持 Windows 平台".into())
    }
}

/// 写入文本到剪贴板
pub fn write_clipboard(text: &str) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        write_clipboard_win32(text)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = text;
        Err("剪贴板操作仅支持 Windows 平台".into())
    }
}

#[cfg(target_os = "windows")]
mod win32_impl {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    pub fn read_clipboard_win32() -> Result<String, String> {
        unsafe {
            OpenClipboard(None).map_err(|e| format!("打开剪贴板失败: {}", e))?;
            // GetClipboardData 返回 HANDLE，但实际指向的是 HGLOBAL 内存块
            // 二者内部布局相同（均为 *mut c_void），通过 .0 取裸指针后构造 HGLOBAL
            let handle = match GetClipboardData(CF_UNICODETEXT.0 as u32) {
                Ok(h) => h,
                Err(_) => {
                    let _ = CloseClipboard();
                    return Ok(String::new());
                }
            };
            let hglobal = HGLOBAL(handle.0);
            let ptr = GlobalLock(hglobal);
            if ptr.is_null() {
                let _ = CloseClipboard();
                return Err("GlobalLock 失败".into());
            }
            // 读取以 null 结尾的 UTF-16 字符串
            let mut len = 0usize;
            let base = ptr as *const u16;
            while *base.add(len) != 0 {
                len += 1;
            }
            let slice = std::slice::from_raw_parts(base, len);
            let text = OsString::from_wide(slice).to_string_lossy().into_owned();
            let _ = GlobalUnlock(hglobal);
            let _ = CloseClipboard();
            Ok(text)
        }
    }

    pub fn write_clipboard_win32(text: &str) -> Result<String, String> {
        unsafe {
            OpenClipboard(None).map_err(|e| format!("打开剪贴板失败: {}", e))?;
            let _ = EmptyClipboard();

            let mut wide: Vec<u16> = text.encode_utf16().collect();
            wide.push(0); // null terminator

            let byte_len = wide.len() * 2;
            let hglobal =
                GlobalAlloc(GMEM_MOVEABLE, byte_len).map_err(|e| format!("GlobalAlloc 失败: {}", e))?;
            let ptr = GlobalLock(hglobal);
            if ptr.is_null() {
                let _ = CloseClipboard();
                return Err("GlobalLock 失败".into());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr as *mut u8, byte_len);
            let _ = GlobalUnlock(hglobal);
            // SetClipboardData 签名为 Param<HANDLE>，需将 HGLOBAL 转回 HANDLE
            // 二者内部都是 *mut c_void，布局相同
            let handle = windows::Win32::Foundation::HANDLE(hglobal.0);
            let _ = SetClipboardData(CF_UNICODETEXT.0 as u32, handle);
            let _ = CloseClipboard();
            Ok(format!("已写入剪贴板（{} 字符）", text.chars().count()))
        }
    }
}

#[cfg(target_os = "windows")]
use win32_impl::{read_clipboard_win32, write_clipboard_win32};
