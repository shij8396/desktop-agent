import { describe, it, expect } from 'vitest'
import {
  resolveTimeExpression,
  startOfDay,
  startOfWeek,
  subDays,
  subHours,
} from '../src/timeParser.js'

// Fixed "now" so assertions are deterministic and timezone-independent.
const NOW = new Date('2026-07-15T10:00:00')

describe('resolveTimeExpression', () => {
  it('matches 昨天 in a sentence', () => {
    const res = resolveTimeExpression('帮我找昨天编辑的文件', NOW)
    expect(res).not.toBeNull()
    expect(res!.matched).toBe('昨天')
    expect(res!.start.getTime()).toBe(subDays(startOfDay(NOW), 1).getTime())
    expect(res!.end!.getTime()).toBe(startOfDay(NOW).getTime())
  })

  it('matches N天前', () => {
    const res = resolveTimeExpression('3天前的文件', NOW)
    expect(res).not.toBeNull()
    expect(res!.matched).toBe('3天前')
    expect(res!.start.getTime()).toBe(subDays(NOW, 3).getTime())
    expect(res!.end).toBeNull()
  })

  it('matches 今天上午', () => {
    const res = resolveTimeExpression('今天上午的文档', NOW)
    expect(res).not.toBeNull()
    expect(res!.matched).toBe('今天上午')
    const morningStart = startOfDay(NOW)
    const morningEnd = new Date(morningStart)
    morningEnd.setHours(12, 0, 0, 0)
    expect(res!.start.getTime()).toBe(morningStart.getTime())
    expect(res!.end!.getTime()).toBe(morningEnd.getTime())
  })

  it('matches 上周', () => {
    const res = resolveTimeExpression('上周的报告', NOW)
    expect(res).not.toBeNull()
    expect(res!.matched).toBe('上周')
    const thisWeekStart = startOfWeek(NOW)
    expect(res!.start.getTime()).toBe(subDays(thisWeekStart, 7).getTime())
    expect(res!.end!.getTime()).toBe(thisWeekStart.getTime())
  })

  it('matches N月N日', () => {
    const res = resolveTimeExpression('7月14日的会议纪要', NOW)
    expect(res).not.toBeNull()
    expect(res!.matched).toBe('7月14日')
    const expectedStart = new Date(2026, 6, 14, 0, 0, 0, 0) // July = month index 6
    const expectedEnd = new Date(2026, 6, 15, 0, 0, 0, 0)
    expect(res!.start.getTime()).toBe(expectedStart.getTime())
    expect(res!.end!.getTime()).toBe(expectedEnd.getTime())
  })

  it('returns null when no time expression is present', () => {
    const res = resolveTimeExpression('没有时间表达的句子', NOW)
    expect(res).toBeNull()
  })

  it('matches 刚才', () => {
    const res = resolveTimeExpression('刚才编辑的', NOW)
    expect(res).not.toBeNull()
    expect(res!.matched).toBe('刚才')
    expect(res!.start.getTime()).toBe(subHours(NOW, 1).getTime())
    expect(res!.end!.getTime()).toBe(NOW.getTime())
  })

  it('matches 这周', () => {
    const res = resolveTimeExpression('这周新建的', NOW)
    expect(res).not.toBeNull()
    expect(res!.matched).toBe('这周')
    expect(res!.start.getTime()).toBe(startOfWeek(NOW).getTime())
    expect(res!.end!.getTime()).toBe(NOW.getTime())
  })
})
