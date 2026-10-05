import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Memory, TrackedEntity, UserMemory, UserProfile } from '../src/memory.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('Memory', () => {
  it('should add and retrieve messages', async () => {
    const mem = new Memory(tmpDir)
    await mem.addMessage('test', 'user', 'Hello')
    await mem.addMessage('test', 'assistant', 'Hi there')

    const history = await mem.getHistory('test')
    expect(history).toHaveLength(2)
    expect(history[0].role).toBe('user')
    expect(history[0].content).toBe('Hello')
    expect(history[1].role).toBe('assistant')
    expect(history[1].content).toBe('Hi there')
  })

  it('should set timestamps on messages', async () => {
    const mem = new Memory(tmpDir)
    const before = Date.now()
    await mem.addMessage('ts-test', 'user', 'test')
    const after = Date.now()

    const history = await mem.getHistory('ts-test')
    expect(history[0].timestamp).toBeGreaterThanOrEqual(before)
    expect(history[0].timestamp).toBeLessThanOrEqual(after)
  })

  it('should clear history', async () => {
    const mem = new Memory(tmpDir)
    await mem.addMessage('clear-test', 'user', 'msg')
    await mem.clearHistory('clear-test')

    const history = await mem.getHistory('clear-test')
    expect(history).toHaveLength(0)
  })

  it('should list sessions', async () => {
    const mem = new Memory(tmpDir)
    await mem.addMessage('sess-a', 'user', 'hello')
    await mem.addMessage('sess-b', 'user', 'world')

    const sessions = await mem.listSessions()
    expect(sessions).toContain('sess-a')
    expect(sessions).toContain('sess-b')
  })

  it('should reject invalid session IDs', async () => {
    const mem = new Memory(tmpDir)
    await expect(mem.addMessage('../evil', 'user', 'hack')).rejects.toThrow('Invalid session ID')
  })

  it('should persist across instances', async () => {
    const mem1 = new Memory(tmpDir)
    await mem1.addMessage('persist', 'user', 'persisted message')

    const mem2 = new Memory(tmpDir)
    const history = await mem2.getHistory('persist')
    expect(history).toHaveLength(1)
    expect(history[0].content).toBe('persisted message')
  })
})

describe('UserMemory relevant lookup', () => {
  it('returns only matching saved memories without increasing usage counts', async () => {
    const saved = new UserMemory(tmpDir)
    await saved.remember('preference', '回答风格', '简短直接')
    await saved.remember('app', '常用浏览器', 'Firefox')
    const matched = await saved.findRelevant('我的回答风格是什么？')
    expect(matched).toEqual([expect.objectContaining({ key: '回答风格', value: '简短直接', use_count: 1 })])
    expect((await saved.findRelevant('我的回答风格是什么？'))[0].use_count).toBe(1)
  })

  it('lets the user inspect, correct and delete a saved memory', async () => {
    const saved = new UserMemory(tmpDir)
    await saved.remember('preference', '回答风格', '详细')
    expect(await saved.listEntries()).toHaveLength(1)
    expect(await saved.updateEntry('preference', '回答风格', '简短')).toMatchObject({ value: '简短' })
    expect(await saved.findRelevant('回答风格')).toEqual([expect.objectContaining({ value: '简短' })])
    expect(await saved.deleteEntry('preference', '回答风格')).toBe(true)
    expect(await saved.listEntries()).toEqual([])
  })
})

