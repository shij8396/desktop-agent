// desktop/windowBoundsManager.js
//
// 窗口位置/尺寸边界管理模块（纯函数 + 依赖注入）
//
// 4 职责：
//   - getWorkArea(getInvoke)      获取工作区（来自 Tauri get_work_area 命令）
//   - clampToWorkArea(pos, area, winSize)  把位置夹回工作区（同步，无 IO）
//   - validateAndClamp(pos, winSize, getInvoke)  获取最新 workArea 并夹回
//   - persist(pos)               持久化到 localStorage
//   - restore(defaultPos, winSize, getInvoke)  从 localStorage 恢复并夹回
//
// 设计原则：
//   - 纯函数，无类、无内部状态（便于测试）
//   - 同步函数（clampToWorkArea）用于拖拽热路径（避免 async/await 卡顿）
//   - async 函数（getWorkArea/validateAndClamp/restore）只在启动/展开/收缩等非热路径调用
//   - 失败 fallback：getWorkArea 异常时返回默认 1920x1032 工作区
//   - persist 静默失败（隐私模式/磁盘满）
//
// Acceptance criteria 覆盖：
//   AC-1, AC-8: restore
//   AC-2:       clampToWorkArea
//   AC-3:       persist + restore roundtrip
//   AC-4, AC-5, AC-6: clampToWorkArea 对不同 winSize 的行为
//
// 模块格式说明（重要）：
//   pet.html 用经典 <script> 加载本文件；ESM 的 `export` 关键字在经典脚本里是
//   SyntaxError，会导致整个文件不执行、window.WindowBounds 永远为 undefined。
//   因此这里用 UMD 模式：浏览器挂 window.WindowBounds，vitest(Node) 走 module.exports。

(function () {
const MIN_VISIBLE = 80
const POS_KEY = 'rag-pet-position'
const DEFAULT_AREA = { x: 0, y: 0, width: 1920, height: 1032 }

/**
 * 把窗口位置夹回工作区内。
 * 至少保证 MIN_VISIBLE px 露在工作区内（窗口可部分超出但不会被完全裁切）。
 *
 * @param {{x:number, y:number}} pos 待校验的位置（物理坐标）
 * @param {{x:number, y:number, width:number, height:number}} area 工作区
 * @param {{width:number, height:number}} winSize 窗口尺寸
 * @returns {{x:number, y:number}} 夹回后的位置
 */
function clampToWorkArea(pos, area, winSize) {
  // 右下边界：工作区右下角 - MIN_VISIBLE（保证至少 80px 露在边缘内）
  const maxX = area.x + area.width - Math.min(winSize.width, MIN_VISIBLE)
  const maxY = area.y + area.height - Math.min(winSize.height, MIN_VISIBLE)
  // 左上边界：工作区左上角 - winSize + MIN_VISIBLE（窗口可部分超出左/上，但至少 80px 在内）
  const minX = area.x - winSize.width + MIN_VISIBLE
  const minY = area.y - winSize.height + MIN_VISIBLE
  return {
    x: Math.max(minX, Math.min(pos.x, maxX)),
    y: Math.max(minY, Math.min(pos.y, maxY)),
  }
}

/**
 * 获取工作区（异步，调用 Tauri invoke('get_work_area')）。
 * 失败时返回默认 1920x1032，保证调用方总能拿到合理值。
 *
 * @param {() => ((cmd: string, args?: any) => Promise<any>) | null} getInvoke 返回 invoke 函数或 null
 * @returns {Promise<{x:number, y:number, width:number, height:number}>}
 */
async function getWorkArea(getInvoke) {
  const invoke = typeof getInvoke === 'function' ? getInvoke() : null
  if (!invoke) return { ...DEFAULT_AREA }
  try {
    return await invoke('get_work_area')
  } catch {
    return { ...DEFAULT_AREA }
  }
}

/**
 * 用最新 workArea 校验并夹回位置。
 *
 * @param {{x:number, y:number}} pos
 * @param {{width:number, height:number}} winSize
 * @param {() => ((cmd: string, args?: any) => Promise<any>) | null} getInvoke
 * @returns {Promise<{x:number, y:number}>}
 */
async function validateAndClamp(pos, winSize, getInvoke) {
  const area = await getWorkArea(getInvoke)
  return clampToWorkArea(pos, area, winSize)
}

/**
 * 持久化窗口位置到 localStorage。
 * 静默失败：隐私模式/磁盘满时不抛异常，下次启动用默认位置。
 *
 * @param {{x:number, y:number}} pos
 */
function persist(pos) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos))
  } catch {
    // 静默失败
  }
}

