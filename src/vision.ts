import { config } from './config.js'
import { createLogger } from './logger.js'

const log = createLogger('vision')

// The most recent screen capture pushed by the frontend before the agent
// runs its tool loop. Stored in memory only — never persisted to disk.
let lastScreenCapture: string | null = null

const OLLAMA_TIMEOUT_MS = 30_000

/**
 * Store the latest screen capture (base64 PNG, no data: prefix) so the
 * capture_screen_vision tool can forward it to Ollama llava. The frontend
 * is expected to call the Tauri `capture_screen` command and POST the result
 * to /api/agent/execute with the `screenshot` field before invoking the tool.
 */
export function setLastScreenCapture(base64Png: string): void {
  // Strip optional data: prefix
  const stripped = base64Png.replace(/^data:image\/\w+;base64,/, '')
  lastScreenCapture = stripped
  log.info('Screen capture stored', { bytes: stripped.length })
}

export function getLastScreenCapture(): string | null {
  return lastScreenCapture
}

/**
 * Send the stored screenshot to the local Ollama llava model and return
 * a natural-language description of the screen content.
 *
 * Requires Ollama running locally with a vision model pulled, e.g.:
 *   ollama pull llava:7b
 *   ollama pull llama3.2-vision
 *
 * The endpoint is configurable via OLLAMA_BASE_URL (default
 * http://127.0.0.1:11434) and the model via OLLAMA_VISION_MODEL
 * (default llava:7b).
 */
