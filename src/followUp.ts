/**
 * followUp — 上下文驱动提醒（路线一）
 *
 * 对话结束后，从用户本轮发言中自动抽取「可跟进事项」（未来时间 + 待办动作），
 * 登记为一次性提醒，并在回答末尾提示用户。
 *
 * 保守规则设计：
 * - 必须同时出现「未来时间词」和「待办/动作词」才登记
 * - 出现明确提醒表达（提醒我/叫我/闹钟等）时跳过——这些已由 set_reminder 工具覆盖
 * - 过去时间（昨天/刚才）天然不在未来时间词表中，不会误登记
 * - 纯规则实现（正则+时间计算），无 LLM 调用，便宜可控
 */

import { addReminder, listReminders } from './reminders.js'
import { createLogger } from './logger.js'

const log = createLogger('follow-up')

export interface FollowUpCandidate {
  /** 目标触发时刻 */
  fireAt: Date
  /** 命中的原始时间短语 */
  timeExpr: string
  /** 清理后的待办描述 */
  task: string
  /** 追加到回答末尾的提示行（纯文本，不含 markdown 符号） */
  hint: string
}

/** 明确要求设提醒的表达 — 由 set_reminder 工具处理，自动登记应跳过避免重复 */
const EXPLICIT_REMINDER_RE =
  /提醒|闹钟|定时|叫我|唤醒我|喊我|提醒我|remind|wake me|alert me|set.*alarm/i

/** 待办/动作意图词 — 与未来时间词同时出现才自动登记 */
const ACTION_WORDS_RE =
  /交|提交|汇报|发|完成|写|做|整理|回复|回信|联系|打电话|发消息|买|取|寄|约|开会|会议|面试|考试|上课|加班|体检|缴费|付款|报销|改|修|帮|检查|看|读|学|背|录|传|上传|下载|注册|报名|预约|出差|去|见|弄|处理|搞定|清理|删|打印|打印报告|缴费/

/**
 * 未来时间词 → 相对天数偏移（相对于今天）。
 * 周 X / 下 X / 月份等需要动态计算，单独处理。
 */
interface TimeRule {
  kind: 'day' | 'weekday' | 'monthDay' | 'monthEnd' | 'weekend' | 'clock' | 'period' | 'relative'
  regex: RegExp
  /** 计算基准日期（当天 00:00）与默认时段。kind=relative 直接返回 fireAt。 */
  compute: (m: RegExpMatchArray, now: Date) => {
    days: number
    hour: number | null
    min: number | null
    /** 命中周几类规则且结果为「今天但时间已过」时，下一次跳到下周几 */
    weekCycle?: boolean
    /** 相对时间（分钟/小时/天后）直接算好的触发时刻 */
    fireAt?: Date
    /** 相对时间原表达式，直接透传给 addReminder */
    relativeExpr?: string
  }
}

const WEEKDAY_ZH: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }

/** 时段 → 默认小时（没有显式几点时使用） */
const PERIOD_HOUR: Record<string, number> = {
  凌晨: 6, 早上: 9, 早晨: 9, 上午: 9, 中午: 12,
  下午: 14, 傍晚: 17, 晚上: 19, 夜里: 19, 夜间: 19,
}

