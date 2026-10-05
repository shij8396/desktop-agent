import { describe, it, expect } from 'vitest'

/**
 * voice.js 是 IIFE 挂载到 window 的模块，无法直接 import 测试。
 * 这里抽取关键纯函数的逻辑做等价测试，确保 voice.js 中的实现与之一致。
 * 维护时需同步更新 voice.js 中的对应函数。
 */

// === 复刻 voice.js 中的 splitSentences ===
function splitSentences(text: string): string[] {
  return text
    .replace(/[ \t]+/g, ' ')  // 仅合并空格和制表符，保留换行
    .split(/(?<=[。！？!?\n])/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

// === 复刻 voice.js 中的 toneToPitch ===
function toneToPitch(tone: string): number {
  if (tone === 'male-low') return 0.75
  if (tone === 'male-warm') return 1.0
  if (tone === 'female-calm') return 1.08
  return 1.0
}

// === 复刻 voice.js 中的 detectLang ===
function detectLang(text: string): string {
  if (!text) return 'zh-CN'
  return /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US'
}

// === 复刻 tools.ts 中的 parseReminderTime ===
function parseReminderTime(time: string): Date | null {
  const iso = new Date(time)
  if (!isNaN(iso.getTime())) return iso
  const relMatch = time.match(/in\s+(\d+)\s*(minute|hour|day)/i)
  if (relMatch) {
    const n = parseInt(relMatch[1], 10)
    const unit = relMatch[2].toLowerCase()
    const ms = unit === 'minute' ? n * 60_000
      : unit === 'hour' ? n * 3600_000
      : n * 86_400_000
    return new Date(Date.now() + ms)
  }
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

describe('voice.js - splitSentences', () => {
  it('空字符串 → 空数组', () => {
    expect(splitSentences('')).toEqual([])
  })

  it('单句无标点 → 单元素', () => {
    expect(splitSentences('你好')).toEqual(['你好'])
  })

  it('中文句号切分', () => {
    const result = splitSentences('你好。世界。')
    expect(result).toEqual(['你好。', '世界。'])
  })

  it('感叹号切分', () => {
    const result = splitSentences('太棒了！继续！')
    expect(result).toEqual(['太棒了！', '继续！'])
  })

  it('问号切分', () => {
    const result = splitSentences('你好吗？我很好。')
    expect(result).toEqual(['你好吗？', '我很好。'])
  })

  it('英文标点切分', () => {
    const result = splitSentences('Hello! How are you?')
    expect(result).toEqual(['Hello!', 'How are you?'])
  })

  it('换行切分', () => {
    const result = splitSentences('第一行\n第二行')
    expect(result).toEqual(['第一行', '第二行'])
  })

  it('多个空格合并', () => {
    const result = splitSentences('你好    世界')
    expect(result).toEqual(['你好 世界'])
  })

  it('混合中英标点', () => {
    const result = splitSentences('你好!世界?ok.')
    expect(result.length).toBeGreaterThan(1)
  })
})

describe('voice.js - toneToPitch', () => {
  it('male-low → 0.75', () => {
    expect(toneToPitch('male-low')).toBe(0.75)
  })

  it('male-warm → 1.0', () => {
    expect(toneToPitch('male-warm')).toBe(1.0)
  })

  it('female-calm → 1.08', () => {
    expect(toneToPitch('female-calm')).toBe(1.08)
  })

  it('未知 → 1.0（默认）', () => {
    expect(toneToPitch('unknown')).toBe(1.0)
    expect(toneToPitch('')).toBe(1.0)
  })
})

describe('voice.js - detectLang', () => {
  it('空字符串 → zh-CN（默认）', () => {
    expect(detectLang('')).toBe('zh-CN')
  })

  it('中文字符 → zh-CN', () => {
    expect(detectLang('你好')).toBe('zh-CN')
    expect(detectLang('hello 你好')).toBe('zh-CN')
  })

  it('纯英文 → en-US', () => {
    expect(detectLang('hello world')).toBe('en-US')
  })
})

describe('tools.ts - parseReminderTime', () => {
  it('ISO 8601 直接解析', () => {
    const result = parseReminderTime('2026-12-31T23:59:59')
    expect(result).not.toBeNull()
    expect(result!.getFullYear()).toBe(2026)
  })

  it('英文 "in N minutes"', () => {
    const before = Date.now()
    const result = parseReminderTime('in 30 minutes')
    expect(result).not.toBeNull()
    const elapsed = result!.getTime() - before
    expect(elapsed).toBeGreaterThanOrEqual(29 * 60_000)
    expect(elapsed).toBeLessThanOrEqual(31 * 60_000)
  })

  it('英文 "in N hours"', () => {
    const before = Date.now()
    const result = parseReminderTime('in 2 hours')
    expect(result).not.toBeNull()
    const elapsed = result!.getTime() - before
    expect(elapsed).toBeGreaterThanOrEqual(2 * 3600_000 - 1000)
    expect(elapsed).toBeLessThanOrEqual(2 * 3600_000 + 1000)
  })

  it('英文 "in N days"', () => {
    const before = Date.now()
    const result = parseReminderTime('in 1 day')
    expect(result).not.toBeNull()
    const elapsed = result!.getTime() - before
    expect(elapsed).toBeGreaterThanOrEqual(86_400_000 - 1000)
    expect(elapsed).toBeLessThanOrEqual(86_400_000 + 1000)
  })

  it('中文 "N 分钟后"', () => {
    const before = Date.now()
    const result = parseReminderTime('30 分钟后')
    expect(result).not.toBeNull()
    const elapsed = result!.getTime() - before
    expect(elapsed).toBeGreaterThanOrEqual(29 * 60_000)
    expect(elapsed).toBeLessThanOrEqual(31 * 60_000)
  })

  it('中文 "N 小时后"', () => {
    const before = Date.now()
    const result = parseReminderTime('2 小时后')
    expect(result).not.toBeNull()
    const elapsed = result!.getTime() - before
    expect(elapsed).toBeGreaterThanOrEqual(2 * 3600_000 - 1000)
    expect(elapsed).toBeLessThanOrEqual(2 * 3600_000 + 1000)
  })

  it('中文 "N 天后"', () => {
    const before = Date.now()
    const result = parseReminderTime('3 天后')
    expect(result).not.toBeNull()
    const elapsed = result!.getTime() - before
    expect(elapsed).toBeGreaterThanOrEqual(3 * 86_400_000 - 1000)
    expect(elapsed).toBeLessThanOrEqual(3 * 86_400_000 + 1000)
  })

  it('无法解析 → null', () => {
    expect(parseReminderTime('invalid')).toBeNull()
    expect(parseReminderTime('')).toBeNull()
    expect(parseReminderTime('next week')).toBeNull()
  })
})
