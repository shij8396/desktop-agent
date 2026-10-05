import vm from 'node:vm'
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, stat, statfs, access, readFile } from 'node:fs/promises'
import { homedir, tmpdir, cpus, totalmem, freemem, platform } from 'node:os'
import { isAbsolute, join, relative, resolve, sep, extname, basename } from 'node:path'
import { webSearch, fetchUrl, getWeather } from './webSearch.js'
import { createLogger } from './logger.js'
import { recordToolAudit } from './audit.js'
import { createPendingAction, type ActionName } from './actions.js'
import { resolveTimeExpression } from './timeParser.js'
import * as browser from './browserAgent.js'
import { describeScreen, setLastScreenCapture } from './vision.js'
import { UserMemory, UserProfile, type UserMemoryEntry, type ProfileEntry, type EmotionPoint, type RelationshipEvent } from './memory.js'
import {
  addReminder as remindersAdd,
  listReminders as remindersList,
  cancelReminder as remindersCancel,
  parseReminderTime,
} from './reminders.js'

const log = createLogger('tools')

const MAX_RESULTS = 20
const MAX_SEARCH_DEPTH = 5

export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/**
 * Only read-only tools are exposed to the model in the first enterprise slice.
 * Write, delete, open, clipboard and arbitrary-command operations deliberately
 * have no tool definition and are rejected by executeTool below.
 */
export const CORE_TOOLS: ToolDefinition[] = [
  {
    name: 'web_search',
    description: 'Search approved web sources for current information. Results include source URLs and retrieval time.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
  },
  {
    name: 'kb_search',
    description: 'Search the local knowledge base for relevant document passages. Cite the returned source when answering document facts; if no passages match, say there is no local evidence.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
  },
  {
    name: 'calculate',
    description: 'Evaluate a mathematical expression. Supports arithmetic and selected Math functions.',
    input_schema: { type: 'object', properties: { expression: { type: 'string', description: 'Math expression' } }, required: ['expression'] },
  },
  {
    name: 'get_datetime',
    description: 'Get the current date and time.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_weather',
    description: 'Query current weather for a city or location via wttr.in. Use when the user asks about weather, temperature, forecast, rain, or climate for any location.',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name (e.g. "北京", "Shanghai") or location query' },
        format: { type: 'string', description: 'wttr.in format string. Default "4" (one-line summary). Use "1" for compact current weather, "2" for detailed.' },
      },
      required: ['location'],
    },
  },
  {
    name: 'fetch_webpage',
    description: 'Fetch a web page URL and extract its main text content (HTML stripped). Use for reading articles, news, documentation, or any URL the user wants summarized.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL (https://...) to fetch' },
        maxChars: { type: 'number', description: 'Maximum characters to return (default 3000, max 8000)' },
      },
      required: ['url'],
    },
  },
  // === 长期用户记忆模块 ===
  {
    name: 'remember',
    description: 'Save a long-term user preference or habit. Use proactively when the user mentions their commonly used apps, file storage paths, frequent commands, or answer style preferences. Records persist across sessions.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['app', 'path', 'command', 'preference'], description: 'Memory category' },
        key: { type: 'string', description: 'Short identifier, e.g. "常用编辑器", "桌面路径", "翻译风格"' },
        value: { type: 'string', description: 'The value to remember, e.g. "VSCode", "D:/Desktop", "concise Chinese"' },
        ref: { type: 'string', description: 'Optional: how it was mentioned, e.g. "user said: 我习惯用VSCode"' },
      },
      required: ['type', 'key', 'value'],
    },
  },
  {
    name: 'recall_memory',
    description: 'Retrieve long-term user memories. Use when matching a new request to past habits (e.g. user asks to open "my editor" — recall their preferred editor). Pass type to filter by category, or keyword for fuzzy search.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['app', 'path', 'command', 'preference'], description: 'Optional: filter by category' },
        keyword: { type: 'string', description: 'Optional: fuzzy search keyword across key/value/ref' },
      },
    },
  },
  {
    name: 'clear_memory',
    description: 'Clear long-term user memories. Use when the user explicitly asks to forget/reset their preferences. Without a type parameter, clears ALL memories (irreversible).',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['app', 'path', 'command', 'preference'], description: 'Optional: only clear this category. If omitted, clears all.' },
      },
    },
  },
  // === 用户画像层（UserProfile）— 跨会话用户建模 ===
  {
    name: 'set_profile',
    description: 'Record or update a user profile attribute (identity/preference/routine/skill). Use proactively when the user reveals persistent facts about themselves — e.g. mentions their job, language preference, work schedule, or technical skills. Higher confidence overwrites lower. Records persist across sessions and are injected into future prompts.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['persona', 'preference', 'routine', 'skill'], description: 'Profile category: persona=身份 (job/name/role), preference=偏好 (language/style/tools), routine=作息 (work hours/schedule), skill=技能 (tech stack/abilities)' },
        key: { type: 'string', description: 'Short identifier, e.g. "职业", "首选语言", "工作时间", "Go熟练度"' },
        value: { type: 'string', description: 'The value to record, e.g. "前端工程师", "中文交流", "9-18点", "Go 1.26 熟练"' },
        confidence: { type: 'number', description: 'Confidence 0-1. Use 0.9 for explicit user statements ("我是工程师"), 0.7 for inferred facts (user works with Go frequently), 0.5 for weak signals.', minimum: 0, maximum: 1 },
      },
      required: ['category', 'key', 'value'],
    },
  },
  {
    name: 'get_profile',
    description: 'Retrieve user profile attributes. Use when adapting a response to the user — e.g. user asks "你知道我是做什么的吗" or you need their preference/routine to personalize an answer. Pass category to filter, or omit for all categories sorted by confidence.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['persona', 'preference', 'routine', 'skill'], description: 'Optional: filter by category. If omitted, returns all sorted by confidence descending.' },
      },
    },
  },
  {
    name: 'add_emotion',
    description: 'Record a user emotion point inferred from their message tone or explicit mention. Use when the user shows clear emotion — e.g. frustrated ("怎么又不行"), happy ("太棒了"), tired ("好累"), confused ("这什么意思"). Helps track emotional state over time for proactive care.',
    input_schema: {
      type: 'object',
      properties: {
        emotion: { type: 'string', enum: ['happy', 'neutral', 'frustrated', 'tired', 'excited', 'confused'], description: 'Inferred emotion: happy=开心, neutral=平静, frustrated=挫败/烦躁, tired=疲惫, excited=兴奋, confused=困惑' },
        intensity: { type: 'number', description: 'Intensity 1-5. 1=slight, 3=moderate, 5=very strong.', minimum: 1, maximum: 5 },
        trigger: { type: 'string', description: 'Optional: short trigger description, e.g. "调试失败", "项目上线", "连续加班"' },
      },
      required: ['emotion', 'intensity'],
    },
  },
  {
    name: 'add_relationship_event',
    description: 'Record a relationship milestone or significant interaction event. Use for: first-time achievements, preference changes, major incidents, positive or negative shared moments. Builds a shared history for warmer long-term interactions.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['milestone', 'preference_change', 'incident', 'positive', 'negative'], description: 'Event type: milestone=里程碑 (first task/solved big problem), preference_change=偏好转变, incident=故障/异常, positive=正面互动, negative=负面互动' },
        summary: { type: 'string', description: 'Short summary, e.g. "首次完成代码重构", "用户切换为深色主题", "工具调用连续失败 3 次"' },
      },
      required: ['type', 'summary'],
    },
  },
  // === 定时提醒（贾维斯主动任务） ===
  {
    name: 'set_reminder',
    description: 'Set a reminder that fires at a scheduled time. Use when user says "提醒我 XX"、"每天 X 点提醒 XX"、"XX 分钟后叫我"。Supports natural language time.',
    input_schema: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'When to fire. Supports ISO 8601 ("2026-07-18T09:00:00"), relative ("in 30 minutes"), or cron for recurring ("0 9 * * *" = daily 9am).' },
        message: { type: 'string', description: 'What to remind: "该开会了", "喝水时间到"' },
        recurring: { type: 'boolean', description: 'If true, time is treated as cron expression for recurring reminder.' },
      },
      required: ['time', 'message'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List all active reminders. Use when user asks "我有哪些提醒" or "提醒列表".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a scheduled reminder by ID. Use when user says "取消 XX 提醒" or "删掉这个提醒".',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Reminder ID (from list_reminders)' },
      },
      required: ['id'],
    },
  },
]

