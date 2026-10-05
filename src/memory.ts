import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { config } from './config.js'
import { createLogger } from './logger.js'
import { tokenize } from './embedding.js'

const log = createLogger('memory')

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2))
    await fs.rename(temporary, filePath)
  } catch (error) {
    await fs.unlink(temporary).catch(() => {})
    throw error
  }
}

export interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface TrackedEntity {
  type: 'file' | 'app' | 'time' | 'person'
  ref: string           // How it was mentioned, e.g. "昨天的合同"
  value: string          // Resolved value, e.g. "C:/Users/.../contract.pdf"
  mentioned_at: string  // ISO timestamp
}

function sanitizeSessionId(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error('Invalid session ID: only alphanumeric, hyphens, underscores allowed')
  }
  return sessionId
}

export class Memory {
  private sessions: Map<string, Message[]> = new Map()
  private locks: Map<string, Promise<void>> = new Map()
  private chatHistoryDir: string

  private entities: Map<string, TrackedEntity[]> = new Map()
  private entityLocks: Map<string, Promise<void>> = new Map()
  private entitiesDir: string

  constructor(chatHistoryDir?: string, entitiesDir?: string) {
    this.chatHistoryDir = chatHistoryDir ?? config.chatHistoryDir
    this.entitiesDir = entitiesDir ?? path.join(config.dataDir, 'entities')
  }

  async addMessage(sessionId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    sanitizeSessionId(sessionId)
    // Per-session mutex to prevent race conditions
    const prev = this.locks.get(sessionId) ?? Promise.resolve()
    const next = prev.then(async () => {
      if (!this.sessions.has(sessionId)) {
        await this.loadSession(sessionId)
      }
      const messages = this.sessions.get(sessionId)!
      messages.push({ role, content, timestamp: Date.now() })
      await this.saveSession(sessionId)
    })
    this.locks.set(sessionId, next)
    await next
  }

  async getHistory(sessionId: string, maxMessages: number = 20): Promise<Message[]> {
    if (!this.sessions.has(sessionId)) {
      await this.loadSession(sessionId)
    }
    const messages = this.sessions.get(sessionId) || []
    return messages.slice(-maxMessages)
  }