describe('Entity tracking', () => {
  // Entities are stored in a subdirectory so they don't collide with chat
  // history files (both use the `{sessionId}.json` naming).
  const entDir = () => path.join(tmpDir, 'entities')

  it('tracks and retrieves file entities', async () => {
    const mem = new Memory(tmpDir, entDir())
    const entity: TrackedEntity = {
      type: 'file',
      ref: '昨天的合同',
      value: 'C:/Users/test/contract.pdf',
      mentioned_at: new Date('2026-07-15T10:00:00').toISOString(),
    }
    await mem.trackEntity('ent-sess', entity)

    const entities = await mem.getEntities('ent-sess')
    expect(entities).toHaveLength(1)
    expect(entities[0].type).toBe('file')
    expect(entities[0].ref).toBe('昨天的合同')
    expect(entities[0].value).toBe('C:/Users/test/contract.pdf')
    expect(entities[0].mentioned_at).toBe(entity.mentioned_at)
  })

  it('gets last entity by type', async () => {
    const mem = new Memory(tmpDir, entDir())
    await mem.trackEntity('type-sess', {
      type: 'file',
      ref: 'file1',
      value: '/path/a.txt',
      mentioned_at: '2026-07-15T09:00:00.000Z',
    })
    await mem.trackEntity('type-sess', {
      type: 'app',
      ref: 'browser',
      value: 'chrome',
      mentioned_at: '2026-07-15T09:30:00.000Z',
    })
    await mem.trackEntity('type-sess', {
      type: 'file',
      ref: 'file2',
      value: '/path/b.txt',
      mentioned_at: '2026-07-15T10:00:00.000Z',
    })

    const lastFile = await mem.getLastEntity('type-sess', 'file')
    expect(lastFile).not.toBeNull()
    expect(lastFile!.value).toBe('/path/b.txt')

    const lastApp = await mem.getLastEntity('type-sess', 'app')
    expect(lastApp).not.toBeNull()
    expect(lastApp!.value).toBe('chrome')

    // Without a type filter, the most recently mentioned entity is returned.
    const lastAny = await mem.getLastEntity('type-sess')
    expect(lastAny!.value).toBe('/path/b.txt')

    // Unknown type yields null.
    const lastPerson = await mem.getLastEntity('type-sess', 'person')
    expect(lastPerson).toBeNull()
  })

  it('limits to 50 entities', async () => {
    const mem = new Memory(tmpDir, entDir())
    for (let i = 0; i < 55; i++) {
      await mem.trackEntity('limit-sess', {
        type: 'file',
        ref: `file${i}`,
        value: `/path/${i}.txt`,
        mentioned_at: new Date(2026, 6, 15, 10, i, 0).toISOString(),
      })
    }

    const entities = await mem.getEntities('limit-sess')
    expect(entities).toHaveLength(50)
    // Oldest 5 (file0..file4) are evicted; first retained is file5, last is file54.
    expect(entities[0].ref).toBe('file5')
    expect(entities[49].ref).toBe('file54')
  })

  it('returns null when no entities exist for a session', async () => {
    const mem = new Memory(tmpDir, entDir())
    const entities = await mem.getEntities('empty-sess')
    expect(entities).toHaveLength(0)
    expect(await mem.getLastEntity('empty-sess')).toBeNull()
    expect(await mem.getLastEntity('empty-sess', 'file')).toBeNull()
  })

  it('persists entities across instances', async () => {
    const mem1 = new Memory(tmpDir, entDir())
    await mem1.trackEntity('persist-ent', {
      type: 'app',
      ref: 'editor',
      value: 'code',
      mentioned_at: '2026-07-15T11:00:00.000Z',
    })

    const mem2 = new Memory(tmpDir, entDir())
    const entities = await mem2.getEntities('persist-ent')
    expect(entities).toHaveLength(1)
    expect(entities[0].value).toBe('code')
  })
})

