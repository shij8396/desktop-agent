import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { FakeToolCallingModel } from 'langchain'
import { VectorStore } from '../src/vectorStore.js'
import { Memory, UserMemory } from '../src/memory.js'
import { RagAgent } from '../src/ragAgent.js'
import { config } from '../src/config.js'

describe('RagAgent full LangChain runtime', () => {
  let store: VectorStore
  let memory: Memory
  let userMemory: UserMemory
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rag-test-'))
    store = new VectorStore(path.join(tmpDir, 'vectors.json'))
    memory = new Memory(tmpDir)
    userMemory = new UserMemory(tmpDir)
    ;(config as any).llmProvider = 'openai'
  })
  afterEach(async () => fs.rm(tmpDir, { recursive: true, force: true }))

  it('runs queries through a LangChain chat model and persists transcript history', async () => {
    const agent = new RagAgent({ model: new FakeToolCallingModel(), store, memory, userMemory, engineOptions: { checkpointPath: ':memory:', enablePlanning: false } })
    const answer = await agent.query('什么是 TypeScript？', 'session')
    expect(answer).toContain('什么是 TypeScript？')
    expect(await memory.getHistory('session')).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: '什么是 TypeScript？' }),
      expect.objectContaining({ role: 'assistant' }),
    ]))
  })

  it('uses the LangChain Retriever-backed kb_search tool', async () => {
    store.add('1', 'RAG combines retrieval with generation.', 'rag.md', 0)
    const model = new FakeToolCallingModel({
      toolCalls: [[{ id: 'call_1', name: 'kb_search', args: { query: 'RAG' } }], []],
    })
    const agent = new RagAgent({ model, store, memory, userMemory, engineOptions: { checkpointPath: ':memory:', enablePlanning: false } })
    const answer = await agent.query('什么是 RAG？', 'session')
    expect(answer).toContain('RAG combines retrieval with generation')
  })

  it('reports no local evidence for a knowledge-base query with no matching terms', async () => {
    store.add('1', 'TypeScript generics', 'typescript.md', 0)
    const model = new FakeToolCallingModel({
      toolCalls: [[{ id: 'no_hit', name: 'kb_search', args: { query: '量子纠缠' } }], []],
    })
    const agent = new RagAgent({ model, store, memory, userMemory, engineOptions: { checkpointPath: ':memory:', enablePlanning: false } })
    const answer = await agent.query('知识库里有量子纠缠资料吗？', 'no-hit-session')
    expect(answer).toContain('知识库未检索到相关片段')
    expect(answer).not.toContain('来源：typescript.md')
  })

  it('injects only question-relevant long-term memories into the answer context', async () => {
    await userMemory.remember('preference', '回答风格', '简短直接')
    await userMemory.remember('app', '常用浏览器', 'Firefox')
    const agent = new RagAgent({ model: new FakeToolCallingModel(), store, memory, userMemory, engineOptions: { checkpointPath: ':memory:', enablePlanning: false } })
    const answer = await agent.query('我的回答风格是什么？', 'memory-session')
    expect(answer).toContain('回答风格: 简短直接')
    expect(answer).not.toContain('常用浏览器: Firefox')
  })

  it('recalls explicitly saved user memory after creating a new agent instance', async () => {
    await userMemory.remember('preference', '回答风格', '简短直接')
    const restarted = new RagAgent({
      model: new FakeToolCallingModel(),
      store: new VectorStore(path.join(tmpDir, 'new-vectors.json')),
      memory: new Memory(tmpDir),
      userMemory: new UserMemory(tmpDir),
      engineOptions: { checkpointPath: ':memory:' },
    })
    const answer = await restarted.query('我的回答风格是什么？', 'after-restart')
    expect(answer).toContain('回答风格: 简短直接')
  })

  it('rejects overlong input before invoking the LangChain agent', async () => {
    const agent = new RagAgent({ model: new FakeToolCallingModel(), store, memory, userMemory, engineOptions: { checkpointPath: ':memory:', enablePlanning: false } })
    await expect(agent.query('a'.repeat(config.maxQuestionLength + 1))).resolves.toContain('问题过长')
  })
})
