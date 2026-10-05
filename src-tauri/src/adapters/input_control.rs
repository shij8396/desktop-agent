//! 键鼠模拟适配器 — 贾维斯系统操控能力
//!
//! 基于 enigo 跨平台库实现：
//! - 鼠标点击（左/右/中键）、鼠标移动
//! - 键盘文本输入、单键按下
//! - 打开文件夹/启动程序（调用系统默认处理器）
//!
//! 所有操作均为同步执行，由 Tauri 命令层包装为 async。

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct InputActionResult {
    pub ok: bool,
    pub message: String,
}

/// 在屏幕坐标 (x, y) 处模拟鼠标点击。
/// button: "left" | "right" | "middle"
pub fn mouse_click(x: i32, y: i32, button: &str) -> Result<InputActionResult, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("Enigo 初始化失败: {}", e))?;
    let btn = match button {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    };
    // enigo 0.2: 先移动再点击
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| format!("鼠标移动失败: {}", e))?;
    enigo
        .button(btn, Direction::Click)
        .map_err(|e| format!("鼠标点击失败: {}", e))?;
    Ok(InputActionResult {
        ok: true,
        message: format!("已在 ({}, {}) 执行 {} 键点击", x, y, button),
    })
}

/// 在屏幕坐标 (x, y) 处模拟鼠标双击。
/// button: "left" | "right" | "middle"（默认 left）
pub fn mouse_double_click(x: i32, y: i32, button: &str) -> Result<InputActionResult, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("Enigo 初始化失败: {}", e))?;
    let btn = match button {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    };
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| format!("鼠标移动失败: {}", e))?;
    // 第一次点击
    enigo
        .button(btn, Direction::Click)
        .map_err(|e| format!("鼠标点击失败: {}", e))?;
    // 短暂间隔，让系统识别为双击而非两次单击
    std::thread::sleep(std::time::Duration::from_millis(50));
    // 第二次点击
    enigo
        .button(btn, Direction::Click)
        .map_err(|e| format!("鼠标点击失败: {}", e))?;
    Ok(InputActionResult {
        ok: true,
        message: format!("已在 ({}, {}) 执行 {} 键双击", x, y, button),
    })
}

/// 模拟鼠标拖拽：从 (from_x, from_y) 按住鼠标拖动到 (to_x, to_y) 后释放。
/// button: "left" | "right" | "middle"（默认 left）
/// steps: 拖拽中间过渡点数（越大越平滑，默认 20）
pub fn mouse_drag(
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    button: &str,
    steps: u32,
) -> Result<InputActionResult, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("Enigo 初始化失败: {}", e))?;
    let btn = match button {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    };
    let steps = if steps == 0 { 20 } else { steps.min(200) };

    // 1. 移动到起点
    enigo
        .move_mouse(from_x, from_y, Coordinate::Abs)
        .map_err(|e| format!("鼠标移动失败: {}", e))?;
    // 2. 按下按钮
    enigo
        .button(btn, Direction::Press)
        .map_err(|e| format!("鼠标按下失败: {}", e))?;
    // 3. 分步移动到终点（模拟真实拖拽轨迹）
    for i in 1..=steps {
        let t = i as f32 / steps as f32;
        let cx = (from_x as f32 + (to_x as f32 - from_x as f32) * t).round() as i32;
        let cy = (from_y as f32 + (to_y as f32 - from_y as f32) * t).round() as i32;
        enigo
            .move_mouse(cx, cy, Coordinate::Abs)
            .map_err(|e| format!("鼠标拖动失败: {}", e))?;
        // 每步间隔 8ms，模拟人类拖拽节奏
        std::thread::sleep(std::time::Duration::from_millis(8));
    }
    // 4. 释放按钮
    enigo
        .button(btn, Direction::Release)
        .map_err(|e| format!("鼠标释放失败: {}", e))?;
    Ok(InputActionResult {
        ok: true,
        message: format!("已从 ({}, {}) 拖拽到 ({}, {})", from_x, from_y, to_x, to_y),
    })
}

/// 模拟鼠标滚轮滚动。
/// axis: "vertical" | "horizontal"（默认 vertical）
/// amount: 滚动量（正数向下/向右，负数向上/向左；每个单位约 15° 点击）
pub fn mouse_scroll(axis: &str, amount: i32) -> Result<InputActionResult, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("Enigo 初始化失败: {}", e))?;
    let ax = match axis.to_lowercase().as_str() {
        "horizontal" | "h" => Axis::Horizontal,
        _ => Axis::Vertical,
    };
    enigo
        .scroll(amount, ax)
        .map_err(|e| format!("滚轮滚动失败: {}", e))?;
    Ok(InputActionResult {
        ok: true,
        message: format!("已沿 {} 轴滚动 {}", axis, amount),
    })
}

