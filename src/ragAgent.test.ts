import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { VectorStore } from './vectorStore.js'
import { Memory } from './memory.js'
import { RagAgent } from './ragAgent.js'

// Mock Anthropic client
function createMockClient(answer: string = 'Mocked answer') {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: answer }],
      }),
      stream: vi.fn(),
    },
  } as any
}

describe('RagAgent', () => {
  let store: VectorStore
  let memory: Memory
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-test-'))
    store = new VectorStore()
    memory = new Memory(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should return LLM answer from query', async () => {
    const client = createMockClient('Test answer about TypeScript')
    const agent = new RagAgent({ client, store, memory })

    store.add('1', 'TypeScript is a typed superset of JavaScript', 'docs.md', 0)
    const answer = await agent.query('What is TypeScript?', 'test-session')
    expect(answer).toBe('Test answer about TypeScript')
  })

  it('should include KB tools and search capability', async () => {
    const client = createMockClient('RAG answer')
    const agent = new RagAgent({ client, store, memory })

    store.add('1', 'RAG combines retrieval with generation', 'rag.md', 0)
    const answer = await agent.query('What is RAG?', 'test-session')

    // Verify LLM was called with tools available
    const calls = (client.messages.create as any).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const callArgs = calls[0][0]
    const toolNames = callArgs.tools.map((t: any) => t.name)
    expect(toolNames).toContain('kb_search')
    expect(answer).toBe('RAG answer')
  })

  it('should save conversation to memory', async () => {
    const client = createMockClient('Memory test answer')
    const agent = new RagAgent({ client, store, memory })

    await agent.query('Hello', 'mem-test')
    const history = await memory.getHistory('mem-test')
    expect(history).toHaveLength(2)
    expect(history[0].role).toBe('user')
    expect(history[0].content).toBe('Hello')
    expect(history[1].role).toBe('assistant')
    expect(history[1].content).toBe('Memory test answer')
  })

  it('should return status info', () => {
    const client = createMockClient()
    const agent = new RagAgent({ client, store, memory })

    store.add('1', 'content', 'file.md', 0)
    store.add('2', 'more', 'file.md', 1)

    const status = agent.getStatus()
    expect(status.chunkCount).toBe(2)
    expect(status.sources).toEqual(['file.md'])
  })

  it('should reject overly long questions', async () => {
    const client = createMockClient()
    const agent = new RagAgent({ client, store, memory })

    const longQuestion = 'a'.repeat(3000)
    const answer = await agent.query(longQuestion, 'test')
    expect(answer).toContain('问题过长')
  })

  it('should pass the actual question and recent history to the model', async () => {
    const client = createMockClient('Context answer')
    const agent = new RagAgent({ client, store, memory })

    await memory.addMessage('ctx-test', 'user', '你好')
    await memory.addMessage('ctx-test', 'assistant', '你好，我在。')
    await agent.query('现在几点？', 'ctx-test')

    const callArgs = (client.messages.create as any).mock.calls[0][0]
    const text = callArgs.messages[0].content[0].text
    expect(text).toContain('用户: 你好')
    expect(text).toContain('助手: 你好，我在。')
    expect(text).toContain('用户问题：现在几点？')
    expect(text).not.toContain('{question}')
  })

  it('should expose memory instance', () => {
    const client = createMockClient()
    const agent = new RagAgent({ client, store, memory })
    expect(agent.getMemory()).toBe(memory)
  })
})