const TIME_RULES: TimeRule[] = [
  // 相对时间：N 分钟后 / N 小时后 / N 天后 / in N minutes...
  {
    kind: 'relative',
    regex: /(\d+)\s*(分钟|小时|天)\s*后|in\s+(\d+)\s*(minute|hour|day)/i,
    compute: (m, now) => {
      if (m[2]) {
        const n = parseInt(m[1], 10)
        const unit = m[2]
        const ms = unit === '分钟' ? n * 60_000 : unit === '小时' ? n * 3600_000 : n * 86_400_000
        return { days: 0, hour: null, min: null, fireAt: new Date(now.getTime() + ms), relativeExpr: m[0] }
      }
      const n = parseInt(m[3], 10)
      const unit = (m[4] || '').toLowerCase()
      const ms = unit === 'minute' ? n * 60_000 : unit === 'hour' ? n * 3600_000 : n * 86_400_000
      return { days: 0, hour: null, min: null, fireAt: new Date(now.getTime() + ms), relativeExpr: m[0] }
    },
  },
  // 大后天 / 后天 / 明天 / 今晚 / 明晚 / 今天
  {
    kind: 'day',
    regex: /大后天|后天|明天|明晚|今晚|今天/,
    compute: (m, _now) => {
      const t = m[0]
      if (t === '大后天') return { days: 3, hour: null, min: null }
      if (t === '后天') return { days: 2, hour: null, min: null }
      if (t === '明天') return { days: 1, hour: null, min: null }
      if (t === '明晚') return { days: 1, hour: 19, min: null }
      if (t === '今晚') return { days: 0, hour: 19, min: null }
      return { days: 0, hour: null, min: null } // 今天
    },
  },
  // 下周一 / 周三 / 星期六 / 礼拜天 / 本周三
  {
    kind: 'weekday',
    regex: /(下|本)?(?:周|星期|礼拜)([一二三四五六日天])/,
    compute: (m, now) => {
      const next = m[1] === '下'
      const wd = WEEKDAY_ZH[m[2]]
      const dow = now.getDay()
      let days = (wd - dow + 7) % 7
      // "下周X"且命中今天同一天 → 跳一周；普通"周X"命中今天 → 按今天算（已过则后续顺延一周）
      if (next && days === 0) days = 7
      return { days, hour: null, min: null, weekCycle: true }
    },
  },
  // 周末
  {
    kind: 'weekend',
    regex: /周末/,
    compute: (_m, now) => {
      let days = (6 - now.getDay() + 7) % 7 // 周六
      if (days === 0) days = 7
      return { days, hour: null, min: null, weekCycle: true }
    },
  },
  // N月N日
  {
    kind: 'monthDay',
    regex: /(\d{1,2})月(\d{1,2})[日号]/,
    compute: (m, now) => {
      const month = parseInt(m[1], 10) - 1
      const day = parseInt(m[2], 10)
      let d = new Date(now.getFullYear(), month, day, 0, 0, 0, 0)
      if (d.getTime() < now.getTime()) d = new Date(now.getFullYear() + 1, month, day, 0, 0, 0, 0)
      void d
      // 直接返回目标日期（relative 方式）
      const target = new Date(now.getFullYear(), month, day, 9, 0, 0, 0)
      if (target.getTime() <= now.getTime()) {
        target.setFullYear(now.getFullYear() + 1)
      }
      return { days: 0, hour: null, min: null, fireAt: target, relativeExpr: m[0] }
    },
  },
  // 月底 / 月末
  {
    kind: 'monthEnd',
    regex: /月底|月末/,
    compute: (_m, now) => {
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0, 18, 0, 0, 0)
      if (last.getTime() <= now.getTime()) last.setMonth(last.getMonth() + 1) // 已过 → 下月月底
      return { days: 0, hour: null, min: null, fireAt: last, relativeExpr: '月底' }
    },
  },
  // 显式几点：15:30 / 3点半 / 2点 / 5点20分
  {
    kind: 'clock',
    regex: /(\d{1,2})[点时](?:(\d{1,2})分?|半)?|(\d{1,2}):(\d{2})/,
    compute: (m, _now) => {
      let hour: number
      let min: number
      if (m[1]) {
        hour = parseInt(m[1], 10)
        min = m[2] == null ? (m[0].includes('半') ? 30 : 0) : parseInt(m[2], 10)
      } else {
        hour = parseInt(m[3], 10)
        min = parseInt(m[4], 10)
      }
      if (Number.isNaN(hour) || hour > 23) hour = 0
      if (Number.isNaN(min) || min > 59) min = 0
      return { days: 0, hour, min: min === 0 ? 0 : min }
    },
  },
  // 时段：凌晨 / 早上 / 上午 / 中午 / 下午 / 傍晚 / 晚上 / 夜里（今晚/明晚已在 day 规则）
  {
    kind: 'period',
    regex: /凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间/,
    compute: (_m, _now) => {
      // 具体时刻在组合阶段用"时段+几点"合并决定，这里留空
      return { days: 0, hour: null, min: null }
    },
  },
]

function startOfDay(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d)
  c.setDate(c.getDate() + n)
  return c
}

/**
 * 从用户发言中抽取可跟进提醒。
 * 规则：未来时间词 + 待办动作词，且非明确"提醒我"表达。
 */
