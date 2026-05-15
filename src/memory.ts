import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { createLogger } from './logger.js'

const log = createLogger('memory')

export interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
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

  constructor(chatHistoryDir?: string) {
    this.chatHistoryDir = chatHistoryDir ?? config.chatHistoryDir
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

  async clearHistory(sessionId: string): Promise<void> {
    sanitizeSessionId(sessionId)
    this.sessions.set(sessionId, [])
    const filePath = path.join(this.chatHistoryDir, `${sessionId}.json`)
    try {
      await fs.unlink(filePath)
    } catch {
      // File might not exist
    }
  }

  async listSessions(): Promise<string[]> {
    await fs.mkdir(this.chatHistoryDir, { recursive: true })
    const files = await fs.readdir(this.chatHistoryDir)
    return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
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
}
