import { describe, it, expect } from 'vitest'
import { extractFollowUp, friendlyTime } from '../src/followUp.js'

// 以 2026-09-17 (周四) 10:00 为固定基准，保证断言稳定
const NOW = new Date(2026, 8, 17, 10, 0, 0) // 2026-09-17 周四

function at(hour: number, min = 0): Date {
  return new Date(2026, 8, 17, hour, min, 0, 0) // 2026-09-17
}

describe('extractFollowUp — 自动登记抽取', () => {
  it('时段+待办: 今天下午要交周报 → 今天 14:00', () => {
    const r = extractFollowUp('我下午要交周报', NOW)
    expect(r).not.toBeNull()
    expect(r!.fireAt.getTime()).toBe(at(14, 0).getTime())
    expect(r!.task).toBe('交周报')
    expect(r!.hint).toContain('今天 14:00')
  })

  it('日期+时段+待办: 明天早上记得发邮件 → 明天 09:00', () => {
    const r = extractFollowUp('明天早上记得发邮件', NOW)
    expect(r).not.toBeNull()
    expect(r!.fireAt.getTime()).toBe(new Date(2026, 8, 18, 9, 0).getTime())
    expect(r!.task).toBe('发邮件')
  })

  it('日期+几点+时段: 明天晚上8点开会 → 明天 20:00', () => {
    const r = extractFollowUp('明天晚上8点开会', NOW)
    expect(r).not.toBeNull()
    expect(r!.fireAt.getTime()).toBe(new Date(2026, 8, 18, 20, 0).getTime())
    expect(r!.task).toBe('开会')
  })

  it('下午+几点需 +12h: 下午3点交报告 → 今天 15:00', () => {
    const r = extractFollowUp('下午3点交报告', NOW)
    expect(r).not.toBeNull()
    expect(r!.fireAt.getTime()).toBe(at(15, 0).getTime())
    expect(r!.task).toBe('交报告')
  })

  it('周几+待办: 周五前把方案初稿交给我 → 周五 09:00', () => {
    const r = extractFollowUp('周五前把方案初稿交给我', NOW)
    expect(r).not.toBeNull()
    expect(r!.fireAt.getTime()).toBe(new Date(2026, 8, 18, 9, 0).getTime()) // 周四后第二天是周五
    expect(r!.task).toBe('方案初稿交给我')
  })

  it('相对时间: 3小时后提交报告 → now + 3h', () => {
    const r = extractFollowUp('3小时后提交报告', NOW)
    expect(r).not.toBeNull()
    expect(r!.fireAt.getTime()).toBe(new Date(2026, 8, 17, 13, 0).getTime())
    expect(r!.task).toBe('提交报告')
  })

  it('月底: 月底前交月报 → 本月底 18:00', () => {
    const r = extractFollowUp('月底前交月报', NOW)
    expect(r).not.toBeNull()
    expect(r!.fireAt.getTime()).toBe(new Date(2026, 8, 30, 18, 0).getTime())
    expect(r!.task).toBe('交月报')
  })

  it('明确提醒表达 → 跳过（交给 set_reminder）', () => {
    expect(extractFollowUp('提醒我明早7点叫我', NOW)).toBeNull()
    expect(extractFollowUp('明天记得叫我', NOW)).toBeNull()
    expect(extractFollowUp('帮我设个提醒，下午开会', NOW)).toBeNull()
  })

  it('无待办动作词 → 跳过', () => {
    expect(extractFollowUp('明天天气怎么样', NOW)).toBeNull()
    expect(extractFollowUp('今天心情不错', NOW)).toBeNull()
  })

  it('过去时间 → 跳过', () => {
    expect(extractFollowUp('昨天的报告写了吗', NOW)).toBeNull()
    expect(extractFollowUp('刚才的文件找到了', NOW)).toBeNull()
  })

  it('空/边界输入 → null', () => {
    expect(extractFollowUp('', NOW)).toBeNull()
    expect(extractFollowUp('   ', NOW)).toBeNull()
    expect(extractFollowUp('下午', NOW)).toBeNull() // 有时间无动作
  })
})

describe('friendlyTime — 友好时间格式化', () => {
  it('今天', () => {
    expect(friendlyTime(new Date(2026, 8, 17, 14, 0), NOW)).toBe('今天 14:00')
  })
  it('明天', () => {
    expect(friendlyTime(new Date(2026, 8, 18, 9, 0), NOW)).toBe('明天 09:00')
  })
  it('周X（3天后是周日）', () => {
    expect(friendlyTime(new Date(2026, 8, 20, 10, 0), NOW)).toBe('周日 10:00')
  })
  it('跨周用日期', () => {
    expect(friendlyTime(new Date(2026, 9, 1, 10, 0), NOW)).toBe('10月1日 10:00')
  })
})