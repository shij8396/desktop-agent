/**
 * ContextManager — 持续上下文感知层
 *
 * 目标：让 Agent 从"按需感知"升级为"持续感知"。
 * 后台聚合多源信号（前台窗口、最近文件、剪贴板哈希、硬件状态、网络状态），
 * 维护 5-10 分钟滑动窗口，提问时自动注入到 system prompt。
 *
 * 设计原则：
 * - 非阻塞：所有采集异步进行，失败静默降级
 * - 隐私优先：剪贴板仅存哈希不存原文；截图不进入上下文
 * - 单例模式：进程内共享，Tauri 侧事件直接推送到此
 * - 滑动窗口：默认 10 分钟，超出自动剔除
 */

import { createLogger } from './logger.js'

const log = createLogger('context-manager')

/** 上下文事件类型 */
export type ContextEventType =
  | 'foreground_window' // 前台窗口变化
  | 'recent_file'       // 最近打开/保存的文件
  | 'clipboard_hash'    // 剪贴板内容指纹（仅哈希）
  | 'hardware'          // 硬件状态快照
  | 'network'           // 网络状态
  | 'user_activity'     // 用户活动信号（鼠标/键盘活动）

export interface ContextEvent {
  type: ContextEventType
  /** ISO 时间戳 */
  timestamp: string
  /** 事件摘要（已脱敏，可直接注入 prompt） */
  summary: string
  /** 原始结构化数据（可选，用于调试） */
  data?: Record<string, unknown>
}

/** 用户活动状态 */
export interface UserActivityState {
  /** 最后一次用户活动时间（ISO） */
  last_activity_at: string
  /** 连续工作分钟数（自首次活动起） */
  continuous_work_minutes: number
  /** 是否处于空闲状态（无鼠标键盘活动超过 5 分钟） */
  is_idle: boolean
}

/** 上下文快照 — 提问时注入 prompt 的内容 */
export interface ContextSnapshot {
  /** 生成时间 */
  generated_at: string
  /** 当前前台窗口标题 */
  foreground_window: string | null
  /** 最近 5 个文件（去重） */
  recent_files: string[]
  /** 最近 5 个窗口标题（去重） */
  recent_windows: string[]
  /** 剪贴板最近的类型（文本/图片/文件）+ 哈希前 8 位 */
  clipboard_hint: string | null
  /** 硬件状态摘要 */
  hardware_summary: string | null
  /** 网络状态摘要 */
  network_summary: string | null
  /** 用户活动状态 */
  activity: UserActivityState
  /** 最近 10 分钟事件计数 */
  event_count: number
}

const WINDOW_SIZE_MS = 10 * 60 * 1000 // 10 分钟滑动窗口
const MAX_EVENTS = 200                // 单窗口最多保留 200 条事件
const MAX_RECENT_FILES = 5
const MAX_RECENT_WINDOWS = 5
const IDLE_THRESHOLD_MS = 5 * 60 * 1000 // 5 分钟无活动判定为空闲

export class ContextManager {
  private events: ContextEvent[] = []
  private lastActivityAt: Date = new Date()
  private firstActivityAt: Date = new Date()
  private lastForegroundWindow: string | null = null
  private static instance: ContextManager | null = null
  private cleanupTimer: NodeJS.Timeout | null = null