export async function describeScreen(question: string): Promise<string> {
  if (!lastScreenCapture) {
    return [
      '当前没有可用的屏幕截图。',
      '请让前端先调用 capture_screen 捕获屏幕，再重试。',
      '通常这是因为用户未启用屏幕捕捉开关，或截图请求失败。',
    ].join('\n')
  }

  const baseUrl = (process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '')
  const model = process.env.OLLAMA_VISION_MODEL || 'llava:7b'
  const url = `${baseUrl}/api/generate`

  const body = JSON.stringify({
    model,
    prompt: question,
    images: [lastScreenCapture],
    stream: false,
    options: { temperature: 0.3, num_predict: 400 },
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Ollama HTTP ${response.status}: ${text.slice(0, 200)}`)
    }

    const data = await response.json() as { response?: string; error?: string }
    if (data.error) throw new Error(`Ollama error: ${data.error}`)

    const description = (data.response || '').trim()
    log.info('Screen described', { model, chars: description.length })
    return description || '视觉模型未返回任何描述。'
  } catch (error) {
    clearTimeout(timeout)
    const msg = error instanceof Error ? error.message : String(error)

    // Common case: Ollama not running or model not pulled
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return [
        '无法连接本地 Ollama 视觉模型。',
        `请确认 Ollama 正在运行（${baseUrl}），并且已拉取视觉模型：`,
        `  ollama pull ${model}`,
        '',
        '在 Ollama 就绪前，我无法分析屏幕画面。',
      ].join('\n')
    }
    return `屏幕分析失败：${msg}`
  }
}

/**
 * 屏幕异常分类结果 — 供 ProactiveEngine 主动介入使用
 */
export interface ScreenAnomaly {
  /** 场景类型：coding/browsing/writing/media/error_dialog/crash_dialog/idle/other */
  scene: string
  /** 异常类型：none/error/crash/warning/stuck */
  anomaly: 'none' | 'error' | 'crash' | 'warning' | 'stuck'
  /** 一句话描述屏幕内容（≤50字） */
  summary: string
  /** 置信度 0.0-1.0 */
  confidence: number
}

const ANOMALY_PROMPT = `分析这张屏幕截图，识别当前场景和是否有异常。严格按 JSON 格式返回（不要其他文字、不要 markdown）：
{
  "scene": "coding|browsing|writing|media|error_dialog|crash_dialog|idle|other",
  "anomaly": "none|error|crash|warning|stuck",
  "summary": "一句话描述屏幕内容（不超过50字）",
  "confidence": 0.0
}

异常判定规则：
- error: 检测到错误对话框、报错消息、红色警告图标、stack trace
- crash: 检测到程序崩溃、无响应、白屏/蓝屏、异常退出
- warning: 检测到删除/覆盖/退出确认对话框
- stuck: 检测到加载卡顿、进度条长时间无变化
- none: 正常工作场景

confidence 表示对 anomaly 判断的置信度，0.0-1.0。`

/**
 * 直接传入 base64 截图生成情境描述
 * 不依赖 setLastScreenCapture，适用于周期性截屏
 */
export async function describeScreenFromBase64(
  base64Png: string,
  question: string,
): Promise<string> {
  const stripped = base64Png.replace(/^data:image\/\w+;base64,/, '')
  const baseUrl = (process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '')
  const model = process.env.OLLAMA_VISION_MODEL || 'llava:7b'
  const url = `${baseUrl}/api/generate`

  const body = JSON.stringify({
    model,
    prompt: question,
    images: [stripped],
    stream: false,
    options: { temperature: 0.3, num_predict: 200 },
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Ollama HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    const data = await response.json() as { response?: string; error?: string }
    if (data.error) throw new Error(`Ollama error: ${data.error}`)
    return (data.response || '').trim() || '视觉模型未返回任何描述。'
  } catch (error) {
    clearTimeout(timeout)
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return '视觉模型未启用（Ollama 未运行），跳过情境描述。'
    }
    return `屏幕分析失败：${msg}`
  }
}

/**
 * 分析屏幕截图的异常状态 — 供 ProactiveEngine 主动介入使用
 *
 * 调用本地 Ollama llava，用结构化 prompt 要求返回 JSON。
 * 失败时返回 anomaly='none' 的安全值，不抛错（避免阻塞周期观察）。
 */
export async function analyzeScreenForAnomaly(base64Png: string): Promise<ScreenAnomaly> {
  const stripped = base64Png.replace(/^data:image\/\w+;base64,/, '')
  const baseUrl = (process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '')
  const model = process.env.OLLAMA_VISION_MODEL || 'llava:7b'
  const url = `${baseUrl}/api/generate`

  const body = JSON.stringify({
    model,
    prompt: ANOMALY_PROMPT,
    images: [stripped],
    stream: false,
    format: 'json',  // 强制 Ollama 输出 JSON
    options: { temperature: 0.1, num_predict: 200 },
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)

  const safeResult: ScreenAnomaly = {
    scene: 'other',
    anomaly: 'none',
    summary: '',
    confidence: 0,
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Ollama HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    const data = await response.json() as { response?: string; error?: string }
    if (data.error) throw new Error(`Ollama error: ${data.error}`)
    const raw = (data.response || '').trim()
    if (!raw) return safeResult
    return parseAnomalyJson(raw)
  } catch (error) {
    clearTimeout(timeout)
    const msg = error instanceof Error ? error.message : String(error)
    log.warn('analyzeScreenForAnomaly failed', { msg })
    // 失败时返回安全值，不抛错 — 避免阻塞周期观察循环
    return safeResult
  }
}

/**
 * 容错解析 llava 返回的 JSON（可能被包裹在 markdown / 含其他文字）
 */
function parseAnomalyJson(raw: string): ScreenAnomaly {
  const safe: ScreenAnomaly = {
    scene: 'other',
    anomaly: 'none',
    summary: '',
    confidence: 0,
  }
  try {
    // 尝试直接解析
    let json: any
    try {
      json = JSON.parse(raw)
    } catch {
      // 提取第一个 {...} 块
      const match = raw.match(/\{[\s\S]*\}/)
      if (!match) return safe
      json = JSON.parse(match[0])
    }
    const validAnomalies = ['none', 'error', 'crash', 'warning', 'stuck']
    const anomaly = validAnomalies.includes(String(json.anomaly).toLowerCase())
      ? String(json.anomaly).toLowerCase() as ScreenAnomaly['anomaly']
      : 'none'
    const scene = typeof json.scene === 'string' ? json.scene.slice(0, 50) : 'other'
    const summary = typeof json.summary === 'string' ? json.summary.slice(0, 100) : ''
    const confidence = typeof json.confidence === 'number'
      ? Math.max(0, Math.min(1, json.confidence))
      : 0
    return { scene, anomaly, summary, confidence }
  } catch {
    return safe
  }
}
