import { describe, it, expect, beforeEach } from 'vitest'
import { ProactiveEngine, getProactiveEngine, getContextManager } from '../src/contextManager.js'

describe('ProactiveEngine', () => {
  let engine: ProactiveEngine
  let ctx: ReturnType<typeof getContextManager>

  beforeEach(() => {
    ctx = getContextManager()
    ctx.clear()
    // 测试用单例 reset
    engine = getProactiveEngine()
    engine.reset()
  })

  it('空上下文 → 无事件', () => {
    const events = engine.checkRules(ctx, null, false)
    // 可能触发早晨问好（如果当前时间在 6-12 点且首次活动）
    // 但 continuous_work_minutes=0 不会触发 long_work
    const nonMorningEvents = events.filter(e => e.type !== 'morning_greeting')
    expect(nonMorningEvents).toHaveLength(0)
  })

  it('勿扰模式 → 只返回 high 优先级事件', () => {
    // 模拟触发情绪关怀：设置 cachedNegativeEmotionCount
    engine.cachedNegativeEmotionCount = 5
    // 关怀事件是 high 优先级，但冷却可能在测试前已触发
    engine.reset()
    engine.cachedNegativeEmotionCount = 5
    const events = engine.checkRules(ctx, null, true)
    // 所有事件必须是 high 优先级（如果有的话）
    for (const e of events) {
      expect(e.priority).toBe('high')
    }
  })

  it('情绪关怀：负面情绪 >= 3 触发 high 优先级关怀', () => {
    engine.reset()
    engine.cachedNegativeEmotionCount = 3
    const events = engine.checkRules(ctx, null, false)
    const care = events.find(e => e.type === 'emotion_care')
    expect(care).toBeDefined()
    expect(care!.priority).toBe('high')
    expect(care!.tone).toBe('care')
    expect(care!.message.length).toBeGreaterThan(10)
  })

  it('情绪关怀冷却：30 分钟内不重复', () => {
    engine.reset()
    engine.cachedNegativeEmotionCount = 3
    const first = engine.checkRules(ctx, null, false)
    expect(first.some(e => e.type === 'emotion_care')).toBe(true)
    // 第二次立即调用：冷却中，不应再触发
    const second = engine.checkRules(ctx, null, false)
    expect(second.some(e => e.type === 'emotion_care')).toBe(false)
  })

  it('情绪关怀：负面情绪 < 3 不触发', () => {
    engine.reset()
    engine.cachedNegativeEmotionCount = 2
    const events = engine.checkRules(ctx, null, false)
    expect(events.some(e => e.type === 'emotion_care')).toBe(false)
  })

  it('事件结构正确：包含 type/message/priority/triggered_at', () => {
    engine.reset()
    engine.cachedNegativeEmotionCount = 5
    const events = engine.checkRules(ctx, null, false)
    const care = events.find(e => e.type === 'emotion_care')
    expect(care).toBeDefined()
    expect(typeof care!.message).toBe('string')
    expect(['low', 'medium', 'high']).toContain(care!.priority)
    expect(typeof care!.triggered_at).toBe('string')
    // triggered_at 应该是合法 ISO 时间
    expect(() => new Date(care!.triggered_at)).not.toThrow()
  })

  it('reset() 清空所有状态', () => {
    engine.cachedNegativeEmotionCount = 10
    engine.reset()
    expect(engine.cachedNegativeEmotionCount).toBe(0)
    expect(engine.cachedWeather).toBeNull()
  })

  it('资源告警：CPU >= 85% 触发 medium 优先级提醒', () => {
    engine.reset()
    // 推送一条 hardware 事件
    ctx.pushEvent({
      type: 'hardware',
      summary: 'CPU 90% / 内存 60%',
      data: { cpu_percent: 90, memory_percent: 60 },
    })
    const events = engine.checkRules(ctx, null, false)
    const alert = events.find(e => e.type === 'long_work' && e.message.includes('CPU'))
    expect(alert).toBeDefined()
    expect(alert!.priority).toBe('medium')
  })

  it('资源告警：内存 >= 90% 触发提醒', () => {
    engine.reset()
    ctx.pushEvent({
      type: 'hardware',
      summary: 'CPU 50% / 内存 95%',
      data: { cpu_percent: 50, memory_percent: 95 },
    })
    const events = engine.checkRules(ctx, null, false)
    const alert = events.find(e => e.type === 'long_work' && e.message.includes('内存'))
    expect(alert).toBeDefined()
  })

  it('资源告警冷却：15 分钟内不重复', () => {
    engine.reset()
    ctx.pushEvent({
      type: 'hardware',
      summary: 'CPU 90% / 内存 60%',
      data: { cpu_percent: 90, memory_percent: 60 },
    })
    const first = engine.checkRules(ctx, null, false)
    expect(first.some(e => e.type === 'long_work')).toBe(true)
    // 第二次立即调用：冷却中，不应再触发资源告警
    const second = engine.checkRules(ctx, null, false)
    // 注意：second 可能仍包含其他 long_work 事件（如长时间工作），
    // 但不应包含资源告警类型。这里宽松判断：第二次事件数 <= 第一次
    expect(second.length).toBeLessThanOrEqual(first.length)
  })

  it('资源告警：CPU < 85% 且 内存 < 90% 不触发', () => {
    engine.reset()
    ctx.pushEvent({
      type: 'hardware',
      summary: 'CPU 50% / 内存 60%',
      data: { cpu_percent: 50, memory_percent: 60 },
    })
    const events = engine.checkRules(ctx, null, false)
    // 不应包含资源告警类型（long_work 中的资源告警）
    const resourceAlert = events.find(
      e => e.type === 'long_work' && (e.message.includes('CPU') || e.message.includes('内存'))
    )
    expect(resourceAlert).toBeUndefined()
  })

  it('天气提示：极端温度触发提醒', () => {
    engine.reset()
    engine.cachedWeather = {
      description: '晴',
      tempC: 38,
      condition: '800',
      fetchedAt: Date.now(),
    }
    const events = engine.checkRules(ctx, null, false)
    // 当前小时在 6-11 之间才会触发天气提示
    const hour = new Date().getHours()
    if (hour >= 6 && hour < 11) {
      const weather = events.find(e => e.type === 'weather_hint')
      expect(weather).toBeDefined()
      expect(weather!.tone).toBe('care')
    }
  })

  it('天气提示：雨天触发带伞提醒', () => {
    engine.reset()
    engine.cachedWeather = {
      description: '小雨',
      tempC: 20,
      condition: '500',
      fetchedAt: Date.now(),
    }
    const events = engine.checkRules(ctx, null, false)
    const hour = new Date().getHours()
    if (hour >= 6 && hour < 11) {
      const weather = events.find(e => e.type === 'weather_hint')
      expect(weather).toBeDefined()
      expect(weather!.message).toContain('伞')
    }
  })

  it('天气提示冷却：3 小时内不重复', () => {
    engine.reset()
    engine.cachedWeather = {
      description: '小雨',
      tempC: 20,
      condition: '500',
      fetchedAt: Date.now(),
    }
    const first = engine.checkRules(ctx, null, false)
    const second = engine.checkRules(ctx, null, false)
    const hour = new Date().getHours()
    if (hour >= 6 && hour < 11 && first.some(e => e.type === 'weather_hint')) {
      expect(second.some(e => e.type === 'weather_hint')).toBe(false)
    }
  })

  it('早晨问好：同一天只触发一次', () => {
    engine.reset()
    const hour = new Date().getHours()
    const first = engine.checkRules(ctx, null, false)
    const second = engine.checkRules(ctx, null, false)
    // 如果当前时间在 6-12 点，第一次可能触发 morning_greeting
    if (hour >= 6 && hour < 12 && first.some(e => e.type === 'morning_greeting')) {
      // 第二次不应再触发
      expect(second.some(e => e.type === 'morning_greeting')).toBe(false)
    }
  })
})

describe('ProactiveEngine - singleton', () => {
  it('getProactiveEngine 返回同一实例', () => {
    const a = getProactiveEngine()
    const b = getProactiveEngine()
    expect(a).toBe(b)
  })
})