/**
 * 从 localStorage 恢复窗口位置并夹回工作区。
 *
 * @param {{x:number, y:number}} defaultPos localStorage 无值或解析失败时使用的默认位置
 * @param {{width:number, height:number}} winSize 当前窗口尺寸
 * @param {() => ((cmd: string, args?: any) => Promise<any>) | null} getInvoke
 * @returns {Promise<{x:number, y:number}>}
 */
async function restore(defaultPos, winSize, getInvoke) {
  let saved = null
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        saved = { x: parsed.x, y: parsed.y }
      }
    }
  } catch {
    // JSON 解析失败或 localStorage 不可用，回退到默认位置
  }
  const area = await getWorkArea(getInvoke)
  return clampToWorkArea(saved || defaultPos, area, winSize)
}

/**
 * 从 localStorage 删除保存的位置（用于重置）。
 */
function clearPersistedPosition() {
  try {
    localStorage.removeItem(POS_KEY)
  } catch {
    // 静默失败
  }
}

/**
 * 把窗口尺寸缩放到工作区可用范围内（保持宽高比）。
 * 当工作区宽度或高度不足以容纳请求尺寸时，按比例缩小，
 * 但不低于 minWidth/minHeight（防止窗口变得不可用）。
 *
 * AC-5: 工作区宽度 < 650 时展开聊天窗口缩放
 * AC-6: 设置抽屉（1044×500）超出工作区时缩放
 *
 * @param {{width:number, height:number}} size 请求的窗口尺寸
 * @param {{x:number, y:number, width:number, height:number}} area 工作区
 * @param {{margin?:number, minWidth?:number, minHeight?:number}} [options]
 *   margin: 工作区四周保留的边距（默认 8）
 *   minWidth: 最小宽度兜底（默认 220）
 *   minHeight: 最小高度兜底（默认 280）
 * @returns {{width:number, height:number}} 缩放后的尺寸
 */
function scaleSizeToWorkArea(size, area, options = {}) {
  const margin = options.margin ?? 8
  const minWidth = options.minWidth ?? 220
  const minHeight = options.minHeight ?? 280

  // 可用尺寸（保留四周 margin 防止贴边）
  const availW = Math.max(0, area.width - margin * 2)
  const availH = Math.max(0, area.height - margin * 2)

  let w = size.width
  let h = size.height

  // 按宽度缩放（保持宽高比）
  if (w > availW && availW > 0) {
    const ratio = availW / w
    w = Math.floor(w * ratio)
    h = Math.floor(h * ratio)
  }

  // 按高度缩放（保持宽高比）
  if (h > availH && availH > 0) {
    const ratio = availH / h
    w = Math.floor(w * ratio)
    h = Math.floor(h * ratio)
  }

  // 最小尺寸兜底（极端小工作区时窗口仍可用）
  w = Math.max(minWidth, w)
  h = Math.max(minHeight, h)

  return { width: w, height: h }
}

// UMD 导出：浏览器挂 window.WindowBounds（pet.html 经典 script），Node 走 module.exports（vitest）
const WindowBoundsModule = {
  MIN_VISIBLE,
  POS_KEY,
  clampToWorkArea,
  getWorkArea,
  validateAndClamp,
  persist,
  restore,
  clearPersistedPosition,
  scaleSizeToWorkArea,
}

if (typeof window !== 'undefined') {
  window.WindowBounds = WindowBoundsModule
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WindowBoundsModule
}
})()