  /**
   * 获取会话的累积摘要（用于在裁剪原始历史后仍保留上下文）。
   * 摘要文件：{chatHistoryDir}/{sessionId}.summary.json
   */
  async getSummary(sessionId: string): Promise<{ summary: string; last_summarized_at: string; last_summarized_message_index: number } | null> {
    const safeId = sanitizeSessionId(sessionId)
    const filePath = path.join(this.chatHistoryDir, `${safeId}.summary.json`)
    try {
      const data = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (parsed && typeof parsed.summary === 'string') {
        return {
          summary: parsed.summary,
          last_summarized_at: parsed.last_summarized_at || new Date().toISOString(),
          last_summarized_message_index: typeof parsed.last_summarized_message_index === 'number'
            ? parsed.last_summarized_message_index : 0,
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.debug('Failed to load summary', { sessionId, error: String(error) })
      }
    }
    return null
  }

  /**
   * 写入会话累积摘要。
   */
  async setSummary(sessionId: string, summary: string, lastSummarizedIndex: number): Promise<void> {
    const safeId = sanitizeSessionId(sessionId)
    await fs.mkdir(this.chatHistoryDir, { recursive: true })
    const filePath = path.join(this.chatHistoryDir, `${safeId}.summary.json`)
    const data = {
      summary: summary.slice(0, 4000),
      last_summarized_at: new Date().toISOString(),
      last_summarized_message_index: lastSummarizedIndex,
    }
    await fs.writeFile(filePath, JSON.stringify(data, null, 2))
  }

  /**
   * 裁剪历史，只保留最后 N 条。同时持久化。
   * 调用前请确保 session 已加载。
   */
  async trimHistoryTo(sessionId: string, keepLastN: number): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      await this.loadSession(sessionId)
    }
    const messages = this.sessions.get(sessionId)
    if (!messages || messages.length <= keepLastN) return
    this.sessions.set(sessionId, messages.slice(-keepLastN))
    await this.saveSession(sessionId)
    log.info('history trimmed', { sessionId, kept: keepLastN, removed: messages.length - keepLastN })
  }

  async clearHistory(sessionId: string): Promise<void> {
    const safeId = sanitizeSessionId(sessionId)
    this.sessions.set(sessionId, [])
    const filePath = path.join(this.chatHistoryDir, `${safeId}.json`)
    try {
      await fs.unlink(filePath)
    } catch {
      // File might not exist
    }
    // 同时清除累积摘要
    const summaryPath = path.join(this.chatHistoryDir, `${safeId}.summary.json`)
    try {
      await fs.unlink(summaryPath)
    } catch {
      // 摘要文件可能不存在
    }
  }

  async listSessions(): Promise<string[]> {
    await fs.mkdir(this.chatHistoryDir, { recursive: true })
    const files = await fs.readdir(this.chatHistoryDir)
    // 排除 *.summary.json（不属于会话历史本体）
    return files
      .filter(f => f.endsWith('.json') && !f.endsWith('.summary.json'))
      .map(f => f.replace('.json', ''))
  }

  /**
   * Track an entity mentioned in conversation so later references like
   * "那个文件" or "打开它" can be resolved. Keeps at most 50 entities per
   * session, evicting the oldest when the limit is exceeded.
   */
  async trackEntity(sessionId: string, entity: TrackedEntity): Promise<void> {
    sanitizeSessionId(sessionId)
    const prev = this.entityLocks.get(sessionId) ?? Promise.resolve()
    const next = prev.then(async () => {
      if (!this.entities.has(sessionId)) {
        await this.loadEntities(sessionId)
      }
      const list = this.entities.get(sessionId)!
      list.push(entity)
      while (list.length > 50) {
        list.shift()
      }
      await this.saveEntities(sessionId)
    })
    this.entityLocks.set(sessionId, next)
    await next
  }

  /** Retrieve all tracked entities for a session (newest appended last). */
  async getEntities(sessionId: string): Promise<TrackedEntity[]> {
    if (!this.entities.has(sessionId)) {
      await this.loadEntities(sessionId)
    }
    return [...(this.entities.get(sessionId) || [])]
  }

  /**
   * Return the most recently mentioned entity for a session.
   * Optionally filter by type ('file' | 'app' | 'time' | 'person').
   */
  async getLastEntity(sessionId: string, type?: string): Promise<TrackedEntity | null> {
    const list = await this.getEntities(sessionId)
    if (list.length === 0) return null
    if (type) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].type === type) return list[i]
      }
      return null
    }
    return list[list.length - 1]
  }

  private async loadSession(sessionId: string): Promise<void> {
    const safeId = sanitizeSessionId(sessionId)
    const filePath = path.join(this.chatHistoryDir, `${safeId}.json`)
    try {
      const data = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed)) {
        this.sessions.set(sessionId, parsed)
      } else {
        log.warn('Invalid session data, resetting', { sessionId })
        this.sessions.set(sessionId, [])
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        log.warn('Corrupted session file, resetting history', { sessionId })
      } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Failed to load session', { sessionId, error: String(error) })
      }
      this.sessions.set(sessionId, [])
    }
  }

  private async saveSession(sessionId: string): Promise<void> {
    const safeId = sanitizeSessionId(sessionId)
    await fs.mkdir(this.chatHistoryDir, { recursive: true })
    const filePath = path.join(this.chatHistoryDir, `${safeId}.json`)
    const messages = this.sessions.get(sessionId) || []
    await fs.writeFile(filePath, JSON.stringify(messages, null, 2))
  }

  private async loadEntities(sessionId: string): Promise<void> {
    const safeId = sanitizeSessionId(sessionId)
    const filePath = path.join(this.entitiesDir, `${safeId}.json`)
    try {
      const data = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed)) {
        this.entities.set(sessionId, parsed)
      } else {
        log.warn('Invalid entities data, resetting', { sessionId })
        this.entities.set(sessionId, [])
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        log.warn('Corrupted entities file, resetting', { sessionId })
      } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('Failed to load entities', { sessionId, error: String(error) })
      }
      this.entities.set(sessionId, [])
    }
  }

  private async saveEntities(sessionId: string): Promise<void> {
    const safeId = sanitizeSessionId(sessionId)
    await fs.mkdir(this.entitiesDir, { recursive: true })
    const filePath = path.join(this.entitiesDir, `${safeId}.json`)
    const list = this.entities.get(sessionId) || []
    await fs.writeFile(filePath, JSON.stringify(list, null, 2))
  }
}