export function extractFollowUp(question: string, now: Date = new Date()): FollowUpCandidate | null {
  if (!question) return null
  if (EXPLICIT_REMINDER_RE.test(question)) return null
  if (!ACTION_WORDS_RE.test(question)) return null

  // 命中所有时间规则，选择最早出现（同位置取最长）
  let bestIndex = -1
  let bestLen = 0
  let bestRule: TimeRule | null = null
  let bestMatch: RegExpMatchArray | null = null
  for (const rule of TIME_RULES) {
    const m = question.match(rule.regex)
    if (!m) continue
    const idx = m.index ?? 0
    if (bestRule == null || idx < bestIndex || (idx === bestIndex && m[0].length > bestLen)) {
      bestIndex = idx
      bestLen = m[0].length
      bestRule = rule
      bestMatch = m
    }
  }
  if (!bestRule || !bestMatch) return null

  const computed = bestRule.compute(bestMatch, now)
  const timeExpr = bestMatch[0]

  // 相对时间 / 绝对日期类：直接使用计算好的触发时刻
  let fireAt: Date | null = computed.fireAt ?? null
  if (fireAt) {
    // 兜底：不应早于当前时刻
    if (fireAt.getTime() <= now.getTime() && bestRule.kind === 'monthEnd') {
      fireAt = addDays(fireAt, 1)
    }
  } else {
    // 组合天数 + 时段/几点：时段与显式几点可出现在时间词前后，统一合并
    let hour = computed.hour // day 规则可能直接给出（今晚/明晚 → 19）
    let min = computed.min ?? 0
    let days = computed.days
    const periodM = question.match(/凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间|今晚|明晚/)
    const clockM = question.match(/(\d{1,2})[点时](?:(\d{1,2})分?|半)?|(\d{1,2}):(\d{2})/)

    if (clockM) {
      hour = clockM[1] ? parseInt(clockM[1], 10) : parseInt(clockM[3], 10)
      min = clockM[1]
        ? (clockM[2] == null ? (clockM[0].includes('半') ? 30 : 0) : parseInt(clockM[2], 10))
        : parseInt(clockM[4], 10)
      if (Number.isNaN(hour) || hour > 23) hour = 9
      if (Number.isNaN(min) || min > 59) min = 0
      // 下午/晚间时段 + 小时 < 12 → 加 12 小时（下午3点=15点，晚上8点=20点）
      if (periodM && hour < 12 && /下午|傍晚|晚上|夜里|夜间|今晚|明晚/.test(periodM[0])) hour += 12
      if (periodM && periodM[0] === '明晚') days = 1
    } else if (periodM) {
      const p = periodM[0]
      hour = p === '今晚' || p === '明晚' ? 19 : (PERIOD_HOUR[p] ?? 19)
      if (p === '明晚') days = 1
      if (p === '今晚') days = 0
    } else if (hour == null) {
      // 只有日期没有时刻：今天 → 19:00（已过则明天 09:00）；未来天 → 09:00
      hour = days === 0 ? (now.getHours() < 18 ? 19 : 9) : 9
      if (days === 0 && now.getHours() >= 18) days = 1
    }
    const base = startOfDay(now)
    const date = addDays(base, days)
    fireAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, min)
    // 已过 → 顺延（周几类跳一周，其余跳一天）
    if (fireAt.getTime() <= now.getTime()) {
      const skip = computed.weekCycle ? 7 : 1
      const again = addDays(base, days + skip)
      fireAt = new Date(again.getFullYear(), again.getMonth(), again.getDate(), hour, min)
    }
  }

  // 抽取待办：取时间词之后的片段，循环清理时间残留/语气词/介词
  const noiseRe = /^(?:之前|以前|前|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|夜间|凌晨|今晚|明晚|今天|明天|后天|大后天|要|去|得|需要|记得|别忘了|帮我|给我|把|会|应该|准备|打算|想|然后|再|还|顺便|接下来|我们|我|有|给)/
  const cleanTask = (raw: string): string => {
    let t = raw.trim()
    let changed = true
    while (changed && t) {
      const before = t
      t = t.replace(noiseRe, '').replace(/^\d{1,2}\s*(?:[点时][分半]?|:\d{2})/, '')
      changed = t !== before
    }
    return t.replace(/\s+/g, ' ').replace(/[，。！？、；;：:,.!?]+$/, '').trim()
  }
  let task = cleanTask(question.slice(bestIndex + timeExpr.length))
  if (task.length < 1) {
    // 时间词在句尾或句中，退回整句减去时间词
    task = cleanTask(question.replace(timeExpr, ''))
  }
  if (task.length < 1) return null

  const hint = `\n（已帮你记下：${friendlyTime(fireAt, now)} ${task}）`
  return { fireAt, timeExpr, task, hint }
}

/** 将触发时刻格式化为友好中文时间（相对今天） */
export function friendlyTime(d: Date, now: Date = new Date()): string {
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const diff = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000)
  if (diff === 0) return `今天 ${hm}`
  if (diff === 1) return `明天 ${hm}`
  if (diff > 1 && diff < 7) return `周${'日一二三四五六'[d.getDay()]} ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

export interface FollowUpResult {
  registered: boolean
  hint?: string
  time?: string
  message?: string
}

/**
 * 自动登记可跟进提醒（对话收尾调用）。
 * 轻量去重：同任务且目标时刻接近的未触发提醒已存在时跳过。
 */
export async function maybeRegisterFollowUp(
  question: string,
  now: Date = new Date(),
): Promise<FollowUpResult> {
  const candidate = extractFollowUp(question, now)
  if (!candidate) return { registered: false }

  try {
    // 去重：已存在未触发的同任务、目标时刻 30 分钟内 → 跳过
    const existing = await listReminders()
    const dup = existing.find((r) => {
      const t = new Date(r.time).getTime()
      if (Number.isNaN(t)) return false
      return r.message === candidate.task && Math.abs(t - candidate.fireAt.getTime()) < 30 * 60 * 1000
    })
    if (dup) return { registered: false }

    await addReminder({
      time: candidate.fireAt.toISOString(),
      message: candidate.task,
    })
    log.info('auto-registered follow-up reminder', {
      fireAt: candidate.fireAt.toISOString(),
      task: candidate.task,
    })
    return {
      registered: true,
      hint: candidate.hint,
      time: candidate.fireAt.toISOString(),
      message: candidate.task,
    }
  } catch (error) {
    log.warn('auto-register follow-up failed', { error: String(error) })
    return { registered: false }
  }
}