  private constructor() {
    // 每分钟清理过期事件
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 1000)
    // 不阻止进程退出
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
  }

  static getInstance(): ContextManager {
    if (!ContextManager.instance) {
      ContextManager.instance = new ContextManager()
    }
    return ContextManager.instance
  }

  /**
   * 推送一个上下文事件。
   * 由 Tauri 侧（窗口变化、文件监听）或 Node 侧（硬件轮询）调用。
   */
  pushEvent(event: Omit<ContextEvent, 'timestamp'> & { timestamp?: string }): void {
    const ev: ContextEvent = {
      type: event.type,
      timestamp: event.timestamp ?? new Date().toISOString(),
      summary: event.summary,
      data: event.data,
    }

    // 前台窗口去重：相同标题不重复推入
    if (ev.type === 'foreground_window') {
      if (ev.summary === this.lastForegroundWindow) return
      this.lastForegroundWindow = ev.summary
    }

    // 用户活动信号更新
    if (ev.type === 'user_activity') {
      this.lastActivityAt = new Date()
    }

    this.events.push(ev)
    // 容量限制
    while (this.events.length > MAX_EVENTS) {
      this.events.shift()
    }
    // 时间窗口限制
    this.cleanup()
  }

  /**
   * 获取当前上下文快照 — 提问时注入 system prompt。
   * 仅返回结构化数据，由 ragAgent 负责格式化为文本。
   */
  getSnapshot(): ContextSnapshot {
    const now = new Date()
    const windowStart = new Date(now.getTime() - WINDOW_SIZE_MS)
    const recent = this.events.filter(e => new Date(e.timestamp) >= windowStart)

    // 最近文件（去重 + 倒序）
    const recentFiles: string[] = []
    for (let i = recent.length - 1; i >= 0; i--) {
      const ev = recent[i]
      if (ev.type === 'recent_file' && !recentFiles.includes(ev.summary)) {
        recentFiles.push(ev.summary)
        if (recentFiles.length >= MAX_RECENT_FILES) break
      }
    }

    // 最近窗口标题（去重 + 倒序）
    const recentWindows: string[] = []
    for (let i = recent.length - 1; i >= 0; i--) {
      const ev = recent[i]
      if (ev.type === 'foreground_window' && !recentWindows.includes(ev.summary)) {
        recentWindows.push(ev.summary)
        if (recentWindows.length >= MAX_RECENT_WINDOWS) break
      }
    }

    // 剪贴板提示（最近一条）
    const lastClipboard = [...recent].reverse().find(e => e.type === 'clipboard_hash')

    // 硬件状态（最近一条）
    const lastHardware = [...recent].reverse().find(e => e.type === 'hardware')

    // 网络状态（最近一条）
    const lastNetwork = [...recent].reverse().find(e => e.type === 'network')

    // 用户活动状态
    const idleMs = now.getTime() - this.lastActivityAt.getTime()
    const isIdle = idleMs > IDLE_THRESHOLD_MS
    const continuousMin = Math.max(0, Math.round((now.getTime() - this.firstActivityAt.getTime()) / 60000))

    return {
      generated_at: now.toISOString(),
      foreground_window: this.lastForegroundWindow,
      recent_files: recentFiles,
      recent_windows: recentWindows,
      clipboard_hint: lastClipboard?.summary ?? null,
      hardware_summary: lastHardware?.summary ?? null,
      network_summary: lastNetwork?.summary ?? null,
      activity: {
        last_activity_at: this.lastActivityAt.toISOString(),
        continuous_work_minutes: continuousMin,
        is_idle: isIdle,
      },
      event_count: recent.length,
    }
  }

  /**
   * 将快照格式化为可注入 prompt 的中文文本。
   * 若上下文为空，返回空字符串。
   */
  getPromptText(): string {
    const s = this.getSnapshot()
    const parts: string[] = []

    if (s.foreground_window) {
      parts.push(`当前前台窗口: ${s.foreground_window}`)
    }
    if (s.recent_windows.length > 0) {
      parts.push(`最近切换的窗口: ${s.recent_windows.join(' | ')}`)
    }
    if (s.recent_files.length > 0) {
      parts.push(`最近操作过的文件: ${s.recent_files.join(' | ')}`)
    }
    if (s.clipboard_hint) {
      parts.push(`剪贴板: ${s.clipboard_hint}`)
    }
    if (s.hardware_summary) {
      parts.push(`硬件状态: ${s.hardware_summary}`)
    }
    if (s.network_summary) {
      parts.push(`网络状态: ${s.network_summary}`)
    }
    if (s.activity.continuous_work_minutes > 0) {
      const status = s.activity.is_idle ? '空闲' : `连续工作 ${s.activity.continuous_work_minutes} 分钟`
      parts.push(`用户活动: ${status}`)
    }

    if (parts.length === 0) return ''
    return `【实时上下文】\n${parts.join('\n')}`
  }

  /**
   * 标记用户活动（鼠标/键盘触发时调用）。
   * 用于连续工作时长统计和空闲检测。
   */
  markUserActivity(): void {
    const now = new Date()
    // 如果距离上次活动超过 30 分钟，认为是新的一段工作，重置起点
    if (now.getTime() - this.lastActivityAt.getTime() > 30 * 60 * 1000) {
      this.firstActivityAt = now
    }
    this.lastActivityAt = now
  }

  /** 清理超出时间窗口的事件 */
  private cleanup(): void {
    const cutoff = new Date(Date.now() - WINDOW_SIZE_MS)
    const before = this.events.length
    this.events = this.events.filter(e => new Date(e.timestamp) >= cutoff)
    if (this.events.length !== before) {
      log.debug('context cleanup', { removed: before - this.events.length, remaining: this.events.length })
    }
  }

  /** 调试用：获取所有事件 */
  getAllEvents(): ContextEvent[] {
    return [...this.events]
  }

  /** 调试用：清空所有事件 */
  clear(): void {
    this.events = []
    this.lastForegroundWindow = null
  }

  /** 销毁实例（仅测试用） */
  static resetInstance(): void {
    if (ContextManager.instance?.cleanupTimer) {
      clearInterval(ContextManager.instance.cleanupTimer)
    }
    ContextManager.instance = null
  }
}

