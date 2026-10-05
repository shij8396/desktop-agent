/**
 * Time Expression Parser
 *
 * Resolves Chinese/English natural language time expressions into concrete
 * Date objects. Used when users say things like "帮我找昨天编辑的文件".
 *
 * All dates are in local time (not UTC).
 */

export interface TimeResolution {
  /** The resolved start date (inclusive) */
  start: Date
  /** The resolved end date (exclusive), or null for point-in-time */
  end: Date | null
  /** The matched expression text */
  matched: string
}

/** Set a date to 00:00:00.000 of the same day (local time). */
export function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * Set a date to Monday 00:00:00.000 of the same week.
 * Monday is treated as the start of the week (day 1).
 */
export function startOfWeek(date: Date): Date {
  const d = startOfDay(date)
  const day = d.getDay() // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  // Shift so Monday is the start: Sunday(0) -> 6 days back, otherwise (day-1) days back.
  const diff = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - diff)
  return d
}

/** Set a date to the first day of the month, 00:00:00.000. */
export function startOfMonth(date: Date): Date {
  const d = new Date(date)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d
}

/** Subtract N days from a date, returning a new Date. */
export function subDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() - days)
  return d
}

/** Subtract N hours from a date, returning a new Date. */
export function subHours(date: Date, hours: number): Date {
  const d = new Date(date)
  d.setHours(d.getHours() - hours)
  return d
}

interface PatternRule {
  /** Regex to match the time expression (English portions are case-insensitive). */
  regex: RegExp
  /** Resolver: given the match and now, return start/end. */
  resolve: (match: RegExpMatchArray, now: Date) => { start: Date; end: Date | null }
}

/**
 * Pattern rules. Order is intentional: more specific patterns are listed so
 * that at the same text position the longer match wins (handled in selection).
 */
const RULES: PatternRule[] = [
  // 今天上午 / this morning → today 00:00 to today 12:00
  {
    regex: /今天上午|this\s+morning/i,
    resolve: (_m, now) => {
      const s = startOfDay(now)
      const e = new Date(s)
      e.setHours(12, 0, 0, 0)
      return { start: s, end: e }
    },
  },
  // 今天下午 / this afternoon → today 12:00 to today 18:00
  {
    regex: /今天下午|this\s+afternoon/i,
    resolve: (_m, now) => {
      const s = startOfDay(now)
      s.setHours(12, 0, 0, 0)
      const e = new Date(s)
      e.setHours(18, 0, 0, 0)
      return { start: s, end: e }
    },
  },
  // 今天 / today → start of today to start of tomorrow
  {
    regex: /今天|today/i,
    resolve: (_m, now) => {
      const s = startOfDay(now)
      const e = new Date(s)
      e.setDate(e.getDate() + 1)
      return { start: s, end: e }
    },
  },
  // 昨天 / yesterday → start of yesterday to start of today
  {
    regex: /昨天|yesterday/i,
    resolve: (_m, now) => {
      const e = startOfDay(now)
      const s = subDays(e, 1)
      return { start: s, end: e }
    },
  },
  // 前天 → start of day-before-yesterday to start of yesterday
  {
    regex: /前天/,
    resolve: (_m, now) => {
      const today = startOfDay(now)
      return { start: subDays(today, 2), end: subDays(today, 1) }
    },
  },
  // N天前 (e.g. "3天前") → N days ago from now (point in time)
  {
    regex: /(\d+)\s*天前/,
    resolve: (m, now) => {
      const n = parseInt(m[1], 10)
      return { start: subDays(now, n), end: null }
    },
  },
  // 上周 / last week → start of last week (Monday) to start of this week
  {
    regex: /上周|last\s+week/i,
    resolve: (_m, now) => {
      const thisWeekStart = startOfWeek(now)
      return { start: subDays(thisWeekStart, 7), end: thisWeekStart }
    },
  },
  // 这周 / this week → start of this week (Monday) to now
  {
    regex: /这周|本周|this\s+week/i,
    resolve: (_m, now) => ({ start: startOfWeek(now), end: new Date(now) }),
  },
  // 刚才 / 刚刚 → 1 hour ago to now
  {
    regex: /刚才|刚刚/,
    resolve: (_m, now) => ({ start: subHours(now, 1), end: new Date(now) }),
  },
  // N月N日 (e.g. "7月14日") → that day start to next day start
  {
    regex: /(\d{1,2})月(\d{1,2})日/,
    resolve: (m, now) => {
      const month = parseInt(m[1], 10)
      const day = parseInt(m[2], 10)
      const year = now.getFullYear()
      const s = new Date(year, month - 1, day, 0, 0, 0, 0)
      const e = new Date(year, month - 1, day, 0, 0, 0, 0)
      e.setDate(e.getDate() + 1)
      return { start: s, end: e }
    },
  },
  // 今年 → start of this year to now
  {
    regex: /今年/,
    resolve: (_m, now) => ({
      start: new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0),
      end: new Date(now),
    }),
  },
  // 上个月 / last month → start of last month to start of this month
  {
    regex: /上个月|上月|last\s+month/i,
    resolve: (_m, now) => {
      const thisMonthStart = startOfMonth(now)
      const lastMonthStart = new Date(thisMonthStart)
      lastMonthStart.setMonth(lastMonthStart.getMonth() - 1)
      return { start: lastMonthStart, end: thisMonthStart }
    },
  },
  // 这个月 / this month → start of this month to now
  {
    regex: /这个月|本月|this\s+month/i,
    resolve: (_m, now) => ({ start: startOfMonth(now), end: new Date(now) }),
  },
]

/**
 * Resolve a Chinese/English time expression to a Date range or point.
 * Returns null if no time expression is found.
 *
 * Scans the input text and selects the earliest matching pattern; when
 * multiple patterns match at the same position, the longest (most specific)
 * match wins — so "今天上午" is preferred over "今天".
 */
export function resolveTimeExpression(
  text: string,
  now: Date = new Date(),
): TimeResolution | null {
  if (!text) return null

  let best: { index: number; length: number; resolution: TimeResolution } | null = null

  for (const rule of RULES) {
    const m = text.match(rule.regex)
    if (!m) continue
    const index = m.index ?? 0
    const matched = m[0]
    const { start, end } = rule.resolve(m, now)
    const candidate = { index, length: matched.length, resolution: { start, end, matched } }
    if (
      !best ||
      candidate.index < best.index ||
      (candidate.index === best.index && candidate.length > best.length)
    ) {
      best = candidate
    }
  }

  return best ? best.resolution : null
}