// ===== 长期用户记忆模块（跨会话持久化） =====

/**
 * 长期用户记忆条目 — 跨会话持久化，记录用户常用软件、文件路径、高频指令、偏好回答风格。
 * 与 session 级 entities 不同，UserMemory 是用户级别的，所有会话共享。
 */
export interface UserMemoryEntry {
  type: 'app' | 'path' | 'command' | 'preference'
  key: string
  value: string
  ref?: string
  created_at: string
  last_used_at: string
  use_count: number
}

/**
 * 跨会话用户记忆库 — 贾维斯主动管家的核心能力之一。
 *
 * 设计要点：
 * - 持久化为 JSON 文件（dataDir/user_memory.json）
 * - 通过进程内 Map 缓存，写入时双重保证（内存+磁盘）
 * - 单例模式：通过 getUserMemory() 获取
 * - 自动去重：相同 (type, key) 视为同一记忆，仅更新 value 和 use_count
 * - 容量限制：最多 200 条，超出时按 use_count 升序淘汰最旧的
 */
export class UserMemory {
  private entries: UserMemoryEntry[] = []
  private dirty = false
  private filePath: string
  private lock: Promise<void> = Promise.resolve()
  private loaded = false
  private static instance: UserMemory | null = null

  constructor(dataDir?: string) {
    this.filePath = path.join(dataDir ?? config.dataDir, 'user_memory.json')
  }

  /** 获取单例 — 推荐使用方式 */
  static getInstance(dataDir?: string): UserMemory {
    if (!UserMemory.instance) {
      UserMemory.instance = new UserMemory(dataDir)
    }
    return UserMemory.instance
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    const next = this.lock.then(async () => {
      if (this.loaded) return
      try {
        const data = await fs.readFile(this.filePath, 'utf-8')
        const parsed = JSON.parse(data)
        if (Array.isArray(parsed)) {
          this.entries = parsed.filter(e => e && typeof e.key === 'string' && typeof e.value === 'string')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('Failed to load user memory', { error: String(error) })
        }
        this.entries = []
      }
      this.loaded = true
    })
    this.lock = next
    await next
  }

  /**
   * 记录一条用户记忆。若 (type, key) 已存在，则更新 value 并增加 use_count。
   */
  async remember(
    type: UserMemoryEntry['type'],
    key: string,
    value: string,
    ref?: string,
  ): Promise<UserMemoryEntry> {
    const trimmedKey = key.trim().slice(0, 100)
    const trimmedValue = value.trim().slice(0, 500)
    if (!trimmedKey || !trimmedValue) {
      throw new Error('key and value must be non-empty')
    }
    await this.ensureLoaded()
    const now = new Date().toISOString()
    const existing = this.entries.find(
      e => e.type === type && e.key.toLowerCase() === trimmedKey.toLowerCase(),
    )
    if (existing) {
      existing.value = trimmedValue
      existing.ref = ref ?? existing.ref
      existing.last_used_at = now
      existing.use_count += 1
      this.dirty = true
      await this.persist()
      return existing
    }
    const entry: UserMemoryEntry = {
      type,
      key: trimmedKey,
      value: trimmedValue,
      ref,
      created_at: now,
      last_used_at: now,
      use_count: 1,
    }
    this.entries.push(entry)
    // 容量限制：超出时淘汰 use_count 最低的
    while (this.entries.length > 200) {
      let minIdx = 0
      for (let i = 1; i < this.entries.length; i++) {
        if (this.entries[i].use_count < this.entries[minIdx].use_count) {
          minIdx = i
        }
      }
      this.entries.splice(minIdx, 1)
    }
    this.dirty = true
    await this.persist()
    return entry
  }

  /**
   * 检索记忆 — 支持按 type 过滤 + 关键词模糊匹配。
   * 关键词为空时返回该类型的所有记忆（按 use_count 降序）。
   */
  async recall(
    type?: UserMemoryEntry['type'],
    keyword?: string,
  ): Promise<UserMemoryEntry[]> {
    await this.ensureLoaded()
    let list = [...this.entries]
    if (type) list = list.filter(e => e.type === type)
    if (keyword && keyword.trim().length > 0) {
      const kw = keyword.trim().toLowerCase()
      list = list.filter(
        e =>
          e.key.toLowerCase().includes(kw) ||
          e.value.toLowerCase().includes(kw) ||
          (e.ref ?? '').toLowerCase().includes(kw),
      )
    }
    // 标记使用（命中即增加 use_count，下次检索优先级更高）
    if (type || keyword) {
      const now = new Date().toISOString()
      for (const e of list) {
        e.last_used_at = now
        e.use_count += 1
      }
      if (list.length > 0) {
        this.dirty = true
        await this.persist()
      }
    }
    list.sort((a, b) => b.use_count - a.use_count)
    return list
  }