/**
 * 获取 ContextManager 单例。
 * 由 ragAgent.ts 在构造 system prompt 时调用。
 */
export function getContextManager(): ContextManager {
  return ContextManager.getInstance()
}

// === 主动事件引擎 ===

/** 主动事件类型 — 小伴主动开口的场景 */
export type ProactiveEventType =
  | 'long_work'         // 连续工作超时
  | 'emotion_care'      // 情绪低落关怀
  | 'morning_greeting'  // 早晨问好
  | 'idle_back'         // 长时间空闲后回活动
  | 'reminder'          // 定时提醒
  | 'weather_hint'      // 天气提示
  | 'screen_anomaly'    // 屏幕异常介入

export interface ProactiveEvent {
  type: ProactiveEventType
  message: string       // 小伴要说的话
  priority: 'low' | 'medium' | 'high'
  /** 建议的语气：care / casual / serious */
  tone?: 'care' | 'casual' | 'serious'
  /** 触发时间戳 */
  triggered_at: string
}

/** 规则引擎配置 */
interface RuleState {
  lastLongWorkNotify: number       // 上次连续工作提醒时间戳
  lastEmotionCare: number          // 上次情绪关怀时间戳
  lastMorningGreeting: string | null  // 上次早晨问好的日期 YYYY-MM-DD
  lastIdleBackNotify: number       // 上次「回来」提醒时间戳
  lastResourceAlert: number        // 上次资源告警时间戳
  lastWeatherHint: number          // 上次天气提示时间戳
  lastScreenAnomaly: number        // 上次屏幕异常介入时间戳
  lastScreenAnomalyType: string | null  // 上次屏幕异常类型（避免同类型连续打扰）
}

const LONG_WORK_THRESHOLD_MIN = 120   // 连续工作 2 小时触发
const LONG_WORK_COOLDOWN_MS = 60 * 60 * 1000  // 1 小时内不重复提醒
const EMOTION_CARE_COOLDOWN_MS = 30 * 60 * 1000  // 30 分钟不重复
const IDLE_BACK_THRESHOLD_MS = 15 * 60 * 1000  // 15 分钟空闲后回活动
const RESOURCE_ALERT_COOLDOWN_MS = 15 * 60 * 1000  // 15 分钟不重复
const RESOURCE_CPU_THRESHOLD = 85     // CPU 占用阈值
const RESOURCE_MEM_THRESHOLD = 90     // 内存占用阈值
const WEATHER_HINT_COOLDOWN_MS = 3 * 60 * 60 * 1000  // 天气提示 3 小时一次
const SCREEN_ANOMALY_COOLDOWN_MS = 10 * 60 * 1000  // 屏幕异常介入 10 分钟不重复
const SCREEN_ANOMALY_CONFIDENCE_THRESHOLD = 0.5  // 低于此置信度不触发介入

