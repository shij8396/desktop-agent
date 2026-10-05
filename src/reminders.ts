import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { createLogger } from './logger.js'

const log = createLogger('reminders')

export interface Reminder {
  id: string
  time: string // ISO 8601 / 相对表达式
  message: string
  recurring: boolean
  created_at: string
  fired: boolean
  /** 计算后的目标时刻（ISO 8601），用于启动时重新调度 */
  target_at?: string
}

const REMINDERS_FILE = path.join(config.dataDir, 'reminders.json')
const reminders = new Map<string, Reminder>()
const reminderTimers = new Map<string, NodeJS.Timeout>()
let loaded = false
let loadLock: Promise<void> = Promise.resolve()

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  const next = loadLock.then(async () => {
    if (loaded) return
    try {
      const data = await fs.readFile(REMINDERS_FILE, 'utf-8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          if (r && typeof r.id === 'string' && typeof r.message === 'string') {
            reminders.set(r.id, r as Reminder)
          }
        }
      }
      log.info('reminders loaded', { count: reminders.size })
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        log.warn('failed to load reminders file', { error: String(error) })
      }
    }
    loaded = true
  })
  loadLock = next
  await next
}

async function persist(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(REMINDERS_FILE), { recursive: true })
    const arr = Array.from(reminders.values())
    await fs.writeFile(REMINDERS_FILE, JSON.stringify(arr, null, 2))
  } catch (error) {
    log.warn('failed to persist reminders', { error: String(error) })
  }
}

/**
 * 解析提醒时间字符串
 * 支持：ISO 8601、"in N minutes/hours"、"N 分钟后"、"N 小时后"
 */
export function parseReminderTime(time: string): Date | null {
  // ISO 8601
  const iso = new Date(time)
  if (!isNaN(iso.getTime())) return iso
  // "in 30 minutes" / "in 2 hours"
  const relMatch = time.match(/in\s+(\d+)\s*(minute|hour|day)/i)
  if (relMatch) {
    const n = parseInt(relMatch[1], 10)
    const unit = relMatch[2].toLowerCase()
    const ms = unit === 'minute' ? n * 60_000
      : unit === 'hour' ? n * 3600_000
      : n * 86_400_000
    return new Date(Date.now() + ms)
  }
  // "30 分钟后" / "2 小时后"
  const zhMatch = time.match(/(\d+)\s*(分钟|小时|天)后/)
  if (zhMatch) {
    const n = parseInt(zhMatch[1], 10)
    const unit = zhMatch[2]
    const ms = unit === '分钟' ? n * 60_000
      : unit === '小时' ? n * 3600_000
      : n * 86_400_000
    return new Date(Date.now() + ms)
  }
  return null
}

function clearTimer(id: string) {
  const t = reminderTimers.get(id)
  if (t) {
    clearTimeout(t)
    reminderTimers.delete(id)
  }
}

/**
 * 调度单次提醒的 setTimeout。
 * 触发时通过 ContextManager.pushEvent 推送事件。
 */
function scheduleOneTime(reminder: Reminder): void {
  const targetTime = parseReminderTime(reminder.time)
  if (!targetTime) {
    log.warn('cannot schedule reminder, time unparseable', { id: reminder.id, time: reminder.time })
    return
  }
  reminder.target_at = targetTime.toISOString()
  const delay = targetTime.getTime() - Date.now()
  if (delay <= 0) {
    // 已过期 — 立即触发
    fireReminder(reminder)
    return
  }
  const timer = setTimeout(() => fireReminder(reminder), delay)
  if (timer.unref) timer.unref()
  reminderTimers.set(reminder.id, timer)
  log.info('reminder scheduled', { id: reminder.id, delay_ms: delay, message: reminder.message })
}

async function fireReminder(reminder: Reminder): Promise<void> {
  try {
    const { getContextManager } = await import('./contextManager.js')
    getContextManager().pushEvent({
      type: 'user_activity',
      summary: `提醒：${reminder.message}`,
      data: { source: 'reminder', reminder_id: reminder.id, message: reminder.message },
    })
    reminder.fired = true
    await persist()
  } catch (error) {
    log.warn('failed to fire reminder', { id: reminder.id, error: String(error) })
  }
  reminderTimers.delete(reminder.id)
}

export async function addReminder(input: {
  time: string
  message: string
  recurring?: boolean
}): Promise<Reminder> {
  await ensureLoaded()
  const time = input.time.trim()
  const message = String(input.message).trim().slice(0, 300)
  if (!time) throw new Error('time is required')
  if (!message) throw new Error('message is required')
  const recurring = Boolean(input.recurring)

  const id = `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const reminder: Reminder = {
    id,
    time,
    message,
    recurring,
    created_at: new Date().toISOString(),
    fired: false,
  }
  reminders.set(id, reminder)

  if (!recurring) {
    scheduleOneTime(reminder)
  } else {
    // recurring 留待后续 cron 扩展；先持久化记录
    log.info('recurring reminder saved (scheduler pending)', { id })
  }
  await persist()
  return reminder
}

export async function listReminders(): Promise<Array<{ id: string; time: string; message: string; recurring: boolean; fired: boolean }>> {
  await ensureLoaded()
  return Array.from(reminders.values())
    .filter(r => !r.fired)
    .map(r => ({
      id: r.id,
      time: r.time,
      message: r.message,
      recurring: r.recurring,
      fired: r.fired,
    }))
}

export async function cancelReminder(id: string): Promise<boolean> {
  await ensureLoaded()
  if (!reminders.has(id)) return false
  clearTimer(id)
  reminders.delete(id)
  await persist()
  return true
}

/**
 * 在服务启动时调用：将未触发的 reminders 重新调度。
 * 已过期但未 fired 的（服务关闭期间错过了触发时间）— 立即补发一次。
 */
export async function rescheduleAllOnBoot(): Promise<void> {
  await ensureLoaded()
  let rescheduled = 0
  let firedLate = 0
  for (const r of reminders.values()) {
    if (r.fired) continue
    if (r.recurring) continue // 留待后续 cron
    const target = r.target_at ? new Date(r.target_at) : parseReminderTime(r.time)
    if (!target) continue
    if (target.getTime() <= Date.now()) {
      // 错过的 — 立即补发
      log.info('firing missed reminder', { id: r.id, target_at: r.target_at })
      await fireReminder(r)
      firedLate++
    } else {
      // 重新调度 setTimeout
      const timer = setTimeout(() => fireReminder(r), target.getTime() - Date.now())
      if (timer.unref) timer.unref()
      reminderTimers.set(r.id, timer)
      rescheduled++
    }
  }
  log.info('reminders rescheduled on boot', { rescheduled, firedLate, total: reminders.size })
}

/**
 * 删除已 fired 的一次性提醒（定期清理，避免文件无限增长）。
 * 保留最近 7 天的已 fired 记录用于审计/查询。
 */
export async function gcFiredReminders(): Promise<number> {
  await ensureLoaded()
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  let removed = 0
  for (const [id, r] of reminders.entries()) {
    if (r.fired && new Date(r.created_at).getTime() < cutoff) {
      reminders.delete(id)
      clearTimer(id)
      removed++
    }
  }
  if (removed > 0) await persist()
  return removed
}
