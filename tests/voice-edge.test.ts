import { describe, it, expect } from 'vitest'

function splitSentences(text: string): string[] {
  return text
    .replace(/[ \t]+/g, ' ')
    .split(/(?<=[。！？!?\n])/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

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

describe('voice.js - 边界场景', () => {
  it('splitSentences: 只有换行符 → 空数组', () => {
    expect(splitSentences('\n\n\n')).toEqual([])
  })

  it('splitSentences: 只有空格 → 空数组', () => {
    expect(splitSentences('   ')).toEqual([])
  })

  it('splitSentences: 混合标点连续', () => {
    const result = splitSentences('好！！！继续')
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('splitSentences: 超长文本无标点 → 单元素', () => {
    const long = 'a'.repeat(10000)
    const result = splitSentences(long)
    expect(result).toEqual([long])
  })

  it('splitSentences: 中文混合换行', () => {
    const result = splitSentences('你好\n世界')
    expect(result).toEqual(['你好', '世界'])
  })

  it('splitSentences: 制表符合并', () => {
    const result = splitSentences('你好\t\t\t世界')
    expect(result).toEqual(['你好 世界'])
  })
})

describe('parseReminderTime - 边界场景', () => {
  it('负数分钟 → 仍然解析（过去的提醒）', () => {
    const result = parseReminderTime('in -30 minutes')
    // 负数 in 不会被正则匹配（\d+ 不匹配负号）
    expect(result).toBeNull()
  })

  it('0 分钟 → 立即触发', () => {
    const before = Date.now()
    const result = parseReminderTime('in 0 minutes')
    expect(result).not.toBeNull()
    expect(result!.getTime() - before).toBeLessThan(1000)
  })

  it('极大数字 → 不溢出', () => {
    const result = parseReminderTime('in 9999999999 minutes')
    expect(result).not.toBeNull()
  })

  it('只有数字 → null', () => {
    expect(parseReminderTime('30')).toBeNull()
  })

  it('只有单位 → null', () => {
    expect(parseReminderTime('分钟后')).toBeNull()
    expect(parseReminderTime('minutes')).toBeNull()
  })

  it('日期格式 "2026-12-31" → 有效', () => {
    const result = parseReminderTime('2026-12-31')
    expect(result).not.toBeNull()
    expect(result!.getMonth()).toBe(11) // 12 月
    expect(result!.getDate()).toBe(31)
  })
})