/// 输入一段文本（逐字符发送）。
pub fn type_text(text: &str) -> Result<InputActionResult, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("Enigo 初始化失败: {}", e))?;
    enigo
        .text(text)
        .map_err(|e| format!("文本输入失败: {}", e))?;
    Ok(InputActionResult {
        ok: true,
        message: format!("已输入 {} 个字符", text.chars().count()),
    })
}

/// 按下单个按键或组合键。
/// key_name 支持: enter/escape/space/tab/backspace/up/down/left/right/
/// 以及组合形式 "ctrl+c"/"alt+f4"/"win+e"（自动拆分 + 号）
pub fn press_keys(key_name: &str) -> Result<InputActionResult, String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("Enigo 初始化失败: {}", e))?;

    // 拆分组合键，例如 "ctrl+c" => [ctrl, c]
    let parts: Vec<String> = key_name.split('+').map(|s| s.trim().to_lowercase()).collect();
    if parts.is_empty() {
        return Err("按键名为空".into());
    }

    // 解析修饰键与最终键
    let mut modifiers: Vec<Key> = Vec::new();
    let mut final_key: Option<Key> = None;
    for (i, part) in parts.iter().enumerate() {
        let is_last = i == parts.len() - 1;
        let key = parse_key(part.as_str())?;
        match key {
            ParsedKey::Modifier(m) => {
                if is_last {
                    // 单独按修饰键
                    enigo.key(m, Direction::Click).map_err(|e| format!("按键失败: {}", e))?;
                    return Ok(InputActionResult {
                        ok: true,
                        message: format!("已按下 {}", key_name),
                    });
                }
                modifiers.push(m);
            }
            ParsedKey::Normal(k) => {
                if is_last {
                    final_key = Some(k);
                } else {
                    // 非最后位置出现普通键，按字面处理为修饰键失败
                    return Err(format!("无法将 '{}' 作为修饰键", part));
                }
            }
        }
    }

    let final_key = final_key.ok_or_else(|| "未指定最终按键".to_string())?;

    // 按下所有修饰键
    for m in &modifiers {
        enigo.key(*m, Direction::Press).map_err(|e| format!("按键失败: {}", e))?;
    }
    // 点击最终键
    enigo.key(final_key, Direction::Click).map_err(|e| format!("按键失败: {}", e))?;
    // 释放修饰键
    for m in modifiers.iter().rev() {
        enigo.key(*m, Direction::Release).map_err(|e| format!("按键失败: {}", e))?;
    }

    Ok(InputActionResult {
        ok: true,
        message: format!("已按下 {}", key_name),
    })
}

enum ParsedKey {
    Modifier(Key),
    Normal(Key),
}

fn parse_key(name: &str) -> Result<ParsedKey, String> {
    let key = match name {
        // 修饰键
        "ctrl" | "control" => return Ok(ParsedKey::Modifier(Key::Control)),
        "alt" => return Ok(ParsedKey::Modifier(Key::Alt)),
        "shift" => return Ok(ParsedKey::Modifier(Key::Shift)),
        "meta" | "win" | "cmd" | "super" => return Ok(ParsedKey::Modifier(Key::Meta)),
        // 功能键
        "enter" | "return" => Key::Return,
        "escape" | "esc" => Key::Escape,
        "space" => Key::Space,
        "tab" => Key::Tab,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        // 单字符
        _ => {
            let c = name.chars().next().ok_or_else(|| "按键名为空".to_string())?;
            if name.len() == 1 {
                Key::Unicode(c)
            } else {
                return Err(format!("无法识别的按键: {}", name));
            }
        }
    };
    Ok(ParsedKey::Normal(key))
}

/// 通过系统默认程序打开文件/文件夹/URL。
/// Windows: explorer.exe / start
/// macOS: open
/// Linux: xdg-open
pub fn open_path(path: &str) -> Result<InputActionResult, String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开失败: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开失败: {}", e))?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("打开失败: {}", e))?;
    }
    Ok(InputActionResult {
        ok: true,
        message: format!("已打开 {}", path),
    })
}

/// 启动一个程序（通过程序名或完整路径）。
pub fn launch_program(program: &str, args: &[String]) -> Result<InputActionResult, String> {
    if !args.is_empty() {
        return Err("桌面助手不允许向程序传入命令参数".to_string());
    }
    let name = std::path::Path::new(program)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.contains("powershell")
        || name.contains("command prompt")
        || name.contains("windows terminal")
        || ["pwsh", "cmd", "wt", "wscript", "cscript", "mshta", "bash", "sh", "python", "pythonw", "node", "ruby", "perl"].contains(&name.as_str())
    {
        return Err("桌面助手不允许启动命令解释器".to_string());
    }
    #[cfg(target_os = "windows")]
    if program.to_ascii_lowercase().ends_with(".lnk") {
        if !args.is_empty() {
            return Err("快捷方式启动不支持附加参数".to_string());
        }
        return open_path(program);
    }
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map_err(|e| format!("启动程序失败: {} - {}", program, e))?;
    Ok(InputActionResult {
        ok: true,
        message: format!("已启动 {}", program),
    })
}