/**
 * 主动事件规则引擎
 * 根据 ContextSnapshot + UserProfile 检查所有规则，返回待触发事件
 */
export class ProactiveEngine {
  private state: RuleState = {
    lastLongWorkNotify: 0,
    lastEmotionCare: 0,
    lastMorningGreeting: null,
    lastIdleBackNotify: 0,
    lastResourceAlert: 0,
    lastWeatherHint: 0,
    lastScreenAnomaly: 0,
    lastScreenAnomalyType: null,
  }
  private previousIdleState: boolean = false
  private lastEmotion: string | null = null
  private consecutiveNegativeEmotion: number = 0
  /** 缓存的负面情绪计数（由 server.ts 路由层异步更新） */
  public cachedNegativeEmotionCount: number = 0
  /** 缓存的天气信息（由 server.ts 路由层异步更新） */
  public cachedWeather: { description: string; tempC: number; condition: string; fetchedAt: number } | null = null
  /** 缓存的屏幕异常分析结果（由 server.ts 路由层异步更新） */
  public cachedScreenAnomaly: {
    scene: string
    anomaly: 'none' | 'error' | 'crash' | 'warning' | 'stuck'
    summary: string
    confidence: number
    fetchedAt: number
  } | null = null

  /**
   * 检查所有规则，返回应触发的主动事件列表
   * @param ctx ContextManager 实例
   * @param userProfile 用户画像（可选，用于个性化消息）
   * @param dndMode 勿扰模式（true 时只返回高优先级事件）
   */
  checkRules(
    ctx: ContextManager,
    userProfile: { getRecentEmotions: (hours?: number) => Promise<Array<{ emotion: string; intensity: number; timestamp: string }>> } | null,
    dndMode: boolean = false,
  ): ProactiveEvent[] {
    const events: ProactiveEvent[] = []
    const now = Date.now()
    const snapshot = ctx.getSnapshot()

    // 1. 长时间工作提醒
    if (
      !snapshot.activity.is_idle
      && snapshot.activity.continuous_work_minutes >= LONG_WORK_THRESHOLD_MIN
      && now - this.state.lastLongWorkNotify > LONG_WORK_COOLDOWN_MS
    ) {
      this.state.lastLongWorkNotify = now
      const hours = Math.floor(snapshot.activity.continuous_work_minutes / 60)
      const mins = snapshot.activity.continuous_work_minutes % 60
      events.push({
        type: 'long_work',
        message: `你连续工作 ${hours} 小时${mins > 0 ? ` ${mins} 分钟` : ''}了，站起来活动一下吧，眼睛也该休息了。`,
        priority: 'medium',
        tone: 'care',
        triggered_at: new Date().toISOString(),
      })
    }

    // 2. 情绪关怀（连续负面情绪 ≥ 3 次）
    // 注意：getRecentEmotions 是异步的，但 checkRules 是同步的
    // 这里用「上一次 check 时缓存的负面情绪计数」做近似判断
    // 真正的异步读取在 server.ts 路由层完成
    if (this.cachedNegativeEmotionCount >= 3 && now - this.state.lastEmotionCare > EMOTION_CARE_COOLDOWN_MS) {
      this.state.lastEmotionCare = now
      events.push({
        type: 'emotion_care',
        message: '感觉你最近有点累，要不要休息一下？或者告诉我哪里不顺心，我陪你聊两句。',
        priority: 'high',
        tone: 'care',
        triggered_at: new Date().toISOString(),
      })
    }

    // 3. 早晨问好（每天首次活动，且当天还没问过）
    const today = new Date().toISOString().slice(0, 10)
    const hour = new Date().getHours()
    if (
      !snapshot.activity.is_idle
      && snapshot.activity.continuous_work_minutes < 30
      && hour >= 6 && hour < 12
      && this.state.lastMorningGreeting !== today
    ) {
      this.state.lastMorningGreeting = today
      const greetings = [
        '早上好，新的一天开始了。',
        '早，今天感觉怎么样？',
        '早安，需要我帮你看看今天的安排吗？',
      ]
      events.push({
        type: 'morning_greeting',
        message: greetings[Math.floor(Math.random() * greetings.length)],
        priority: 'low',
        tone: 'casual',
        triggered_at: new Date().toISOString(),
      })
    }

    // 4. 空闲后回来
    if (this.previousIdleState && !snapshot.activity.is_idle) {
      const idleDuration = now - new Date(snapshot.activity.last_activity_at).getTime()
      if (
        idleDuration > IDLE_BACK_THRESHOLD_MS
        && now - this.state.lastIdleBackNotify > 30 * 60 * 1000
      ) {
        this.state.lastIdleBackNotify = now
        const minutes = Math.round(idleDuration / 60000)
        events.push({
          type: 'idle_back',
          message: `刚才去哪了 ${minutes} 分钟？欢迎回来。`,
          priority: 'low',
          tone: 'casual',
          triggered_at: new Date().toISOString(),
        })
      }
    }
    this.previousIdleState = snapshot.activity.is_idle

    // 5. 硬件资源告警 — 解析 hardware_summary 中的 CPU/内存数值
    if (
      snapshot.hardware_summary
      && now - this.state.lastResourceAlert > RESOURCE_ALERT_COOLDOWN_MS
    ) {
      const hw = parseHardwareSummary(snapshot.hardware_summary)
      if (hw) {
        if (hw.cpuPct >= RESOURCE_CPU_THRESHOLD || hw.memPct >= RESOURCE_MEM_THRESHOLD) {
          this.state.lastResourceAlert = now
          const parts: string[] = []
          if (hw.cpuPct >= RESOURCE_CPU_THRESHOLD) parts.push(`CPU ${hw.cpuPct}%`)
          if (hw.memPct >= RESOURCE_MEM_THRESHOLD) parts.push(`内存 ${hw.memPct}%`)
          events.push({
            type: 'long_work',
            message: `${parts.join(' / ')} 占用偏高，要看看是哪些程序在吃资源吗？`,
            priority: 'medium',
            tone: 'casual',
            triggered_at: new Date().toISOString(),
          })
        }
      }
    }

    // 6. 天气提示 — 早上下雨/极端天气
    if (
      this.cachedWeather
      && now - this.state.lastWeatherHint > WEATHER_HINT_COOLDOWN_MS
      && hour >= 6 && hour < 11
    ) {
      const w = this.cachedWeather
      const condition = w.condition.toLowerCase()
      const isBadWeather = /rain|storm|snow|thunder|雷|雨|雪|暴|风/.test(condition + w.description)
      if (isBadWeather) {
        this.state.lastWeatherHint = now
        events.push({
          type: 'weather_hint',
          message: `今天${w.description}，${w.tempC}°C，出门记得带伞。`,
          priority: 'low',
          tone: 'care',
          triggered_at: new Date().toISOString(),
        })
      } else if (w.tempC <= 5 || w.tempC >= 35) {
        this.state.lastWeatherHint = now
        const hint = w.tempC <= 5 ? '今天挺冷的，多穿点。' : '今天很热，多喝水。'
        events.push({
          type: 'weather_hint',
          message: `${hint}（${w.description}，${w.tempC}°C）`,
          priority: 'low',
          tone: 'care',
          triggered_at: new Date().toISOString(),
        })
      }
    }

    // 勿扰模式：只保留高优先级
    if (dndMode) {
      return events.filter(e => e.priority === 'high')
    }
    return events
  }