  /** Read-only, query-scoped lookup for prompt context; unlike recall(), this does not change usage counters. */
  async findRelevant(question: string, limit = 5): Promise<UserMemoryEntry[]> {
    await this.ensureLoaded()
    const terms = new Set(tokenize(question).filter(term => term.length >= 2))
    if (!terms.size) return []
    return this.entries
      .map(entry => {
        const keyTerms = new Set(tokenize(entry.key))
        const otherTerms = new Set(tokenize(`${entry.value} ${entry.ref ?? ''}`))
        let score = 0
        for (const term of terms) {
          if (keyTerms.has(term)) score += 3
          else if (otherTerms.has(term)) score += 1
        }
        return { entry, score }
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.use_count - a.entry.use_count)
      .slice(0, Math.max(0, Math.min(limit, 5)))
      .map(item => ({ ...item.entry }))
  }

  async listEntries(): Promise<UserMemoryEntry[]> {
    await this.ensureLoaded()
    return this.entries
      .map(entry => ({ ...entry }))
      .sort((a, b) => b.last_used_at.localeCompare(a.last_used_at))
  }

  async updateEntry(type: UserMemoryEntry['type'], key: string, value: string): Promise<UserMemoryEntry | null> {
    await this.ensureLoaded()
    const normalizedValue = value.trim().slice(0, 500)
    if (!normalizedValue) throw new Error('value must be non-empty')
    const entry = this.entries.find(item => item.type === type && item.key === key)
    if (!entry) return null
    entry.value = normalizedValue
    entry.last_used_at = new Date().toISOString()
    this.dirty = true
    await this.persist()
    return { ...entry }
  }

  async deleteEntry(type: UserMemoryEntry['type'], key: string): Promise<boolean> {
    await this.ensureLoaded()
    const before = this.entries.length
    this.entries = this.entries.filter(item => item.type !== type || item.key !== key)
    if (this.entries.length === before) return false
    this.dirty = true
    await this.persist()
    return true
  }

  /**
   * 清空所有用户记忆。不可逆操作。
   * @param type 可选：仅清空指定类型；不传则清空全部
   */
  async clear(type?: UserMemoryEntry['type']): Promise<{ cleared: number }> {
    await this.ensureLoaded()
    let cleared: number
    if (type) {
      const before = this.entries.length
      this.entries = this.entries.filter(e => e.type !== type)
      cleared = before - this.entries.length
    } else {
      cleared = this.entries.length
      this.entries = []
    }
    this.dirty = true
    await this.persist()
    return { cleared }
  }

  /** 统计信息 — 用于调试和 UI 展示 */
  async stats(): Promise<{ total: number; byType: Record<string, number> }> {
    await this.ensureLoaded()
    const byType: Record<string, number> = {}
    for (const e of this.entries) {
      byType[e.type] = (byType[e.type] ?? 0) + 1
    }
    return { total: this.entries.length, byType }
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    try {
      await writeJsonAtomic(this.filePath, this.entries)
    } catch (error) {
      log.warn('Failed to persist user memory', { error: String(error) })
      this.dirty = true // retry next time
      throw error
    }
  }
}

// ===== 用户画像层（UserProfile） =====
// 在 UserMemory 基础上扩展：人格画像、关系历史、情绪轨迹
// 用于动态拼装 system prompt，让小伴"记得你是谁"

/** 用户画像条目 — 稳定的用户属性 */
export interface ProfileEntry {
  category: 'persona' | 'preference' | 'routine' | 'skill'
  key: string
  value: string
  confidence: number // 0-1，LLM 推断出的可信度
  updated_at: string
}

/** 关系历史事件 — 共同经历 */
export interface RelationshipEvent {
  timestamp: string
  type: 'milestone' | 'preference_change' | 'incident' | 'positive' | 'negative'
  summary: string
}

/** 情绪轨迹点 — 从用户语气推断 */
export interface EmotionPoint {
  timestamp: string
  emotion: 'happy' | 'neutral' | 'frustrated' | 'tired' | 'excited' | 'confused'
  intensity: number // 1-5
  trigger?: string
}

/**
 * UserProfile — 用户画像层
 *
 * 三层结构：
 * 1. profile: 稳定属性（职业/作息/技能/偏好）
 * 2. relationship: 共同经历时间线（重要事件）
 * 3. emotions: 近 7 天情绪轨迹（用于调整回答语气）
 *
 * 持久化为单个 JSON 文件（user_profile.json），单例模式。
 */
export class UserProfile {
  private profile: ProfileEntry[] = []
  private relationship: RelationshipEvent[] = []
  private emotions: EmotionPoint[] = []
  private dirty = false
  private loaded = false
  private lock: Promise<void> = Promise.resolve()
  private filePath: string
  private static instance: UserProfile | null = null