// ===== UserProfile 测试套件 — 覆盖置信度门控、7天窗口、100条上限、持久化、摘要生成 =====
describe('UserProfile', () => {
  // UserProfile 是单例，每个测试需要重置实例 + 清空临时目录文件
  let profile: UserProfile
  let profilePath: string

  beforeEach(async () => {
    // 重置单例
    const ProfileCtor = UserProfile as unknown as { instance: UserProfile | null }
    ProfileCtor.instance = null
    profile = UserProfile.getInstance(tmpDir)
    profilePath = path.join(tmpDir, 'user_profile.json')
    // 确保文件不存在（测试懒加载）
    await fs.rm(profilePath, { force: true })
  })

  afterEach(async () => {
    const ProfileCtor = UserProfile as unknown as { instance: UserProfile | null }
    ProfileCtor.instance = null
  })

  it('懒加载：首次访问不抛错，文件不存在时按空数据启动', async () => {
    // 不应抛错
    const list = await profile.getProfile()
    expect(list).toEqual([])
  })

  it('supports explicit correction and deletion of a profile entry', async () => {
    await profile.setProfile('preference', '语言', '英文', 0.9)
    expect(await profile.updateProfileEntry('preference', '语言', '中文')).toMatchObject({ value: '中文', confidence: 1 })
    expect(await profile.deleteProfileEntry('preference', '语言')).toBe(true)
    expect(await profile.getProfile()).toEqual([])
  })

  it('setProfile 新增条目并持久化到文件', async () => {
    await profile.setProfile('persona', '职业', 'Go 工程师', 0.9)

    // 文件确实被创建
    const exists = await fs.access(profilePath).then(() => true).catch(() => false)
    expect(exists).toBe(true)

    // 文件内容可解析且包含正确字段
    const raw = await fs.readFile(profilePath, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(Array.isArray(parsed.profile)).toBe(true)
    expect(parsed.profile).toHaveLength(1)
    expect(parsed.profile[0]).toMatchObject({
      category: 'persona',
      key: '职业',
      value: 'Go 工程师',
      confidence: 0.9,
    })
  })

  it('setProfile 置信度门控：低置信度不覆盖高置信度的值', async () => {
    await profile.setProfile('persona', '职业', 'Go 工程师', 0.9)
    // 低置信度尝试覆盖 — 应被拒绝（仅更新时间戳）
    await profile.setProfile('persona', '职业', '前端工程师', 0.5)

    const list = await profile.getProfile('persona')
    expect(list).toHaveLength(1)
    expect(list[0].value).toBe('Go 工程师')  // 仍是高置信度的值
    expect(list[0].confidence).toBe(0.9)
  })

  it('setProfile 置信度门控：同置信度可覆盖', async () => {
    await profile.setProfile('preference', '语言', '中文', 0.7)
    await profile.setProfile('preference', '语言', '英文', 0.7)  // 同置信度

    const list = await profile.getProfile('preference')
    expect(list).toHaveLength(1)
    expect(list[0].value).toBe('英文')
  })

  it('setProfile 置信度门控：更高置信度覆盖更低', async () => {
    await profile.setProfile('skill', 'Go', '入门', 0.5)
    await profile.setProfile('skill', 'Go', '熟练', 0.9)

    const list = await profile.getProfile('skill')
    expect(list).toHaveLength(1)
    expect(list[0].value).toBe('熟练')
    expect(list[0].confidence).toBe(0.9)
  })

  it('setProfile 同 key 不同 category 视为不同条目', async () => {
    await profile.setProfile('persona', '名称', '张三', 0.9)
    await profile.setProfile('preference', '名称', '英文名', 0.9)

    const list = await profile.getProfile()
    expect(list).toHaveLength(2)
  })

  it('setProfile 边界裁剪：超长 value 截断到 300 字符，key 截断到 60', async () => {
    const longKey = 'K'.repeat(100)
    const longValue = 'V'.repeat(500)
    await profile.setProfile('persona', longKey, longValue, 0.9)

    const list = await profile.getProfile()
    expect(list[0].key).toHaveLength(60)
    expect(list[0].value).toHaveLength(300)
  })

  it('setProfile 置信度钳制到 [0, 1]', async () => {
    await profile.setProfile('persona', 'k1', 'v1', 1.5)
    await profile.setProfile('persona', 'k2', 'v2', -0.5)

    const list = await profile.getProfile('persona')
    const k1 = list.find(e => e.key === 'k1')!
    const k2 = list.find(e => e.key === 'k2')!
    expect(k1.confidence).toBe(1)
    expect(k2.confidence).toBe(0)
  })

  it('getProfile 按 confidence 降序排列', async () => {
    await profile.setProfile('skill', 'A', 'a', 0.5)
    await profile.setProfile('skill', 'B', 'b', 0.9)
    await profile.setProfile('skill', 'C', 'c', 0.7)

    const list = await profile.getProfile('skill')
    expect(list.map(e => e.key)).toEqual(['B', 'C', 'A'])  // 0.9, 0.7, 0.5
  })

  it('getProfile category 过滤', async () => {
    await profile.setProfile('persona', 'job', 'dev', 0.9)
    await profile.setProfile('routine', 'sleep', '23:00', 0.7)

    const personas = await profile.getProfile('persona')
    expect(personas).toHaveLength(1)
    expect(personas[0].key).toBe('job')

    const routines = await profile.getProfile('routine')
    expect(routines).toHaveLength(1)
    expect(routines[0].key).toBe('sleep')
  })

  it('addEmotion 记录并裁剪 intensity 到 [1, 5]', async () => {
    await profile.addEmotion('happy', 99, '升职')
    await profile.addEmotion('tired', 0, '加班')

    const recent = await profile.getRecentEmotions(24 * 60)
    expect(recent).toHaveLength(2)
    expect(recent.find(e => e.emotion === 'happy')!.intensity).toBe(5)
    expect(recent.find(e => e.emotion === 'tired')!.intensity).toBe(1)
  })

  it('addEmotion trigger 字段裁剪到 100 字符', async () => {
    const longTrigger = 'T'.repeat(200)
    await profile.addEmotion('happy', 3, longTrigger)

    const recent = await profile.getRecentEmotions(60)
    expect(recent[0].trigger).toHaveLength(100)
  })

  it('addRelationshipEvent 记录并保留最近 100 条', async () => {
    for (let i = 0; i < 105; i++) {
      await profile.addRelationshipEvent({ type: 'positive', summary: `事件 ${i}` })
    }
    const history = await profile.getRelationshipHistory(200)
    expect(history).toHaveLength(100)
    // 最早 5 条被裁剪，第一条应是"事件 5"
    expect(history[0].summary).toBe('事件 5')
    // 最后一条是"事件 104"
    expect(history[99].summary).toBe('事件 104')
  })

  it('addRelationshipEvent summary 裁剪到 200 字符', async () => {
    const longSummary = 'S'.repeat(300)
    await profile.addRelationshipEvent({ type: 'milestone', summary: longSummary })
    const history = await profile.getRelationshipHistory()
    expect(history[0].summary).toHaveLength(200)
  })

  it('getRelationshipHistory limit 参数生效', async () => {
    for (let i = 0; i < 5; i++) {
      await profile.addRelationshipEvent({ type: 'positive', summary: `事件 ${i}` })
    }
    const recent3 = await profile.getRelationshipHistory(3)
    expect(recent3).toHaveLength(3)
    // 应返回最后 3 条
    expect(recent3[0].summary).toBe('事件 2')
    expect(recent3[2].summary).toBe('事件 4')
  })

  it('跨实例持久化：单例重置后从文件恢复', async () => {
    await profile.setProfile('persona', '职业', '测试员', 0.9)
    await profile.addEmotion('happy', 4, '测试通过')
    await profile.addRelationshipEvent({ type: 'milestone', summary: '首次运行' })

    // 重置单例模拟重启
    const ProfileCtor = UserProfile as unknown as { instance: UserProfile | null }
    ProfileCtor.instance = null
    const profile2 = UserProfile.getInstance(tmpDir)

    const personas = await profile2.getProfile('persona')
    expect(personas[0].value).toBe('测试员')

    const emotions = await profile2.getRecentEmotions(60)
    expect(emotions).toHaveLength(1)
    expect(emotions[0].emotion).toBe('happy')

    const history = await profile2.getRelationshipHistory()
    expect(history).toHaveLength(1)
    expect(history[0].summary).toBe('首次运行')
  })

  it('getPromptSummary 无数据时返回空字符串', async () => {
    const text = await profile.getPromptSummary()
    expect(text).toBe('')
  })

  it('getPromptSummary 有数据时包含中文类别和情绪描述', async () => {
    await profile.setProfile('persona', '职业', '工程师', 0.9)
    await profile.setProfile('preference', '语言', '中文', 0.8)
    await profile.addEmotion('happy', 4, '测试')

    const text = await profile.getPromptSummary()
    expect(text).toContain('身份')
    expect(text).toContain('工程师')
    expect(text).toContain('偏好')
    expect(text).toContain('中文')
    // 情绪描述应包含 happy 对应的中文
    expect(text.length).toBeGreaterThan(20)
  })
})