  /**
   * 屏幕异常介入规则 — 由 server.ts 在收到异常分析后主动调用
   * 与 checkRules 解耦：异常是异步事件，不应等待 60s 轮询
   * @returns 若触发则返回事件，否则返回 null
   */
  checkScreenAnomaly(): ProactiveEvent | null {
    if (!this.cachedScreenAnomaly) return null
    const a = this.cachedScreenAnomaly
    if (a.anomaly === 'none') return null
    if (a.confidence < SCREEN_ANOMALY_CONFIDENCE_THRESHOLD) return null
    const now = Date.now()
    if (now - this.state.lastScreenAnomaly < SCREEN_ANOMALY_COOLDOWN_MS) return null
    // 同类型异常 10 分钟内不重复
    if (this.state.lastScreenAnomalyType === a.anomaly
      && now - this.state.lastScreenAnomaly < SCREEN_ANOMALY_COOLDOWN_MS) return null

    this.state.lastScreenAnomaly = now
    this.state.lastScreenAnomalyType = a.anomaly

    let message: string
    let priority: 'low' | 'medium' | 'high'
    let tone: 'care' | 'casual' | 'serious'

    switch (a.anomaly) {
      case 'error':
        message = `我注意到屏幕上似乎出现了报错${a.summary ? `：${a.summary}` : ''}。需要我帮你看看吗？`
        priority = 'high'
        tone = 'care'
        break
      case 'crash':
        message = `看起来有程序崩溃了${a.summary ? `（${a.summary}）` : ''}。要我帮你查查原因吗？`
        priority = 'high'
        tone = 'serious'
        break
      case 'warning':
        message = `屏幕上有个确认提示${a.summary ? `：${a.summary}` : ''}。如果不确定，可以念给我听，我帮你判断。`
        priority = 'medium'
        tone = 'casual'
        break
      case 'stuck':
        message = `这个界面好像卡住了${a.summary ? `（${a.summary}）` : ''}。要不要我帮你看看？`
        priority = 'medium'
        tone = 'casual'
        break
      default:
        return null
    }

    return {
      type: 'screen_anomaly',
      message,
      priority,
      tone,
      triggered_at: new Date().toISOString(),
    }
  }