  private constructor(dataDir?: string) {
    this.filePath = path.join(dataDir ?? config.dataDir, 'user_profile.json')
  }

  static getInstance(dataDir?: string): UserProfile {
    if (!UserProfile.instance) {
      UserProfile.instance = new UserProfile(dataDir)
    }
    return UserProfile.instance
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    const next = this.lock.then(async () => {
      if (this.loaded) return
      try {
        const data = await fs.readFile(this.filePath, 'utf-8')
        const parsed = JSON.parse(data)
        if (Array.isArray(parsed.profile)) this.profile = parsed.profile
        if (Array.isArray(parsed.relationship)) this.relationship = parsed.relationship
        if (Array.isArray(parsed.emotions)) this.emotions = parsed.emotions
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('Failed to load user profile', { error: String(error) })
        }
      }
      this.loaded = true
    })
    this.lock = next
    await next
  }

  /**
   * 记录/更新一条用户画像属性。
   * - 同 (category, key) 视为同一项，更新 value 和 confidence
   * - 新值 confidence 更高才覆盖
   */
  async setProfile(
    category: ProfileEntry['category'],
    key: string,
    value: string,
    confidence: number = 0.7,
  ): Promise<void> {
    await this.ensureLoaded()
    const trimmedKey = key.trim().slice(0, 60)
    const trimmedValue = value.trim().slice(0, 300)
    if (!trimmedKey || !trimmedValue) return
    const c = Math.max(0, Math.min(1, confidence))
    const now = new Date().toISOString()
    const existing = this.profile.find(
      e => e.category === category && e.key.toLowerCase() === trimmedKey.toLowerCase(),
    )
    if (existing) {
      // 仅当新置信度 ≥ 旧置信度时才覆盖 value
      if (c >= existing.confidence) {
        existing.value = trimmedValue
        existing.confidence = c
        existing.updated_at = now
      } else {
        // 否则仅更新时间戳（增强证据）
        existing.updated_at = now
      }
    } else {
      this.profile.push({
        category,
        key: trimmedKey,
        value: trimmedValue,
        confidence: c,
        updated_at: now,
      })
    }
    this.dirty = true
    await this.persist()
  }

  /** 查询画像属性 — 支持按 category 过滤 */
  async getProfile(category?: ProfileEntry['category']): Promise<ProfileEntry[]> {
    await this.ensureLoaded()
    let list = [...this.profile]
    if (category) list = list.filter(e => e.category === category)
    return list.sort((a, b) => b.confidence - a.confidence)
  }

  async updateProfileEntry(category: ProfileEntry['category'], key: string, value: string): Promise<ProfileEntry | null> {
    await this.ensureLoaded()
    const normalizedValue = value.trim().slice(0, 300)
    if (!normalizedValue) throw new Error('value must be non-empty')
    const entry = this.profile.find(item => item.category === category && item.key === key)
    if (!entry) return null
    entry.value = normalizedValue
    entry.confidence = 1
    entry.updated_at = new Date().toISOString()
    this.dirty = true
    await this.persist()
    return { ...entry }
  }

  async deleteProfileEntry(category: ProfileEntry['category'], key: string): Promise<boolean> {
    await this.ensureLoaded()
    const before = this.profile.length
    this.profile = this.profile.filter(item => item.category !== category || item.key !== key)
    if (this.profile.length === before) return false
    this.dirty = true
    await this.persist()
    return true
  }