export const FILE_TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    description: 'List directory contents (read-only, max 20 entries). Supports ~ as home directory shorthand (~/Desktop, ~/Documents). IMPORTANT: when the user asks about the desktop, prefer scan_desktop_files instead (no path needed).',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path. Supports ~ (e.g. "~/Documents"). For desktop, use scan_desktop_files instead.' } }, required: ['path'] },
  },
  {
    name: 'find_files',
    description: 'Find files by filename pattern inside a user-authorized directory. This is read-only.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Authorized directory path' },
        pattern: { type: 'string', description: 'Filename pattern, such as *.pdf' },
        maxDepth: { type: 'number', description: 'Maximum search depth (1-5; default 3)' },
      },
      required: ['directory', 'pattern'],
    },
  },
  {
    name: 'disk_usage',
    description: 'Get total, available and used space for a local drive or directory. This is read-only.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Drive or directory path, e.g. C:\\' } }, required: ['path'] },
  },
  {
    name: 'cpu_usage',
    description: 'Get current CPU usage and memory information. Returns overall CPU usage percentage, per-core usage, and memory stats.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_recent_files',
    description: 'List files modified within a time range. Supports natural language time expressions like "昨天" (yesterday), "3天前" (3 days ago), "今天" (today), "上周" (last week). Searches user-authorized directories.',
    input_schema: {
      type: 'object',
      properties: {
        timeExpression: { type: 'string', description: 'Natural language time expression, e.g. "昨天", "3天前", "今天上午"' },
        directory: { type: 'string', description: 'Optional: specific authorized directory to search. Defaults to Desktop and Documents.' },
      },
      required: ['timeExpression'],
    },
  },
  {
    name: 'read_file_content',
    description: 'Read the text content of a file for analysis. Returns up to 64KB of content. Only works on authorized paths and text-based files (.txt, .md, .json, .csv, .xml, .html, .js, .ts, .py, .rs, .java, .log, .yaml, .yml, .toml).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
        maxBytes: { type: 'number', description: 'Maximum bytes to read (default 65536, max 65536)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'analyze_file',
    description: 'Read a file and generate an AI analysis/summary. Supports text files and documents (.txt, .md, .json, .csv, .pdf, .docx). Returns a structured summary including key points, entities, and topics. Max file size: 5MB.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to analyze' },
        question: { type: 'string', description: 'Optional: specific question about the file content' },
      },
      required: ['path'],
    },
  },
  {
    name: 'launch_app',
    description: 'Launch an application by name. Searches common install locations. Requires user confirmation (L2).',
    input_schema: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: 'Application name, e.g. "chrome", "notepad", "calculator"' },
      },
      required: ['app_name'],
    },
  },
  {
    name: 'find_program',
    description: 'Find installed program locations on the system. Searches Start Menu shortcuts, common install directories (Program Files, AppData/Local, etc.), and PATH. Use when the user asks "where is X installed", "find X on my computer", or mentions a program name with intent to locate it (e.g. "抖音在哪", "chrome 在哪里"). Supports both Chinese and English names, fuzzy substring match.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Program name to search. Supports Chinese (e.g. "抖音", "微信") and English (e.g. "chrome", "vscode"). Substring match — partial names work.' },
        max_results: { type: 'number', description: 'Optional: max results to return. Default 10.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Capture a screenshot of the current screen. Returns the screenshot as base64 image data for analysis.',
    input_schema: {
      type: 'object',
      properties: {
        region: { type: 'string', description: 'Optional: screen region to capture. Values: "full", "window". Default: "full"' },
      },
    },
  },
  {
    name: 'batch_move_files',
    description: 'Move multiple files to a target directory. Requires explicit user confirmation. Use with caution.',
    input_schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of file paths to move',
        },
        target_dir: { type: 'string', description: 'Target directory path' },
      },
      required: ['files', 'target_dir'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file or folder (recursively for folders). Irreversible — requires explicit user confirmation. Use when the user asks to delete, remove, or trash a file/folder.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path of the file or folder to delete' } },
      required: ['path'],
    },
  },
  {
    name: 'copy_file',
    description: 'Copy a single file to a target directory. If a file with the same name exists, appends _1/_2 suffix. Requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path of the source file' },
        target_dir: { type: 'string', description: 'Target directory path' },
      },
      required: ['source', 'target_dir'],
    },
  },
  {
    name: 'move_file',
    description: 'Move/cut a single file to a target directory. If a file with the same name exists, appends _1/_2 suffix. Requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute path of the source file' },
        target_dir: { type: 'string', description: 'Target directory path' },
      },
      required: ['source', 'target_dir'],
    },
  },
  {
    name: 'rename_file',
    description: 'Rename a file or folder. The new name must not contain \\ / : * ? " < > |. Requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file/folder to rename' },
        new_name: { type: 'string', description: 'New name (not full path, just the filename)' },
      },
      required: ['path', 'new_name'],
    },
  },
  {
    name: 'create_folder',
    description: 'Create a new folder inside a parent directory. Fails if the folder already exists. Requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        parent_dir: { type: 'string', description: 'Absolute path of the parent directory' },
        folder_name: { type: 'string', description: 'Name of the new folder' },
      },
      required: ['parent_dir', 'folder_name'],
    },
  },
  {
    name: 'scan_desktop_files',
    description: 'Scan all files on the user\'s Desktop and return name, path, extension, size, and last modified time. Use when the user asks about desktop files, recent files, or what\'s on the desktop.',
    input_schema: {
      type: 'object',
      properties: {
        filter_extension: { type: 'string', description: 'Optional: filter by file extension (e.g. "pdf", "docx"). Without leading dot.' },
      },
    },
  },
  {
    name: 'capture_screen_vision',
    description: 'Capture the current screen and use a vision model (Ollama llava) to describe what\'s on screen — text, windows, icons, images. Use when the user asks to see, read, or analyze the screen, a window, or asks "what\'s on my screen".',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Optional: specific question about the screen content' },
      },
    },
  },
]

/**
 * 贾维斯系统操控工具 — 窗口管理、键鼠模拟、硬件采集。
 * 这些能力由桌面端 Tauri 层提供（Win32/enigo），Node 端无法直接执行。
 * 处理器返回 DESKTOP_REQUIRED 标记，由前端监听 SSE 事件后调用对应 Tauri 命令。
 */
export const SYSTEM_CONTROL_TOOLS: ToolDefinition[] = [
  {
    name: 'list_windows',
    description: 'List all visible top-level windows with their titles and process IDs. Use when the user asks about open windows, running apps, or wants to switch to/close a specific program.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'control_window',
    description: 'Control a specific window: minimize, maximize, restore, or close it. Find the window by partial title match or hwnd.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Partial window title to find (e.g. "Chrome", "记事本")' },
        action: { type: 'string', enum: ['minimize', 'maximize', 'restore', 'close'], description: 'Action to perform' },
        hwnd: { type: 'number', description: 'Optional: exact window handle from list_windows' },
      },
      required: ['action'],
    },
  },
  {
    name: 'mouse_click',
    description: 'Simulate a mouse click at screen coordinates (x, y). Requires keyboard/mouse control permission enabled.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Screen X coordinate' },
        y: { type: 'number', description: 'Screen Y coordinate' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_double_click',
    description: 'Simulate a mouse double-click at screen coordinates. Use when the user asks to double-click an icon, file, or shortcut.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Screen X coordinate' },
        y: { type: 'number', description: 'Screen Y coordinate' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_drag',
    description: 'Simulate a mouse drag from (from_x, from_y) to (to_x, to_y). Use when the user asks to drag a window, file, or selection.',
    input_schema: {
      type: 'object',
      properties: {
        from_x: { type: 'number', description: 'Start X coordinate' },
        from_y: { type: 'number', description: 'Start Y coordinate' },
        to_x: { type: 'number', description: 'End X coordinate' },
        to_y: { type: 'number', description: 'End Y coordinate' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left)' },
        steps: { type: 'number', description: 'Intermediate points for smooth dragging (default: 20, max: 200)' },
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
  },
  {
    name: 'mouse_scroll',
    description: 'Simulate mouse wheel scrolling. Use when the user asks to scroll up/down/left/right.',
    input_schema: {
      type: 'object',
      properties: {
        axis: { type: 'string', enum: ['vertical', 'horizontal'], description: 'Scroll axis (default: vertical)' },
        amount: { type: 'number', description: 'Scroll amount (positive = down/right, negative = up/left; each unit ~ 15° click)' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'type_text',
    description: 'Type a string of text as if the user pressed the keys. Useful for filling forms or entering commands.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to type' } },
      required: ['text'],
    },
  },
  {
    name: 'press_keys',
    description: 'Press a key or key combination. Supports single keys (enter, escape) and combos with + (ctrl+c, alt+f4, win+e).',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key combo, e.g. "enter", "ctrl+c", "alt+tab", "win+e"' } },
      required: ['key'],
    },
  },
  {
    name: 'open_path',
    description: 'Open a file, folder, or URL using the system default handler (like double-clicking). Safe for folders, documents, and web URLs.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File/folder path or URL to open' } },
      required: ['path'],
    },
  },
  {
    name: 'launch_program',
    description: 'Launch an application by name or full path. Searches common install locations. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { app_name: { type: 'string', description: 'Application name, e.g. "chrome", "notepad", "calculator"' } },
      required: ['app_name'],
    },
  },
  {
    name: 'get_network_stats',
    description: 'Get real-time network interface speeds (upload/download in bytes/sec). Use when the user asks about network speed or connectivity.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_temperature_stats',
    description: 'Get temperature sensor readings (CPU, motherboard, disk). Use when the user asks about hardware temperature or overheating.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_gpu_stats',
    description: 'Get GPU status (name, temperature, utilization, memory). NVIDIA only — returns error for Intel/AMD integrated graphics. Use when the user asks about graphics card or GPU.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_all_disks',
    description: 'List all mounted disk volumes and their usage (total/used/free/percentage). Use when the user asks about all drives or multiple disks.',
    input_schema: { type: 'object', properties: {} },
  },
  // === 剪贴板读写 ===
  {
    name: 'read_clipboard',
    description: 'Read text from the system clipboard. Use when the user asks to read, get, or check what is in the clipboard.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'write_clipboard',
    description: 'Write text to the system clipboard (copy). Use when the user asks to copy, set, or put text into the clipboard.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to write to the clipboard' } },
      required: ['text'],
    },
  },
  // === 窗口控制扩展 ===
  {
    name: 'move_window',
    description: 'Move a window to a new position and optionally resize it. Use when the user asks to move, reposition, or resize a specific window.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Window title (partial match). Used if hwnd is not provided.' },
        hwnd: { type: 'number', description: 'Window handle from list_windows. Takes priority over title.' },
        x: { type: 'number', description: 'New X position' },
        y: { type: 'number', description: 'New Y position' },
        width: { type: 'number', description: 'Optional: new width in pixels' },
        height: { type: 'number', description: 'Optional: new height in pixels' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'get_window_rect',
    description: 'Get the position and size of a window. Use when the user asks about a window\'s location, size, or geometry.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Window title (partial match)' },
        hwnd: { type: 'number', description: 'Window handle from list_windows' },
      },
    },
  },
  // === 系统多媒体 ===
  {
    name: 'set_system_volume',
    description: 'Adjust system volume. Actions: "up" (increase), "down" (decrease), "mute" (toggle mute), "set" (set to specific level 0-100).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['up', 'down', 'mute', 'set'], description: 'Volume action' },
        level: { type: 'number', description: 'Volume level 0-100 (only used when action="set")' },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_wallpaper',
    description: 'Change the desktop wallpaper to an image file. The path must point to a valid image file (jpg, png, bmp).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the image file' } },
      required: ['path'],
    },
  },
  // === Word 文档工具（生成/编辑 .docx）===
  {
    name: 'create_docx',
    description:
      'Create a new Word (.docx) document without overwriting an existing file. Requires confirmation. content supports lightweight markdown: # heading, - bullet list, | a | b | table, **bold**. The path must end with .docx and be inside an authorized directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute target path ending with .docx, e.g. C:\\Users\\xxx\\Desktop\\report.docx' },
        content: { type: 'string', description: 'Document content in lightweight markdown (headings, lists, tables, paragraphs, **bold**).' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_docx',
    description:
      'Edit an existing Word (.docx) document after explicit confirmation. The original is backed up, then rebuilt and overwritten; complex formatting (images, comments, macros) may be lost. The path must end with .docx and be inside an authorized directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the existing .docx file' },
        content: { type: 'string', description: 'New document content in lightweight markdown (headings, lists, tables, paragraphs, **bold**).' },
      },
      required: ['path', 'content'],
    },
  },
  // === 浏览器自动化工具（Playwright + 系统 Edge）===
  {
    name: 'browser_open',
    description: 'Open (navigate to) a URL in the shared browser page. Use before reading or interacting with any webpage. Example: browser_open with url https://www.baidu.com',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL to open (https://...). Empty to open a blank page.' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_search',
    description: 'Search the web in the browser using a search engine (baidu/bing/sogou/google, default baidu). Directly opens the results page and returns the top text results. Prefer this over browser_open + browser_fill when the user just wants to search something.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords, e.g. 今日天气' },
        engine: { type: 'string', enum: ['baidu', 'bing', 'sogou', 'google'], description: 'Search engine (optional, default baidu)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_extract',
    description: 'Extract the rendered visible text of the current browser page. Use to read content of pages that load content via JavaScript.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Click an element in the current page. target can be text=按钮文字 or a CSS selector (e.g. #submit, .btn, a[href*="login"]).',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'CSS selector or text=label to click' } },
      required: ['target'],
    },
  },
  {
    name: 'browser_fill',
    description: 'Fill text into an input field in the current page. Use before pressing Enter to submit a search or form.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'CSS selector of the input (e.g. #kw, input[name="q"])' },
        value: { type: 'string', description: 'Text to type into the field' },
      },
      required: ['target', 'value'],
    },
  },
  {
    name: 'browser_press',
    description: 'Press a keyboard key. Usually press Enter in the search field to submit. selector is optional (empty = current focus).',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to focus before pressing (optional, may be empty)' },
        key: { type: 'string', description: 'Key name: Enter, Tab, Escape, ArrowDown, etc.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the current page. direction: down / up / top / bottom.',
    input_schema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'Scroll direction' } },
      required: ['direction'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a full-page screenshot of the current page. If save_path is given, saves the PNG into an authorized directory and returns the path; otherwise returns base64 data.',
    input_schema: {
      type: 'object',
      properties: { save_path: { type: 'string', description: 'Optional absolute path to save the PNG (inside an authorized directory)' } },
    },
  },
  {
    name: 'browser_back',
    description: 'Go back to the previous page in browser history.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_refresh',
    description: 'Reload the current page.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_close',
    description: 'Close the browser and free resources. Call when browser automation is finished.',
    input_schema: { type: 'object', properties: {} },
  },
]