  /** 重置状态（测试用） */
  reset(): void {
    this.state = {
      lastLongWorkNotify: 0,
      lastEmotionCare: 0,
      lastMorningGreeting: null,
      lastIdleBackNotify: 0,
      lastResourceAlert: 0,
      lastWeatherHint: 0,
      lastScreenAnomaly: 0,
      lastScreenAnomalyType: null,
    }
    this.previousIdleState = false
    this.cachedNegativeEmotionCount = 0
    this.cachedWeather = null
    this.cachedScreenAnomaly = null
  }
}

/**
 * 从 hardware_summary 字符串中提取 CPU 和 内存 百分比。
 * 兼容多种格式："CPU 85% / 内存 92%" / "cpu:85.3 mem:91.7" 等。
 * 解析失败返回 null。
 */
function parseHardwareSummary(summary: string): { cpuPct: number; memPct: number } | null {
  try {
    const cpuMatch = summary.match(/cpu[^0-9-]*([0-9]+(?:\.[0-9]+)?)/i)
    const memMatch = summary.match(/(?:内存|mem|memory)[^0-9-]*([0-9]+(?:\.[0-9]+)?)/i)
    if (!cpuMatch && !memMatch) return null
    return {
      cpuPct: cpuMatch ? parseFloat(cpuMatch[1]) : 0,
      memPct: memMatch ? parseFloat(memMatch[1]) : 0,
    }
  } catch {
    return null
  }
}

// 单例
let proactiveEngine: ProactiveEngine | null = null
export function getProactiveEngine(): ProactiveEngine {
  if (!proactiveEngine) proactiveEngine = new ProactiveEngine()
  return proactiveEngine
}