  /** 记录关系事件（共同经历） */
  async addRelationshipEvent(event: Omit<RelationshipEvent, 'timestamp'> & { timestamp?: string }): Promise<void> {
    await this.ensureLoaded()
    const ev: RelationshipEvent = {
      timestamp: event.timestamp ?? new Date().toISOString(),
      type: event.type,
      summary: event.summary.slice(0, 200),
    }
    this.relationship.push(ev)
    // 仅保留最近 100 条
    if (this.relationship.length > 100) {
      this.relationship = this.relationship.slice(-100)
    }
    this.dirty = true
    await this.persist()
  }

  /** 查询关系历史 — 默认返回最近 N 条 */
  async getRelationshipHistory(limit: number = 10): Promise<RelationshipEvent[]> {
    await this.ensureLoaded()
    return this.relationship.slice(-limit)
  }

  /** 记录一次情绪轨迹点 */
  async addEmotion(emotion: EmotionPoint['emotion'], intensity: number, trigger?: string): Promise<void> {
    await this.ensureLoaded()
    const point: EmotionPoint = {
      timestamp: new Date().toISOString(),
      emotion,
      intensity: Math.max(1, Math.min(5, intensity)),
      trigger: trigger?.slice(0, 100),
    }
    this.emotions.push(point)
    // 仅保留最近 7 天
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    this.emotions = this.emotions.filter(e => new Date(e.timestamp).getTime() >= cutoff)
    this.dirty = true
    await this.persist()
  }

  /** 查询近期情绪轨迹 */
  async getRecentEmotions(hours: number = 24): Promise<EmotionPoint[]> {
    await this.ensureLoaded()
    const cutoff = Date.now() - hours * 60 * 60 * 1000
    return this.emotions.filter(e => new Date(e.timestamp).getTime() >= cutoff)
  }

  /**
   * 生成画像摘要 — 注入 system prompt。
   * 返回简短中文描述，包含核心画像 + 最近情绪 + 关键关系事件。
   */
  async getPromptSummary(): Promise<string> {
    await this.ensureLoaded()
    const parts: string[] = []

    if (this.profile.length > 0) {
      // 按 category 分组，每组取 confidence 最高的 3 条
      const categories: ProfileEntry['category'][] = ['persona', 'preference', 'routine', 'skill']
      const lines: string[] = []
      for (const cat of categories) {
        const items = this.profile
          .filter(e => e.category === cat)
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 3)
        if (items.length > 0) {
          const catName = {
            persona: '身份',
            preference: '偏好',
            routine: '作息',
            skill: '技能',
          }[cat]
          lines.push(`${catName}: ${items.map(e => e.value).join('; ')}`)
        }
      }
      if (lines.length > 0) parts.push(lines.join('\n'))
    }

    // 最近情绪
    const recentEmotions = await this.getRecentEmotions(24)
    if (recentEmotions.length > 0) {
      const last = recentEmotions[recentEmotions.length - 1]
      const emotionCN = {
        happy: '愉快', neutral: '平静', frustrated: '受挫',
        tired: '疲惫', excited: '兴奋', confused: '困惑',
      }[last.emotion] || last.emotion
      parts.push(`用户当前情绪: ${emotionCN}(强度${last.intensity}/5)`)
    }

    // 最近关系事件
    const recentRel = await this.getRelationshipHistory(3)
    if (recentRel.length > 0) {
      parts.push(`近期互动: ${recentRel.map(e => e.summary).join('; ')}`)
    }

    if (parts.length === 0) return ''
    return `【用户画像】\n${parts.join('\n')}`
  }

  /** 清空所有画像数据 */
  async clear(): Promise<void> {
    await this.ensureLoaded()
    this.profile = []
    this.relationship = []
    this.emotions = []
    this.dirty = true
    await this.persist()
  }

  /** 调试统计 */
  async stats(): Promise<{ profile: number; relationship: number; emotions: number }> {
    await this.ensureLoaded()
    return {
      profile: this.profile.length,
      relationship: this.relationship.length,
      emotions: this.emotions.length,
    }
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    try {
      const data = {
        profile: this.profile,
        relationship: this.relationship,
        emotions: this.emotions,
      }
      await writeJsonAtomic(this.filePath, data)
    } catch (error) {
      log.warn('Failed to persist user profile', { error: String(error) })
      this.dirty = true
      throw error
    }
  }
}