export const TOOLS: ToolDefinition[] = [...CORE_TOOLS, ...FILE_TOOLS, ...SYSTEM_CONTROL_TOOLS]

let agentRef: { searchInKb: (query: string) => string } | null = null

export function setAgentRef(ref: typeof agentRef) {
  agentRef = ref
}

/** 路径白名单逻辑已抽至 pathPolicy.ts；import 提供本地绑定，export 保持 imports 兼容 */
import { setAuthorizedRoots, getAuthorizedRoots, isAuthorizedPath, expandHome } from './pathPolicy.js'
export { setAuthorizedRoots, getAuthorizedRoots, isAuthorizedPath, expandHome }

function policyDenied(name: string): string {
  return JSON.stringify({
    ok: false,
    error: 'POLICY_DENIED',
    message: `Tool ${name} is not enabled in the read-only assistant. This action requires the confirmation workflow.`,
  })
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export interface ToolExecutionContext {
  sessionId?: string
  taskId?: string
}

export async function executeTool(name: string, input: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  const startedAt = Date.now()
  try {
    let result: string
    switch (name) {
      case 'web_search': result = await handleWebSearch(input.query); break
      case 'kb_search': result = handleKbSearch(input.query); break
      case 'calculate': result = handleCalculate(input.expression); break
      case 'get_datetime': result = handleGetDatetime(); break
      case 'get_weather': result = await handleGetWeather(input.location, input.format); break
      case 'fetch_webpage': result = await handleFetchWebpage(input.url, input.maxChars); break
      case 'remember': result = await handleRemember(input); break
      case 'recall_memory': result = await handleRecallMemory(input); break
      case 'clear_memory': result = await handleClearMemory(input); break
      case 'set_profile': result = await handleSetProfile(input); break
      case 'get_profile': result = await handleGetProfile(input); break
      case 'add_emotion': result = await handleAddEmotion(input); break
      case 'add_relationship_event': result = await handleAddRelationshipEvent(input); break
      case 'set_reminder': result = await handleSetReminder(input); break
      case 'list_reminders': result = await handleListReminders(input); break
      case 'cancel_reminder': result = await handleCancelReminder(input); break
      case 'list_files': result = await handleListFiles(input.path); break
      case 'find_files': result = await handleFindFiles(input.directory, input.pattern, input.maxDepth); break
      case 'disk_usage': result = await handleDiskUsage(input.path); break
      case 'cpu_usage': result = handleCpuUsage(); break
      case 'list_recent_files': result = await handleListRecentFiles(input.timeExpression, input.directory); break
      case 'read_file_content':
      case 'read_file': result = await handleReadFileContent(input.path, input.maxBytes); break
      case 'analyze_file': result = await handleAnalyzeFile(input.path, input.question); break
      case 'launch_app': result = await handleLaunchApp(input.app_name); break
      case 'find_program': result = await handleFindProgram(input); break
      case 'take_screenshot': result = handleTakeScreenshot(input.region); break
      case 'open_file': result = await handleActionRequest('open_file', input, context); break
      case 'write_file': result = await handleActionRequest('write_file', input, context); break
      case 'batch_move_files': result = await handleBatchMoveFiles(input.files, input.target_dir, context); break
      // 新增文件操作工具 — 全部走 L2/L3 确认流程
      case 'delete_file':
      case 'copy_file':
      case 'move_file':
      case 'rename_file':
      case 'create_folder': result = await handleActionRequest(name, input, context); break
      case 'scan_desktop_files': result = await handleScanDesktopFiles(input.filter_extension); break
      case 'capture_screen_vision': result = await handleCaptureScreenVision(input.question); break
      // Word 文档工具（生成/编辑 .docx）
      case 'create_docx': result = await handleWordDocAction('create_docx', input, context); break
      case 'edit_docx': result = await handleWordDocAction('edit_docx', input, context); break
      // 浏览器自动化工具（Playwright + 系统 Edge）
      case 'browser_open': result = json(await browser.open(String(input.url ?? ''))); break
      case 'browser_search': result = json(await browser.search(String(input.query ?? ''), String(input.engine ?? 'bing'))); break
      case 'browser_extract': result = json(await browser.extract()); break
      case 'browser_click': result = json(await browser.click(String(input.target ?? ''))); break
      case 'browser_fill': result = json(await browser.fill(String(input.target ?? ''), String(input.value ?? ''))); break
      case 'browser_press': result = json(await browser.press(String(input.selector ?? ''), String(input.key ?? ''))); break
      case 'browser_scroll': result = json(await browser.scroll(String(input.direction ?? ''))); break
      case 'browser_screenshot': result = json(await browser.screenshot(typeof input.save_path === 'string' ? input.save_path : undefined)); break
      case 'browser_back': result = json(await browser.back()); break
      case 'browser_refresh': result = json(await browser.refresh()); break
      case 'browser_eval': result = policyDenied(name); break
      case 'browser_close': result = json(await browser.close()); break
      // 贾维斯系统操控工具
      case 'open_path': result = await handleOpenPath(input.path); break
      case 'launch_program': result = await handleLaunchProgram(input.app_name ?? input.program, input.args); break
      case 'list_windows':
      case 'control_window':
      case 'move_window':
      case 'get_window_rect':
      case 'mouse_click':
      case 'mouse_double_click':
      case 'mouse_drag':
      case 'mouse_scroll':
      case 'type_text':
      case 'press_keys':
      case 'get_network_stats':
      case 'get_temperature_stats':
      case 'get_gpu_stats':
      case 'list_all_disks':
      case 'read_clipboard':
      case 'write_clipboard':
      case 'set_system_volume':
      case 'set_wallpaper':
        result = desktopRequired(name, input); break
      case 'exec_command':
      case 'ingest_docs': result = policyDenied(name); break
      default: result = json({ ok: false, error: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` })
    }
    await recordToolAudit({ name, input, result, durationMs: Date.now() - startedAt })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Tool execution failed', { name, error: message })
    const result = json({ ok: false, error: 'TOOL_ERROR', message })
    await recordToolAudit({ name, input, result, durationMs: Date.now() - startedAt })
    return result
  }
}

async function handleActionRequest(action: ActionName, input: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  const pending = await createPendingAction(action, input, context)
  return json(pending)
}

async function handleBatchMoveFiles(filesValue: unknown, targetDirValue: unknown, context?: ToolExecutionContext): Promise<string> {
  if (!Array.isArray(filesValue) || filesValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'files must be a non-empty array' })
  }
  if (typeof targetDirValue !== 'string' || targetDirValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'target_dir is required' })
  }

  const files = filesValue as string[]
  const targetDir = String(targetDirValue)

  // Validate all source paths are authorized (after expanding ~)
  for (const f of files) {
    if (typeof f !== 'string' || !isAuthorizedPath(expandHome(f))) {
      return json({ ok: false, error: 'ACCESS_DENIED', message: `File is outside authorized directories: ${f}` })
    }
  }

  // Validate target directory is authorized (after expanding ~)
  if (!isAuthorizedPath(expandHome(targetDir))) {
    return json({ ok: false, error: 'ACCESS_DENIED', message: 'Target directory is outside authorized directories' })
  }

  // Validate file count limit
  if (files.length > 50) {
    return json({ ok: false, error: 'TOO_MANY_FILES', message: 'Maximum 50 files per batch operation' })
  }

  return json(await createPendingAction('batch_move_files', { files, target_dir: targetDir }, context))
}

async function handleWebSearch(query: unknown): Promise<string> {
  if (typeof query !== 'string' || query.trim().length === 0 || query.length > 300) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'query must be a non-empty string of at most 300 characters' })
  }
  const retrievedAt = new Date().toISOString()
  const results = await webSearch(query.trim(), 5)
  return json({
    ok: results.length > 0,
    tool: 'web_search',
    query: query.trim(),
    retrievedAt,
    results: results.slice(0, 5),
    ...(results.length ? {} : { error: 'SEARCH_EMPTY', message: '搜索没有返回可验证来源；请调整关键词或说明无法联网核实。' }),
  })
}

function handleKbSearch(query: unknown): string {
  if (typeof query !== 'string' || query.trim().length === 0) return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'query is required' })
  if (!agentRef) return json({ ok: false, error: 'UNAVAILABLE', message: 'Knowledge base is not available' })
  return agentRef.searchInKb(query.trim())
}

function handleCalculate(expression: unknown): string {
  if (typeof expression !== 'string' || expression.length > 200) return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'expression is invalid' })
  if (!/^[\d\s+\-*/%().,eE]+$/.test(expression) && !/Math\.\w+/.test(expression)) return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'Invalid characters in expression' })
  const allowed = new Set(['Math.abs', 'Math.ceil', 'Math.floor', 'Math.round', 'Math.sqrt', 'Math.pow', 'Math.log', 'Math.log10', 'Math.sin', 'Math.cos', 'Math.tan', 'Math.PI', 'Math.E', 'Math.max', 'Math.min'])
  const sanitized = expression.replace(/Math\.\w+/g, match => allowed.has(match) ? match : 'undefined')
  try {
    return json({ ok: true, result: vm.runInNewContext(sanitized, Object.create(null), { timeout: 1000 }) })
  } catch (error) {
    return json({ ok: false, error: 'INVALID_EXPRESSION', message: error instanceof Error ? error.message : String(error) })
  }
}

function handleGetDatetime(): string {
  const now = new Date()
  return json({
    ok: true,
    timestamp: now.toISOString(),
    localTime: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    weekday: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(now),
    timeZone: 'Asia/Shanghai',
  })
}

/**
 * 天气查询 — 通过 wttr.in 获取实时天气。wttr.in 免费且无需 API key。
 * 内置一次重试：若首次返回错误信息（"天气查询失败"），等待 2 秒重试一次。
 */
async function handleGetWeather(locationValue: unknown, formatValue: unknown): Promise<string> {
  if (typeof locationValue !== 'string' || locationValue.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'location is required (e.g. "北京", "Shanghai")' })
  }
  const location = String(locationValue).trim().slice(0, 100)
  const fmt = typeof formatValue === 'string' && formatValue.length > 0 && formatValue.length <= 8
    ? formatValue
    : '4'

  let result = await getWeather(location, fmt)
  // 重试一次：若首次失败，等待 2 秒后重试
  if (result.startsWith('天气查询失败') || result.startsWith('Failed')) {
    log.warn('weather query failed, retrying once', { location })
    await new Promise(r => setTimeout(r, 2000))
    const retryResult = await getWeather(location, fmt)
    if (!retryResult.startsWith('天气查询失败') && !retryResult.startsWith('Failed')) {
      result = retryResult
    }
  }

  const ok = !result.startsWith('天气查询失败') && !result.startsWith('Failed')
  return json({
    ok,
    tool: 'get_weather',
    location,
    format: fmt,
    retrievedAt: new Date().toISOString(),
    weather: result,
    message: ok ? `已获取 ${location} 的天气信息` : result,
  })
}

/**
 * 网页内容提取 — 抓取 URL 文本供 LLM 总结。
 * 区分失败原因：HTTP 错误、网络超时、内容为空。
 */
async function handleFetchWebpage(urlValue: unknown, maxCharsValue: unknown): Promise<string> {
  if (typeof urlValue !== 'string' || urlValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'url is required' })
  }
  let url: string
  try {
    url = String(urlValue).trim()
    new URL(url)
  } catch {
    return json({ ok: false, error: 'INVALID_URL', message: `Invalid URL: ${urlValue}` })
  }
  const maxChars = typeof maxCharsValue === 'number' && maxCharsValue > 0
    ? Math.min(Math.floor(maxCharsValue), 8000)
    : 3000

  const text = await fetchUrl(url, maxChars)
  const failed = text.startsWith('Failed to fetch') || text.startsWith('Fetch failed')
  return json({
    ok: !failed,
    tool: 'fetch_webpage',
    url,
    maxChars,
    retrievedAt: new Date().toISOString(),
    content: failed ? undefined : text,
    ...(failed ? { error: /HTTP 403\b/.test(text) ? 'HTTP_FORBIDDEN' : 'FETCH_FAILED' } : {}),
    message: failed ? text : `已提取网页内容（${text.length} 字符）`,
    ...(failed ? { nextStep: '不要重试同一被拒绝页面；可用 web_search 寻找其它来源，并明确说明正文未获取。' } : {}),
  })
}

// ===== 长期用户记忆工具处理器 =====

function getUserMemory(): UserMemory {
  return UserMemory.getInstance()
}

function isValidMemoryType(v: unknown): v is UserMemoryEntry['type'] {
  return v === 'app' || v === 'path' || v === 'command' || v === 'preference'
}

/**
 * 记录用户偏好/习惯。LLM 在识别到用户提及常用软件、文件路径、偏好时主动调用。
 */
async function handleRemember(input: Record<string, unknown>): Promise<string> {
  const type = input.type
  const key = input.key
  const value = input.value
  const ref = input.ref
  if (!isValidMemoryType(type)) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'type must be one of: app, path, command, preference' })
  }
  if (typeof key !== 'string' || key.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'key is required' })
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'value is required' })
  }
  try {
    const entry = await getUserMemory().remember(
      type,
      String(key),
      String(value),
      typeof ref === 'string' ? ref : undefined,
    )
    return json({
      ok: true,
      tool: 'remember',
      entry,
      message: `已记住：${entry.type}/${entry.key} = ${entry.value}`,
    })
  } catch (error) {
    return json({ ok: false, error: 'MEMORY_ERROR', message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 检索用户记忆。LLM 在用户提及"我的编辑器"、"常用路径"等时调用以匹配历史习惯。
 */
async function handleRecallMemory(input: Record<string, unknown>): Promise<string> {
  const type = isValidMemoryType(input.type) ? input.type : undefined
  const keyword = typeof input.keyword === 'string' ? input.keyword : undefined
  try {
    const entries = await getUserMemory().recall(type, keyword)
    return json({
      ok: true,
      tool: 'recall_memory',
      filter: { type: type ?? null, keyword: keyword ?? null },
      total: entries.length,
      entries,
      message: entries.length > 0
        ? `找到 ${entries.length} 条记忆`
        : '未找到匹配的用户记忆',
    })
  } catch (error) {
    return json({ ok: false, error: 'MEMORY_ERROR', message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 清空用户记忆。不传 type 则清空全部（不可逆）。
 */
async function handleClearMemory(input: Record<string, unknown>): Promise<string> {
  const type = isValidMemoryType(input.type) ? input.type : undefined
  try {
    const result = await getUserMemory().clear(type)
    return json({
      ok: true,
      tool: 'clear_memory',
      clearedType: type ?? 'all',
      cleared: result.cleared,
      message: type
        ? `已清空 ${type} 类型的 ${result.cleared} 条记忆`
        : `已清空全部 ${result.cleared} 条用户记忆`,
    })
  } catch (error) {
    return json({ ok: false, error: 'MEMORY_ERROR', message: error instanceof Error ? error.message : String(error) })
  }
}

// ===== 用户画像层（UserProfile）工具处理器 =====

function getUserProfile(): UserProfile {
  return UserProfile.getInstance()
}

function isValidProfileCategory(v: unknown): v is ProfileEntry['category'] {
  return v === 'persona' || v === 'preference' || v === 'routine' || v === 'skill'
}

function isValidEmotion(v: unknown): v is EmotionPoint['emotion'] {
  return v === 'happy' || v === 'neutral' || v === 'frustrated' || v === 'tired' || v === 'excited' || v === 'confused'
}

function isValidRelationshipType(v: unknown): v is RelationshipEvent['type'] {
  return v === 'milestone' || v === 'preference_change' || v === 'incident' || v === 'positive' || v === 'negative'
}

/**
 * 记录/更新用户画像属性。
 * LLM 在识别到用户身份/偏好/作息/技能等持久信息时主动调用。
 */
async function handleSetProfile(input: Record<string, unknown>): Promise<string> {
  const category = input.category
  const key = input.key
  const value = input.value
  const confidence = input.confidence
  if (!isValidProfileCategory(category)) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'category must be one of: persona, preference, routine, skill' })
  }
  if (typeof key !== 'string' || key.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'key is required' })
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'value is required' })
  }
  let c = 0.7
  if (typeof confidence === 'number' && !Number.isNaN(confidence)) {
    c = Math.max(0, Math.min(1, confidence))
  }
  try {
    await getUserProfile().setProfile(category, String(key), String(value), c)
    return json({
      ok: true,
      tool: 'set_profile',
      entry: { category, key: String(key).trim().slice(0, 60), value: String(value).trim().slice(0, 300), confidence: c },
      message: `已记录用户画像：${category}/${String(key).trim()} = ${String(value).trim()}`,
    })
  } catch (error) {
    return json({ ok: false, error: 'PROFILE_ERROR', message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 查询用户画像属性。LLM 在需要个性化回答时调用。
 */
async function handleGetProfile(input: Record<string, unknown>): Promise<string> {
  const category = isValidProfileCategory(input.category) ? input.category : undefined
  try {
    const entries = await getUserProfile().getProfile(category)
    return json({
      ok: true,
      tool: 'get_profile',
      filter: { category: category ?? null },
      total: entries.length,
      entries,
      message: entries.length > 0
        ? `找到 ${entries.length} 条画像${category ? `（${category}）` : ''}`
        : '暂无用户画像数据',
    })
  } catch (error) {
    return json({ ok: false, error: 'PROFILE_ERROR', message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 记录用户情绪轨迹点。LLM 从用户语气推断情绪时调用。
 */
async function handleAddEmotion(input: Record<string, unknown>): Promise<string> {
  const emotion = input.emotion
  const intensity = input.intensity
  const trigger = input.trigger
  if (!isValidEmotion(emotion)) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'emotion must be one of: happy, neutral, frustrated, tired, excited, confused' })
  }
  let intensityNum = 3
  if (typeof intensity === 'number' && !Number.isNaN(intensity)) {
    intensityNum = Math.max(1, Math.min(5, Math.round(intensity)))
  }
  try {
    await getUserProfile().addEmotion(emotion, intensityNum, typeof trigger === 'string' ? trigger : undefined)
    return json({
      ok: true,
      tool: 'add_emotion',
      entry: { emotion, intensity: intensityNum, trigger: typeof trigger === 'string' ? trigger.slice(0, 100) : undefined },
      message: `已记录情绪：${emotion} (强度 ${intensityNum})`,
    })
  } catch (error) {
    return json({ ok: false, error: 'PROFILE_ERROR', message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 记录关系历史事件。LLM 在重大互动节点时调用。
 */
async function handleAddRelationshipEvent(input: Record<string, unknown>): Promise<string> {
  const type = input.type
  const summary = input.summary
  if (!isValidRelationshipType(type)) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'type must be one of: milestone, preference_change, incident, positive, negative' })
  }
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'summary is required' })
  }
  try {
    await getUserProfile().addRelationshipEvent({ type, summary: String(summary) })
    return json({
      ok: true,
      tool: 'add_relationship_event',
      entry: { type, summary: String(summary).trim().slice(0, 200) },
      message: `已记录关系事件：${type} — ${String(summary).trim()}`,
    })
  } catch (error) {
    return json({ ok: false, error: 'PROFILE_ERROR', message: error instanceof Error ? error.message : String(error) })
  }
}

// === 定时提醒 ===
// 实际存储与持久化由 ./reminders.ts 负责（JSON 文件 + 启动时重新调度）
async function handleSetReminder(input: Record<string, unknown>): Promise<string> {
  const time = input.time
  const message = input.message
  const recurring = Boolean(input.recurring)
  if (typeof time !== 'string' || time.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'time is required (ISO 8601, relative, or cron)' })
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'message is required' })
  }
  try {
    const reminder = await remindersAdd({ time, message, recurring })
    return json({
      ok: true,
      tool: 'set_reminder',
      reminder: { id: reminder.id, time: reminder.time, message: reminder.message, recurring: reminder.recurring },
      message: recurring
        ? `已设置周期提醒：${reminder.message}（cron: ${reminder.time}）`
        : `已设置提醒：${reminder.message}（${reminder.time}）`,
    })
  } catch (error) {
    return json({ ok: false, error: 'SET_REMINDER_FAILED', message: String(error) })
  }
}

async function handleListReminders(_input: Record<string, unknown>): Promise<string> {
  const list = await remindersList()
  return json({ ok: true, tool: 'list_reminders', reminders: list, total: list.length })
}

async function handleCancelReminder(input: Record<string, unknown>): Promise<string> {
  const id = input.id
  if (typeof id !== 'string' || id.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'id is required' })
  }
  const ok = await remindersCancel(id)
  if (!ok) {
    return json({ ok: false, error: 'NOT_FOUND', message: `reminder ${id} not found` })
  }
  return json({ ok: true, tool: 'cancel_reminder', id, message: '已取消提醒' })
}

async function handleListFiles(pathValue: unknown): Promise<string> {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'path is required' })
  }
  // 展开 ~/Desktop、~\Desktop 等波浪号路径
  const expanded = expandHome(pathValue.trim())

  // 智能识别桌面路径 → 直接 fallback 到 scan_desktop_files（无需 LLM 二次决策）
  const desktopDir = resolveDesktopDir()
  if (resolve(expanded).toLowerCase() === resolve(desktopDir).toLowerCase()) {
    log.info('list_files: detected desktop path, falling back to scan_desktop_files', { original: pathValue, resolved: desktopDir })
    return handleScanDesktopFiles(null)
  }

  if (!isAuthorizedPath(expanded)) {
    // 授权目录外（如 C:\）→ 走桌面端桥接：前端经 Tauri list_directory 读取。
    // 安全性由设置面板「系统权限-文件读取」开关把关（前端拒绝时回 POLICY_DENIED）。
    return desktopRequired('list_files', { path: pathValue })
  }
  const path = resolve(expanded)
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      return json({ ok: false, error: 'PATH_NOT_FOUND', message: `路径不存在: ${pathValue}（已展开为 ${path}）。请确认路径正确，或使用 scan_desktop_files 自动扫描桌面。` })
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return json({ ok: false, error: 'PERMISSION_DENIED', message: `权限不足，无法访问: ${path}。请尝试使用管理员权限运行，或换用其他目录。` })
    }
    if (code === 'EBUSY') {
      return json({ ok: false, error: 'FILE_LOCKED', message: `文件被占用: ${path}。请关闭正在使用该文件的程序后重试。` })
    }
    return json({ ok: false, error: 'READ_FAILED', message: `读取目录失败: ${msg}` })
  }
  const items = await Promise.all(entries.filter(entry => !entry.name.startsWith('.')).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, MAX_RESULTS).map(async entry => {
    const fullPath = join(path, entry.name)
    const info = entry.isFile() ? await stat(fullPath).catch(() => null) : null
    return { name: entry.name, path: fullPath, kind: entry.isDirectory() ? 'directory' : 'file', sizeBytes: info?.size ?? null }
  }))
  return json({ ok: true, path, items, truncated: entries.length > MAX_RESULTS, limit: MAX_RESULTS })
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

async function handleFindFiles(directoryValue: unknown, patternValue: unknown, maxDepthValue: unknown): Promise<string> {
  if (typeof directoryValue !== 'string' || directoryValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'directory is required' })
  }
  const expandedDir = expandHome(directoryValue.trim())
  if (!isAuthorizedPath(expandedDir)) return json({ ok: false, error: 'ACCESS_DENIED', message: `Directory is outside user-authorized directories: ${directoryValue}` })
  if (typeof patternValue !== 'string' || patternValue.length === 0 || patternValue.length > 100) return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'pattern is invalid' })
  const directory = resolve(expandedDir)
  const maxDepth = typeof maxDepthValue === 'number' && Number.isInteger(maxDepthValue) ? Math.max(1, Math.min(maxDepthValue, MAX_SEARCH_DEPTH)) : 3
  const pattern = wildcardToRegex(patternValue)
  const matches: string[] = []
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth || matches.length >= MAX_RESULTS) return
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (matches.length >= MAX_RESULTS) break
      const fullPath = join(current, entry.name)
      if (entry.isFile() && pattern.test(entry.name)) matches.push(fullPath)
      else if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(fullPath, depth + 1)
    }
  }
  await walk(directory, 0)
  return json({ ok: true, directory, pattern: patternValue, matches, limit: MAX_RESULTS, truncated: matches.length >= MAX_RESULTS })
}

async function handleDiskUsage(pathValue: unknown): Promise<string> {
  if (typeof pathValue !== 'string' || pathValue.length === 0 || pathValue.length > 260) return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'path is required' })
  const target = resolve(pathValue.endsWith(':') ? `${pathValue}${sep}` : pathValue)
  const info = await statfs(target)
  const totalBytes = Number(info.blocks) * Number(info.bsize)
  const availableBytes = Number(info.bavail) * Number(info.bsize)
  return json({ ok: true, path: target, totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - availableBytes), sampledAt: new Date().toISOString() })
}

function handleCpuUsage(): string {
  const cpuList = cpus()
  const totalMem = totalmem()
  const freeMem = freemem()
  const usedMem = totalMem - freeMem

  // Calculate CPU usage from times
  const perCore = cpuList.map(cpu => {
    const { user, nice, sys, idle } = cpu.times
    const total = user + nice + sys + idle
    const usage = total > 0 ? Math.round(((total - idle) / total) * 100) : 0
    return { core: cpu.model, usagePercent: usage }
  })

  // Average across cores
  const overallUsage = perCore.length > 0
    ? Math.round(perCore.reduce((sum, c) => sum + c.usagePercent, 0) / perCore.length)
    : 0

  return json({
    ok: true,
    cpu: {
      overallUsagePercent: overallUsage,
      coreCount: cpuList.length,
      perCore,
      model: cpuList[0]?.model ?? 'unknown',
    },
    memory: {
      totalBytes: totalMem,
      availableBytes: freeMem,
      usedBytes: usedMem,
      usedPercentage: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
    },
    sampledAt: new Date().toISOString(),
  })
}

async function handleListRecentFiles(timeExpressionValue: unknown, directoryValue: unknown): Promise<string> {
  if (typeof timeExpressionValue !== 'string' || timeExpressionValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'timeExpression is required' })
  }
  const timeExpr = timeExpressionValue as string
  const resolution = resolveTimeExpression(timeExpr)
  if (!resolution) {
    return json({ ok: false, error: 'TIME_PARSE_FAILED', message: `Could not parse time expression: ${timeExpr}. Supported: 今天, 昨天, 前天, N天前, 上周, 这周, 刚才, 今天上午/下午, N月N日` })
  }

  // Determine search directory
  let searchDirs: string[]
  if (typeof directoryValue === 'string' && directoryValue.length > 0) {
    const expanded = expandHome(directoryValue)
    if (!isAuthorizedPath(expanded)) {
      return json({ ok: false, error: 'ACCESS_DENIED', message: `Directory is outside user-authorized directories: ${directoryValue}` })
    }
    searchDirs = [resolve(expanded)]
  } else {
    // Default: search Desktop and Documents
    const roots = getAuthorizedRoots()
    searchDirs = roots.filter(root =>
      root.includes('Desktop') || root.includes('Documents')
    )
    if (searchDirs.length === 0) searchDirs = roots.slice(0, 2)
  }

  // Walk and filter by time
  const results: Array<{ name: string; path: string; modifiedAt: string; sizeBytes: number }> = []
  const afterMs = resolution.start.getTime()
  const beforeMs = resolution.end?.getTime() ?? Date.now()

  for (const dir of searchDirs) {
    async function walkRecent(current: string, depth: number): Promise<void> {
      if (depth > MAX_SEARCH_DEPTH || results.length >= MAX_RESULTS) return
      let entries
      try { entries = await readdir(current, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) break
        if (entry.name.startsWith('.')) continue
        const fullPath = join(current, entry.name)
        if (entry.isFile()) {
          try {
            const info = await stat(fullPath)
            const modifiedMs = info.mtimeMs
            if (modifiedMs >= afterMs && modifiedMs < beforeMs) {
              results.push({
                name: entry.name,
                path: fullPath,
                modifiedAt: new Date(modifiedMs).toISOString(),
                sizeBytes: info.size,
              })
            }
          } catch { /* skip unreadable files */ }
        } else if (entry.isDirectory()) {
          await walkRecent(fullPath, depth + 1)
        }
      }
    }
    await walkRecent(dir, 0)
  }

  // Sort by modification time (newest first)
  results.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())

  return json({
    ok: true,
    timeExpression: timeExpr,
    resolvedRange: {
      start: resolution.start.toISOString(),
      end: resolution.end?.toISOString() ?? null,
      matched: resolution.matched,
    },
    directories: searchDirs,
    results,
    totalFound: results.length,
    truncated: results.length >= MAX_RESULTS,
    limit: MAX_RESULTS,
  })
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.xml', '.html', '.htm', '.js', '.ts', '.py', '.rs', '.java', '.c', '.cpp', '.h', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.sh', '.bat', '.ps1'])

async function handleReadFileContent(pathValue: unknown, maxBytesValue: unknown): Promise<string> {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'path is required' })
  }
  const expanded = expandHome(pathValue.trim())
  if (!isAuthorizedPath(expanded)) {
    return json({ ok: false, error: 'ACCESS_DENIED', message: `File is outside user-authorized directories: ${pathValue}` })
  }
  const filePath = resolve(expanded)
  const ext = extname(filePath).toLowerCase()
  if (!TEXT_EXTENSIONS.has(ext)) {
    return json({ ok: false, error: 'UNSUPPORTED_TYPE', message: `Only text-based files are supported. Got: ${ext || 'no extension'}. Supported: ${Array.from(TEXT_EXTENSIONS).join(', ')}` })
  }

  const maxBytes = typeof maxBytesValue === 'number' ? Math.min(maxBytesValue, 65536) : 65536

  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return json({ ok: false, error: 'NOT_A_FILE', message: 'Path is not a regular file' })
    }
    const { open } = await import('node:fs/promises')
    const handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    await handle.close()
    const content = buffer.subarray(0, bytesRead).toString('utf-8')

    return json({
      ok: true,
      path: filePath,
      content,
      bytesRead,
      totalSize: info.size,
      truncated: info.size > maxBytes,
      encoding: 'utf-8',
    })
  } catch (error) {
    return json({ ok: false, error: 'READ_FAILED', message: error instanceof Error ? error.message : String(error) })
  }
}

async function handleAnalyzeFile(pathValue: unknown, questionValue: unknown): Promise<string> {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'path is required' })
  }
  const expanded = expandHome(pathValue.trim())
  if (!isAuthorizedPath(expanded)) {
    return json({ ok: false, error: 'ACCESS_DENIED', message: `File is outside user-authorized directories: ${pathValue}` })
  }
  const filePath = resolve(expanded)
  const ext = extname(filePath).toLowerCase()

  const textExts = ['.txt', '.md', '.json', '.csv', '.xml', '.html', '.htm', '.js', '.ts', '.py', '.rs', '.java', '.log', '.yaml', '.yml', '.toml']
  const docExts = ['.pdf', '.docx']

  if (!textExts.includes(ext) && !docExts.includes(ext)) {
    return json({ ok: false, error: 'UNSUPPORTED_TYPE', message: `Supported: text files (${textExts.join(', ')}) and documents (${docExts.join(', ')})` })
  }

  try {
    const info = await stat(filePath)
    if (!info.isFile()) return json({ ok: false, error: 'NOT_A_FILE', message: 'Path is not a regular file' })
    if (info.size > 5_000_000) return json({ ok: false, error: 'FILE_TOO_LARGE', message: 'File exceeds 5MB limit' })

    let content: string
    if (ext === '.pdf') {
      const pdfParse = (await import('pdf-parse')).default
      const buffer = await readFile(filePath)
      const pdfData = await pdfParse(buffer)
      content = pdfData.text
    } else if (ext === '.docx') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ path: filePath })
      content = result.value
    } else {
      content = await readFile(filePath, 'utf-8')
    }

    const maxChars = 32768
    const truncated = content.length > maxChars ? content.slice(0, maxChars) + '\n...[truncated]' : content

    const question = typeof questionValue === 'string' ? questionValue : '请总结这个文件的主要内容、关键信息和要点。'

    return json({
      ok: true,
      path: filePath,
      fileName: basename(filePath),
      fileSize: info.size,
      fileType: ext,
      content: truncated,
      contentLength: content.length,
      truncated: content.length > maxChars,
      analysisPrompt: `以下是文件 ${basename(filePath)} 的内容。${question}\n\n---文件内容开始---\n${truncated}\n---文件内容结束---`,
    })
  } catch (error) {
    return json({ ok: false, error: 'ANALYZE_FAILED', message: error instanceof Error ? error.message : String(error) })
  }
}

async function resolveAppPath(appName: string): Promise<string[]> {
  const results: string[] = []
  const platform = process.platform

  if (platform === 'win32') {
    if (isAbsolute(appName) && ['.exe', '.lnk'].includes(extname(appName).toLowerCase())) {
      try { if ((await stat(appName)).isFile()) return [appName] } catch { /* Keep searching. */ }
    }
    const exts = extname(appName) ? [''] : ['.exe', '.lnk']
    const dirs = [
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      join(homedir(), 'AppData', 'Local', 'Programs'),
      join(homedir(), 'Desktop'),
      ...getAuthorizedRoots(),
    ]

    const nameMap: Record<string, string> = {
      'chrome': 'Google\\Chrome\\Application\\chrome.exe',
      'notepad': 'Windows\\System32\\notepad.exe',
      'calculator': 'Windows\\System32\\calc.exe',
      'calc': 'Windows\\System32\\calc.exe',
      'explorer': 'Windows\\explorer.exe',
      'code': 'Microsoft VS Code\\Code.exe',
      'vscode': 'Microsoft VS Code\\Code.exe',
      'edge': 'Microsoft\\Edge\\Application\\msedge.exe',
      'word': 'Microsoft Office\\root\\Office16\\WINWORD.EXE',
      'excel': 'Microsoft Office\\root\\Office16\\EXCEL.EXE',
      'powerpoint': 'Microsoft Office\\root\\Office16\\POWERPNT.EXE',
    }

    const mapped = nameMap[appName.toLowerCase()]
    if (mapped) {
      for (const dir of dirs) {
        const fullPath = join(dir, mapped)
        try {
          if ((await stat(fullPath)).isFile()) results.push(fullPath)
        } catch { /* not found */ }
      }
    }

    if (results.length === 0) {
      for (const dir of dirs) {
        for (const ext of exts) {
          const tryPath = join(dir, `${appName}${ext}`)
          try {
            if ((await stat(tryPath)).isFile()) results.push(tryPath)
            break
          } catch { /* not found */ }
        }
      }
    }

    if (results.length === 0) {
      const query = basename(appName, extname(appName)).toLowerCase().replace(/\s+/g, '')
      const shortcuts: string[] = []
      const startMenus = [
        join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
      ]
      for (const menu of startMenus) {
        await walkDirForMatches(menu, query, 5, 20, (candidate, name) => {
          if (extname(name).toLowerCase() === '.lnk') shortcuts.push(candidate)
        })
      }
      const preferredName = query === 'wps' ? 'wpsoffice' : query
      shortcuts.sort((a, b) => launchMatchScore(b, preferredName) - launchMatchScore(a, preferredName))
      results.push(...shortcuts)
    }
  }

  return results
}

async function handleLaunchApp(appNameValue: unknown): Promise<string> {
  if (typeof appNameValue !== 'string' || appNameValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'app_name is required' })
  }
  const appName = normalizeAppName(String(appNameValue).trim())
  if (isBlockedProgram(appName)) return json({ ok: false, error: 'POLICY_DENIED', message: '不允许通过桌面助手启动命令解释器。' })

  const candidates = await resolveAppPath(appName)
  if (candidates.length === 0) {
    return json({ ok: false, error: 'APP_NOT_FOUND', message: `Could not find application: ${appName}. Try providing the full path.` })
  }
  if (await isBlockedLaunchTarget(candidates[0])) return json({ ok: false, error: 'POLICY_DENIED', message: '不允许通过桌面助手启动命令解释器。' })

  // 桌面端会展示一次性确认卡，用户确认后才调用 Tauri。
  return desktopRequired('launch_app', { program: candidates[0] })
}

// ===== find_program: 查找程序安装位置 =====

interface ProgramMatch {
  name: string
  path: string
  source: 'start_menu_user' | 'start_menu_system' | 'install_dir' | 'path_env'
  shortcut_target?: string
}

const EXECUTABLE_EXTENSIONS = new Set(['.exe', '.lnk', '.bat', '.cmd'])

/**
 * 在 Start Menu 和常见安装目录中查找程序。
 * - Start Menu 快捷方式：最可靠，几乎所有安装的应用都有
 * - 常见安装目录：Program Files / AppData/Local / AppData/Roaming
 * - 名称匹配：大小写不敏感的子串匹配（"抖音" / "douyin" 都能匹配 "Douyin.exe"）
 */
async function handleFindProgram(input: Record<string, unknown>): Promise<string> {
  const queryValue = input.query
  if (typeof queryValue !== 'string' || queryValue.trim().length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'query is required' })
  }
  const query = queryValue.trim()
  const maxResults = typeof input.max_results === 'number' && Number.isInteger(input.max_results)
    ? Math.max(1, Math.min(input.max_results, 50))
    : 10

  // 规范化查询：小写 + 去空格
  const q = query.toLowerCase().replace(/\s+/g, '')
  const results: ProgramMatch[] = []
  const seen = new Set<string>()

  const addMatch = (m: ProgramMatch) => {
    const key = m.path.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    results.push(m)
  }

  // 1. 搜索 Start Menu 快捷方式（深度 5）
  const startMenuRoots: Array<{ dir: string; source: ProgramMatch['source'] }> = [
    {
      dir: join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      source: 'start_menu_user',
    },
    {
      dir: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
      source: 'start_menu_system',
    },
  ]
  for (const root of startMenuRoots) {
    await walkDirForMatches(root.dir, q, 5, 200, (path, name) => {
      addMatch({ name, path, source: root.source })
    })
    if (results.length >= maxResults) break
  }

  // 2. 搜索常见安装目录（深度 3）
  if (results.length < maxResults) {
    const installDirs = [
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      join(homedir(), 'AppData', 'Local'),
      join(homedir(), 'AppData', 'Roaming'),
      join(homedir(), 'AppData', 'Local', 'Programs'),
    ]
    for (const dir of installDirs) {
      await walkDirForMatches(dir, q, 3, 100, (path, name) => {
        addMatch({ name, path, source: 'install_dir' })
      })
      if (results.length >= maxResults) break
    }
  }

  // 3. PATH 环境变量（使用 where 命令）
  if (results.length < maxResults && process.platform === 'win32') {
    try {
      const pathMatches = await searchPathEnv(query)
      for (const p of pathMatches) {
        if (results.length >= maxResults) break
        const name = basename(p)
        addMatch({ name, path: p, source: 'path_env' })
      }
    } catch { /* where 命令失败时忽略 */ }
  }

  // 4. 全盘搜索回退（仅当前面都没找到时启用，限制深度 3 + 60 秒超时）
  // 场景：用户手动解压的程序（如 D:\抖音\douyin\douyin.exe），
  //      没有 Start Menu 快捷方式、不在 Program Files、不在 PATH。
  if (results.length === 0 && process.platform === 'win32') {
    const drives = await listWindowsDrives()
    const searchDeadline = Date.now() + 60_000  // 60 秒超时
    for (const drive of drives) {
      if (results.length >= maxResults || Date.now() > searchDeadline) break
      await walkDirForMatches(drive, q, 3, maxResults, (path, name) => {
        addMatch({ name, path, source: 'install_dir' })
      }, searchDeadline)
    }
  }

  // 5. 解析 .lnk 快捷方式的目标路径（Windows）
  if (process.platform === 'win32') {
    for (const r of results.slice(0, 5)) {  // 只解析前 5 个，避免过多 PowerShell 调用
      if (r.path.toLowerCase().endsWith('.lnk')) {
        try {
          const target = await resolveShortcutTarget(r.path)
          if (target) r.shortcut_target = target
        } catch { /* 解析失败不影响返回 */ }
      }
    }
  }

  return json({
    ok: true,
    query,
    total: results.length,
    results: results.slice(0, maxResults),
    searched_locations: {
      start_menu: startMenuRoots.map(r => r.dir),
      install_dirs: [
        'C:\\Program Files',
        'C:\\Program Files (x86)',
        join(homedir(), 'AppData', 'Local'),
        join(homedir(), 'AppData', 'Roaming'),
        join(homedir(), 'AppData', 'Local', 'Programs'),
      ],
      path_env: process.platform === 'win32',
    },
    message: results.length > 0
      ? `找到 ${results.length} 个匹配项`
      : `未找到名为 "${query}" 的程序。建议：1) 确认程序已安装；2) 尝试英文别名（如 "抖音" → "douyin"）；3) 询问用户是否通过其他途径安装`,
  })
}

/**
 * 递归遍历目录，查找名称匹配查询的 .exe / .lnk / .bat / .cmd 文件。
 * 遇到权限错误静默跳过，不抛出。
 */
async function walkDirForMatches(
  rootDir: string,
  queryLower: string,
  maxDepth: number,
  maxMatches: number,
  onMatch: (path: string, name: string) => void,
  deadline?: number,  // 可选：超时时间戳（Date.now() + ms）
): Promise<void> {
  let matchCount = 0
  const visited = new Set<string>()

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth || matchCount >= maxMatches) return
    if (deadline !== undefined && Date.now() > deadline) return  // 超时检查
    const resolved = resolve(current)
    if (visited.has(resolved)) return
    visited.add(resolved)

    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return  // 权限拒绝 / 目录不存在 — 静默跳过
    }

    for (const entry of entries) {
      if (matchCount >= maxMatches) return
      if (deadline !== undefined && Date.now() > deadline) return  // 超时检查
      const entryName = String(entry.name)
      const fullPath = join(current, entryName)
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1)
      } else if (entry.isFile()) {
        const ext = extname(entryName).toLowerCase()
        if (!EXECUTABLE_EXTENSIONS.has(ext)) continue
        const nameLower = entryName.toLowerCase().replace(/\s+/g, '')
        // 子串匹配（双向）：query 包含 name 或 name 包含 query
        if (nameLower.includes(queryLower) || queryLower.includes(nameLower)) {
          onMatch(fullPath, entryName)
          matchCount++
        }
      }
    }
  }

  await walk(rootDir, 0)
}

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

/**
 * 在 PATH 环境变量中查找可执行文件。
 * Windows 使用 where 命令，Linux/macOS 使用 which。
 */
async function searchPathEnv(query: string): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execAsync(`${cmd} ${JSON.stringify(query)}`, { timeout: 5000 })
    return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 5)
  } catch {
    return []
  }
}

/**
 * 列出 Windows 上所有可用盘符（C:\ D:\ 等）。
 * 通过 wmic 命令获取，避免直接访问所有盘符造成延迟。
 */
async function listWindowsDrives(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('wmic logicaldisk get name', { timeout: 3000 })
    const drives = stdout
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => /^[A-Z]:$/.test(s))
      .map(s => s + '\\')
    return drives.length > 0 ? drives : ['C:\\']
  } catch {
    return ['C:\\']
  }
}

/**
 * 解析 Windows .lnk 快捷方式的目标路径。
 * 使用 PowerShell WScript.Shell COM 对象。
 */
async function resolveShortcutTarget(lnkPath: string): Promise<string | null> {
  // 用单引号包裹路径，转义内部单引号
  const escaped = lnkPath.replace(/'/g, "''")
  const psCmd = `(New-Object -ComObject WScript.Shell).CreateShortcut('${escaped}').TargetPath`
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { timeout: 3000, windowsHide: true })
    const target = stdout.trim()
    return target || null
  } catch {
    return null
  }
}

function handleTakeScreenshot(regionValue: unknown): string {
  const region = typeof regionValue === 'string' ? regionValue : 'full'
  return json({
    ok: true,
    message: 'Screenshot capture requested. The frontend will capture the screen and include it in the next query.',
    region,
    note: 'Use this tool when the user asks to see or analyze the screen. The actual capture is handled by the desktop app.',
  })
}

/**
 * Resolve the user's Desktop directory cross-platform.
 * On Windows: %USERPROFILE%\Desktop — falls back to APPDATA\..\Desktop
 * On macOS/Linux: ~/Desktop
 */
function resolveDesktopDir(): string {
  if (platform() === 'win32') {
    const userProfile = process.env.USERPROFILE
    if (userProfile) return join(userProfile, 'Desktop')
    const oneDrive = process.env.OneDrive
    if (oneDrive) return join(oneDrive, 'Desktop')
    return join(homedir(), 'Desktop')
  }
  return join(homedir(), 'Desktop')
}

/**
 * Scan the Desktop directory and return all files (non-recursive).
 * Mirrors the Rust scan_desktop_files command but stays in the Node side
 * car so the Agent can call it as a function tool without a round-trip
 * through the frontend. Directories are skipped; symlinks are not followed.
 * Entries that cannot be stat'd (Windows ACL denials) are skipped silently.
 */
async function handleScanDesktopFiles(filterExtValue: unknown): Promise<string> {
  const desktopDir = resolveDesktopDir()
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(desktopDir, { withFileTypes: true })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.warn('scan_desktop_files: read failed', { desktopDir, error: msg })
    return json({ ok: false, error: 'READ_FAILED', message: `Cannot read desktop directory: ${desktopDir}. ${msg}` })
  }

  const filterExt = typeof filterExtValue === 'string' && filterExtValue.length > 0
    ? filterExtValue.toLowerCase().replace(/^\./, '')
    : null

  const results: Array<{
    name: string
    path: string
    extension: string
    size_bytes: number
    modified_at: string | null
  }> = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const fullPath = join(desktopDir, entry.name)
    let info
    try {
      info = await stat(fullPath)
    } catch {
      continue // ACL-denied — skip silently
    }
    const ext = extname(entry.name).slice(1).toLowerCase()
    if (filterExt && ext !== filterExt) continue

    results.push({
      name: entry.name,
      path: fullPath,
      extension: ext,
      size_bytes: info.size,
      modified_at: info.mtime.toISOString(),
    })
  }

  // Sort by modified time descending (newest first)
  results.sort((a, b) => (b.modified_at ?? '').localeCompare(a.modified_at ?? ''))

  return json({
    ok: true,
    tool: 'scan_desktop_files',
    directory: desktopDir,
    count: results.length,
    files: results,
    truncated: false,
  })
}

/**
 * Capture-screen-vision tool: uses the last screenshot captured by the
 * frontend (stored via setLastScreenCapture) and sends it to Ollama llava
 * for natural-language description. If no screenshot is available, returns
 * a hint telling the model to ask the frontend to capture first.
 */
async function handleCaptureScreenVision(questionValue: unknown): Promise<string> {
  const question = typeof questionValue === 'string' && questionValue.trim().length > 0
    ? questionValue.trim()
    : '请描述屏幕上显示的内容，包括文字、窗口、图标和图片。'

  const description = await describeScreen(question)
  return json({
    ok: true,
    tool: 'capture_screen_vision',
    description,
    capturedAt: new Date().toISOString(),
  })
}

/** Word writes always enter the same approval workflow as other file mutations. */
async function handleWordDocAction(name: 'create_docx' | 'edit_docx', input: Record<string, unknown>, context?: ToolExecutionContext): Promise<string> {
  if (typeof input.path !== 'string' || !input.path.trim()) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'path 是必填的字符串参数' })
  }
  if (typeof input.content !== 'string' || !input.content.trim()) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'content 是必填的字符串参数' })
  }
  return handleActionRequest(name, { path: input.path, content: input.content }, context)
}

function launchMatchScore(candidate: string, preferredName: string): number {
  const name = basename(candidate, extname(candidate)).toLowerCase().replace(/\s+/g, '')
  if (name === preferredName) return 100
  if (name.startsWith(preferredName)) return 50
  return 10
}

/** Allow the frontend (via /api/agent/execute screenshot param) to push a
 *  fresh screen capture before the agent runs its tool loop. */
export function ingestScreenCapture(base64Png: string): void {
  setLastScreenCapture(base64Png)
}

/**
 * ===== 桌面端桥接（Tauri）=====
 * 这些工具由桌面端 Tauri 层执行。流程：
 * 1. executeTool 返回 DESKTOP_REQUIRED + toolId 标记（不立即失败）
 * 2. 引擎检测到标记 → 向前端推送 desktop_request SSE 事件（含 toolId/tool/input）
 * 3. 前端调用对应 Tauri 命令 → POST /api/agent/desktop-result 回传结果
 * 4. resolveDesktopActionResult 唤醒 awaitDesktopActionResult 的等待 → 引擎继续
 */
interface PendingDesktopAction {
  promise: Promise<string>
  resolve: (result: string) => void
  timer: NodeJS.Timeout
}
const pendingDesktopActions = new Map<string, PendingDesktopAction>()

/**
 * 等待前端回传桌面端执行结果。若 desktopRequired 已先行注册同一 toolId，
 * 返回同一 promise（幂等）。超时或前端未响应时返回失败 JSON，避免挂死。
 */
export function awaitDesktopActionResult(toolId: string, timeoutMs = 30000): Promise<string> {
  const existing = pendingDesktopActions.get(toolId)
  if (existing) return existing.promise

  let resolve!: (result: string) => void
  const promise = new Promise<string>(res => { resolve = res })
  const timer = setTimeout(() => {
    if (pendingDesktopActions.get(toolId)?.promise === promise) {
      pendingDesktopActions.delete(toolId)
    }
    resolve(json({
      ok: false,
      error: 'DESKTOP_REQUIRED',
      message: '桌面端未在限定时间内响应（请确认小伴窗口正在运行，并在设置-系统权限中启用对应权限）',
    }))
  }, timeoutMs)
  pendingDesktopActions.set(toolId, { promise, resolve, timer })
  return promise
}

/**
 * 前端回传桌面端执行结果（API: POST /api/agent/desktop-result）。
 * 返回是否消费了对应的等待项。
 */
export function resolveDesktopActionResult(toolId: string, result: unknown): boolean {
  const pending = pendingDesktopActions.get(toolId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingDesktopActions.delete(toolId)
  pending.resolve(typeof result === 'string' ? result : JSON.stringify(result))
  return true
}

function newToolId(name: string): string {
  try {
    return `${name}-${crypto.randomUUID()}`
  } catch {
    return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

/**
 * 返回 DESKTOP_REQUIRED 标记 — 这些工具由桌面端 Tauri 层执行。
 * 引擎检测到 toolId 后会等待前端回传结果（见 awaitDesktopActionResult）。
 */
function desktopRequired(name: string, input: Record<string, unknown>): string {
  return json({
    ok: false,
    error: 'DESKTOP_REQUIRED',
    toolId: newToolId(name),
    tool: name,
    input,
    message: `等待桌面端执行: ${name}`,
  })
}

/**
 * 打开文件/文件夹/URL — 通过系统默认处理器（explorer/open/xdg-open）。
 * 与 open_file（需要确认）不同，open_path 直接执行，适合打开文件夹和 URL。
 */
async function handleOpenPath(pathValue: unknown): Promise<string> {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'path is required' })
  }
  const path = String(pathValue).trim()
  const { execFile } = await import('node:child_process')
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  return new Promise(resolve => {
    execFile(command, [path], { timeout: 10_000, windowsHide: true }, error => {
      if (error) {
        resolve(json({ ok: false, error: 'OPEN_FAILED', message: error.message, path }))
      } else {
        resolve(json({ ok: true, tool: 'open_path', path, message: `已打开 ${path}` }))
      }
    })
  })
}

/**
 * 启动程序 — 通过完整路径或程序名启动（交给桌面端 Tauri 执行）。
 */
async function handleLaunchProgram(programValue: unknown, argsValue: unknown): Promise<string> {
  if (typeof programValue !== 'string' || programValue.length === 0) {
    return json({ ok: false, error: 'INVALID_ARGUMENT', message: 'program is required' })
  }
  const requestedProgram = normalizeAppName(String(programValue).trim())
  if (isBlockedProgram(requestedProgram) || (Array.isArray(argsValue) && argsValue.length > 0)) {
    return json({ ok: false, error: 'POLICY_DENIED', message: '桌面助手只允许无参数启动普通应用，不允许启动命令解释器或传入命令参数。' })
  }
  const candidates = await resolveAppPath(requestedProgram)
  const program = candidates[0] ?? requestedProgram
  if (await isBlockedLaunchTarget(program)) return json({ ok: false, error: 'POLICY_DENIED', message: '不允许通过桌面助手启动命令解释器。' })
  // 启动动作统一交给桌面端 Tauri 执行（受设置-键鼠操控开关把关），
  // 避免 Node 侧 spawn 对中文程序名/快捷方式解析失败导致「启动应用无法完成」。
  return desktopRequired('launch_program', { program, args: [] })
}

function isBlockedProgram(program: string): boolean {
  const name = basename(program).toLowerCase().replace(/\.(exe|lnk)$/, '')
  return /powershell|command prompt|windows terminal/.test(name)
    || new Set(['pwsh', 'cmd', 'wt', 'wscript', 'cscript', 'mshta', 'bash', 'sh', 'python', 'pythonw', 'node', 'ruby', 'perl']).has(name)
}

async function isBlockedLaunchTarget(program: string): Promise<boolean> {
  if (isBlockedProgram(program)) return true
  if (process.platform !== 'win32' || extname(program).toLowerCase() !== '.lnk') return false
  try {
    const target = await resolveShortcutTarget(program)
    return !target || isBlockedProgram(target)
  } catch {
    return true
  }
}

function normalizeAppName(value: string): string {
  const aliases: Record<string, string> = {
    '记事本': 'notepad.exe', '计算器': 'calc.exe', '文件资源管理器': 'explorer.exe',
    '资源管理器': 'explorer.exe', '画图': 'mspaint.exe',
  }
  return aliases[value] ?? value
}
