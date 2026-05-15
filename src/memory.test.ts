import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Memory } from './memory.js'

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
