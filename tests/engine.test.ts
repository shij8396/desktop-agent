import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { FakeToolCallingModel } from 'langchain'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { AgentEngine } from '../src/agent/engine.js'
import { Memory } from '../src/memory.js'
import { VectorStore } from '../src/vectorStore.js'
import { confirmAction, listPendingActions, rejectAction } from '../src/actions.js'
import { resolveDesktopActionResult, setAuthorizedRoots } from '../src/tools.js'

describe('LangChain AgentEngine', () => {
  let tmpDir: string
  let memory: Memory
  let store: VectorStore

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'))
    memory = new Memory(tmpDir, path.join(tmpDir, 'entities'))
    store = new VectorStore(path.join(tmpDir, 'vectors.json'))
    setAuthorizedRoots([tmpDir])
  })
  afterEach(async () => fs.rm(tmpDir, { recursive: true, force: true }))

  it('executes through LangChain createAgent and checkpoint memory', async () => {
    const engine = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), { checkpointPath: ':memory:', enablePlanning: false })
    const answer = await engine.execute('你好，小伴', 'session')
    expect(answer).toContain('你好，小伴')
    expect((await memory.getHistory('session')).map(item => item.role)).toEqual(['user', 'assistant'])
  })

  it('uses a saved conversation summary only in its own session', async () => {
    await memory.setSummary('summary-session', '用户正在准备交通工程报告，偏好简短中文回答。', 0)
    const engine = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), { checkpointPath: ':memory:', enablePlanning: false })
    const remembered = await engine.execute('继续刚才的话题', 'summary-session')
    const unrelated = await engine.execute('你好', 'other-session')
    expect(remembered).toContain('用户正在准备交通工程报告')
    expect(unrelated).not.toContain('用户正在准备交通工程报告')
  })

  it('clarifies an ambiguous affirmative before invoking any model or tool', async () => {
    await memory.addMessage('ambiguous-session', 'user', '你可以帮我处理这篇文章吗？')
    await memory.addMessage('ambiguous-session', 'assistant', '需要我帮你打开文章，还是导出 Word 文档？')
    const engine = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), { checkpointPath: ':memory:' })
    const actions: string[] = []
    const answer = await engine.execute('需要', 'ambiguous-session', event => {
      if (event.type === 'action' && event.tool) actions.push(event.tool)
    })
    expect(answer).toContain('打开文章')
    expect(answer).toContain('导出 Word 文档')
    expect(actions).toEqual([])
    expect((await engine.getTaskSnapshot('ambiguous-session')).plan?.steps).toEqual([])

    const selected = await engine.execute('第一个', 'ambiguous-session')
    expect(selected).toContain('打开文章')
    const selectedPlan = (await engine.getTaskSnapshot('ambiguous-session')).plan
    expect(selectedPlan?.user_request).toContain('打开文章')
    expect(selectedPlan?.user_request).not.toContain('导出 Word')
  })

  it('treats rejection of a previous offer as cancellation, not execution', async () => {
    await memory.addMessage('reject-offer', 'assistant', '需要我打开记事本吗？')
    const engine = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), { checkpointPath: ':memory:' })
    const actions: string[] = []
    const answer = await engine.execute('不要', 'reject-offer', event => {
      if (event.type === 'action' && event.tool) actions.push(event.tool)
    })
    expect(answer).toContain('不继续执行')
    expect(actions).toEqual([])
  })

  it('turns acceptance of one offered desktop action into the normal approval flow', async () => {
    await memory.addMessage('accept-offer', 'assistant', '需要我打开记事本吗？')
    const engine = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), { checkpointPath: ':memory:' })
    const events: any[] = []
    const answer = await engine.execute('需要', 'accept-offer', event => {
      events.push(event)
      if (event.type === 'desktop_request' && event.toolId) {
        resolveDesktopActionResult(event.toolId, { ok: false, error: 'ACTION_REJECTED' })
      }
    })
    expect(events.some(event => event.type === 'desktop_request')).toBe(true)
    expect(answer).toContain('已取消启动')
    expect((await engine.getTaskSnapshot('accept-offer')).status).toBe('cancelled')
  })

  it('emits action and observation events around LangChain tool execution', async () => {
    const model = new FakeToolCallingModel({
      toolCalls: [[{ id: 'call_1', name: 'get_datetime', args: {} }], []],
    })
    const engine = new AgentEngine(model, memory, store.asRetriever(5), { checkpointPath: ':memory:', enablePlanning: false })
    const events: any[] = []
    await engine.execute('现在几点？', 'session', event => { events.push(event) })
    expect(events.some(event => event.type === 'action')).toBe(true)
    expect(events.some(event => event.type === 'observation')).toBe(true)
    const action = events.find(event => event.type === 'action' && event.tool === 'get_datetime')
    const observation = events.find(event => event.type === 'observation' && event.tool === 'get_datetime')
    expect(action.invocationId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(observation.invocationId).toBe(action.invocationId)
    expect(events.some(event => event.type === 'answer')).toBe(true)
  })

  it('keeps concurrent tool outcomes attached to the correct task steps', async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[
      { id: 'date-call', name: 'get_datetime', args: {} },
      { id: 'math-call', name: 'calculate', args: { expression: '17*23' } },
    ], []] })
    const engine = new AgentEngine(model, memory, store.asRetriever(5), { checkpointPath: ':memory:' })
    await engine.execute('调用日期和计算工具', 'parallel-tools')
    const snapshot = await engine.getTaskSnapshot('parallel-tools')
    expect(snapshot.status).toBe('completed')
    expect(snapshot.plan?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'get_datetime', status: 'completed' }),
      expect.objectContaining({ tool: 'calculate', status: 'completed' }),
    ]))
    const calculation = snapshot.plan?.steps.find(step => step.tool === 'calculate')
    expect(JSON.stringify(calculation?.result)).toContain('391')
  })

  it('reports a mixed outcome as partially complete without claiming full success', async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[
      { id: 'math-ok', name: 'calculate', args: { expression: '17*23' } },
      { id: 'file-missing', name: 'read_file_content', args: { path: path.join(tmpDir, 'missing.txt') } },
    ], []] })
    const engine = new AgentEngine(model, memory, store.asRetriever(5), { checkpointPath: ':memory:' })
    const answer = await engine.execute('计算并读取文件', 'mixed-outcome')
    const snapshot = await engine.getTaskSnapshot('mixed-outcome')
    expect(snapshot.status).toBe('failed')
    expect(answer).toContain('任务部分完成')
    expect(snapshot.plan?.steps.map(step => step.status)).toContain('completed')
    expect(snapshot.plan?.steps.map(step => step.status)).toContain('failed')
  })

  it('gathers current date evidence even when the model skips tool calls', async () => {
    const engine = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), { checkpointPath: ':memory:' })
    const actions: string[] = []
    await engine.execute('现在几点？', 'date-evidence', event => {
      if (event.type === 'action' && event.tool) actions.push(event.tool)
    })
    expect(actions).toContain('get_datetime')
    expect((await engine.getTaskSnapshot('date-evidence')).plan?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: 'get_datetime', status: 'completed' }),
    ]))
  })

  it('stops a repeating tool-call loop with a readable failure before raw recursion errors leak', async () => {
    const model = new FakeToolCallingModel({ toolCalls: Array.from({ length: 20 }, (_, index) => [
      { id: `loop-${index}`, name: 'get_datetime', args: {} },
    ]) })
    const engine = new AgentEngine(model, memory, store.asRetriever(5), { checkpointPath: ':memory:' })
    const actions: string[] = []
    const answer = await engine.execute('反复查询日期', 'loop-session', event => {
      if (event.type === 'action' && event.tool) actions.push(event.tool)
    })
    expect(answer).toContain('仍未得出结果，已自动停止')
    expect(answer).not.toContain('Recursion limit')
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.length).toBeLessThanOrEqual(4)
    expect((await engine.getTaskSnapshot('loop-session')).status).toBe('failed')
  })

  it('cancels only the matching active run and records a cancelled task', async () => {
    let markModelStarted!: () => void
    const modelStarted = new Promise<void>(resolve => { markModelStarted = resolve })
    class SlowModel extends FakeToolCallingModel {
      bindTools(): any { return this }
      async _generate(messages: any, options: any, runManager: any): Promise<any> {
        markModelStarted()
        await new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('slow-model timeout')), 1500)
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          }, { once: true })
        })
        return super._generate(messages, options, runManager)
      }
    }
    const engine = new AgentEngine(new SlowModel(), memory, store.asRetriever(5), { checkpointPath: ':memory:' })
    const requestId = '11111111-1111-4111-8111-111111111111'
    const running = engine.execute('请持续分析', 'cancel-session', undefined, { requestId })
    await modelStarted
    expect(engine.cancelTask('different-session', requestId)).toBe(false)
    expect(engine.cancelTask('cancel-session', requestId)).toBe(true)
    const answer = await Promise.race([running, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('cancel timeout')), 3000))])
    expect(answer).toContain('任务已取消')
    expect(engine.cancelTask('cancel-session', requestId)).toBe(false)
    expect((await engine.getTaskSnapshot('cancel-session')).status).toBe('cancelled')
  })

  it('sends the resolved desktop program to the approval bridge before waiting for a result', async () => {
    const model = new FakeToolCallingModel()
    const engine = new AgentEngine(model, memory, store.asRetriever(5), { checkpointPath: ':memory:', enablePlanning: false })
    const events: any[] = []
    const answer = await engine.execute('打开记事本', 'launch-session', event => {
      events.push(event)
      if (event.type === 'desktop_request' && event.toolId) {
        expect(event.toolInput?.program).toBe('notepad.exe')
        expect(resolveDesktopActionResult(event.toolId, { ok: false, error: 'ACTION_REJECTED' })).toBe(true)
      }
    })
    expect(events.some(event => event.type === 'desktop_request')).toBe(true)
    expect(events.some(event => event.type === 'observation')).toBe(true)
    expect(answer).toContain('已取消启动')
    const finalPlan = [...events].reverse().find(event => event.type === 'plan')?.plan
    expect(finalPlan?.status).toBe('cancelled')
    expect(finalPlan?.steps[0]?.status).toBe('skipped')
  })

  it('does not claim a desktop launch succeeded when the bridge wraps a failure', async () => {
    const engine = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), { checkpointPath: ':memory:', enablePlanning: false })
    const answer = await engine.execute('打开记事本', 'failed-launch', event => {
      if (event.type === 'desktop_request' && event.toolId) {
        resolveDesktopActionResult(event.toolId, { ok: true, result: { ok: false, error: 'LAUNCH_FAILED', message: '程序未找到' } })
      }
    })
    expect(answer).toContain('未能启动')
    expect(answer).not.toContain('已请求桌面端启动')
    expect((await engine.getTaskSnapshot('failed-launch')).status).toBe('failed')
  })

  it('tracks file entities returned by tools', async () => {
    const testFile = path.join(tmpDir, 'test.txt')
    await fs.writeFile(testFile, 'hello')
    const model = new FakeToolCallingModel({
      toolCalls: [[{ id: 'call_1', name: 'list_files', args: { path: tmpDir } }], []],
    })
    const engine = new AgentEngine(model, memory, store.asRetriever(5), { checkpointPath: ':memory:', enablePlanning: false })
    await engine.execute('列出目录文件', 'session')
    expect((await memory.getLastEntity('session', 'file'))?.value).toBe(testFile)
  })

  it('resolves follow-up file references before invoking the model', async () => {
    await memory.trackEntity('session', { type: 'file', ref: 'last_result', value: 'D:/docs/a.pdf', mentioned_at: new Date().toISOString() })
    const engine = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), { checkpointPath: ':memory:', enablePlanning: false })
    const answer = await engine.execute('打开那个文件', 'session')
    expect(answer).toContain('D:/docs/a.pdf')
  })

  it('pauses at a protected action and resumes from the LangGraph checkpoint after approval', async () => {
    const target = path.join(tmpDir, 'approved-folder')
    const toolCall = { id: 'call_create', name: 'create_folder', args: { parent_dir: tmpDir, folder_name: 'approved-folder' } }
    const model = new FakeToolCallingModel({ toolCalls: [[toolCall], [toolCall], []] })
    const engine = new AgentEngine(model, memory, store.asRetriever(5), { checkpointPath: ':memory:', enablePlanning: false })

    const paused = await engine.execute('写入文件', 'approval-session')
    expect(paused).toContain('暂停')
    const pending = listPendingActions().find((item: any) => item.sessionId === 'approval-session') as any
    expect(pending).toMatchObject({ status: 'pending', taskId: expect.any(String) })
    expect((await engine.getTaskSnapshot('approval-session')).status).toBe('paused')

    const approved = await confirmAction(pending.id)
    expect(approved).toMatchObject({ ok: true })
    const answer = await engine.resumeTask('approval-session', { approved: true, result: approved })

    expect(answer).not.toContain('暂停')
    await expect(fs.stat(target)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
    const completed = await engine.getTaskSnapshot('approval-session')
    expect(completed.status).toBe('completed')
    expect(completed.plan?.steps[0].status).toBe('completed')
  })

  it('reports a confirmed single Word creation as complete despite invalid extra attempts', async () => {
    const target = path.join(tmpDir, '实验1.docx')
    const invalidCall = { id: 'bad-docx', name: 'create_docx', args: { path: path.join(tmpDir, '实验1'), content: '测试内容' } }
    const validCall = { id: 'good-docx', name: 'create_docx', args: { path: target, content: '测试内容' } }
    const model = new FakeToolCallingModel({ toolCalls: [
      [invalidCall], [validCall], [validCall], [invalidCall], [],
    ] })
    const engine = new AgentEngine(model, memory, store.asRetriever(5), { checkpointPath: ':memory:' })
    const paused = await engine.execute('创建一个 Word 文档，命名为实验1', 'docx-recovery')
    expect(paused).toContain('暂停')
    const pending = listPendingActions().find((item: any) => item.sessionId === 'docx-recovery') as any
    expect(pending).toMatchObject({ name: 'create_docx', target })

    const approved = await confirmAction(pending.id)
    expect(approved).toMatchObject({ ok: true })
    const answer = await engine.resumeTask('docx-recovery', { approved: true, result: approved })

    expect(answer).toContain('已创建 Word 文档')
    expect(answer).toContain(target)
    const snapshot = await engine.getTaskSnapshot('docx-recovery')
    expect(snapshot.status).toBe('completed')
    expect(snapshot.plan?.steps.some(step => step.tool === 'create_docx' && step.status === 'completed')).toBe(true)
    expect(snapshot.plan?.steps.filter(step => step.tool === 'create_docx' && step.status === 'failed')).toEqual([])
    expect(snapshot.plan?.steps.filter(step => step.tool === 'create_docx' && step.status === 'skipped').length).toBeGreaterThan(0)
    await expect(fs.stat(target)).resolves.toMatchObject({ isFile: expect.any(Function) })
  })

  it('loads completed task state from a new engine instance using the SQLite checkpointer', async () => {
    const dbPath = path.join(tmpDir, 'checkpoints.sqlite')
    const firstSaver = SqliteSaver.fromConnString(dbPath)
    const first = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), { checkpointer: firstSaver, enablePlanning: false })
    await first.execute('持久化这个任务', 'durable-session')
    firstSaver.db.close()

    const secondSaver = SqliteSaver.fromConnString(dbPath)
    try {
      const second = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), { checkpointer: secondSaver, enablePlanning: false })
      const snapshot = await second.getTaskSnapshot('durable-session')
      expect(snapshot).toMatchObject({ status: 'completed', sessionId: 'durable-session', taskId: expect.any(String) })
      expect(snapshot.answer).toContain('持久化这个任务')
    } finally {
      secondSaver.db.close()
    }
  })

  it('resumes a protected file action from a new engine after a simulated restart', async () => {
    const dbPath = path.join(tmpDir, 'approval-restart.sqlite')
    const target = path.join(tmpDir, 'after-restart')
    const toolCall = { id: 'restart-create', name: 'create_folder', args: { parent_dir: tmpDir, folder_name: 'after-restart' } }
    const firstSaver = SqliteSaver.fromConnString(dbPath)
    const first = new AgentEngine(new FakeToolCallingModel({ toolCalls: [[toolCall], [toolCall], []] }), memory, store.asRetriever(5), { checkpointer: firstSaver })
    const paused = await first.execute('创建一个测试文件夹', 'approval-restart')
    expect(paused).toContain('暂停')
    const pending = listPendingActions().find((item: any) => item.sessionId === 'approval-restart') as any
    expect(pending).toMatchObject({ status: 'pending', name: 'create_folder' })
    firstSaver.db.close()

    const secondSaver = SqliteSaver.fromConnString(dbPath)
    try {
      const second = new AgentEngine(new FakeToolCallingModel({ toolCalls: [[toolCall], [toolCall], []] }), memory, store.asRetriever(5), { checkpointer: secondSaver })
      expect((await second.getTaskSnapshot('approval-restart')).status).toBe('paused')
      const approved = await confirmAction(pending.id)
      const answer = await second.resumeTask('approval-restart', { approved: true, result: approved })
      expect(answer).not.toContain('暂停')
      expect((await second.getTaskSnapshot('approval-restart')).status).toBe('completed')
      await expect(fs.stat(target)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
    } finally {
      secondSaver.db.close()
    }
  })

  it('resumes an interrupted task safely after the user rejects the action', async () => {
    const target = path.join(tmpDir, 'rejected-folder')
    const toolCall = { id: 'call_reject', name: 'create_folder', args: { parent_dir: tmpDir, folder_name: 'rejected-folder' } }
    const model = new FakeToolCallingModel({ toolCalls: [[toolCall], [toolCall], []] })
    const engine = new AgentEngine(model, memory, store.asRetriever(5), { checkpointPath: ':memory:', enablePlanning: false })

    await engine.execute('尝试创建文件夹', 'reject-session')
    const pending = listPendingActions().find((item: any) => item.sessionId === 'reject-session') as any
    const rejected = await rejectAction(pending.id)
    const answer = await engine.resumeTask('reject-session', { approved: false, result: rejected })

    expect(answer).not.toContain('暂停')
    await expect(fs.access(target)).rejects.toThrow()
    expect((await engine.getTaskSnapshot('reject-session')).status).toBe('cancelled')
  })

  it('routes explicit complex work through the Deep Agents execution node', async () => {
    const engine = new AgentEngine(new FakeToolCallingModel(), memory, store.asRetriever(5), {
      checkpointPath: ':memory:',
      enablePlanning: false,
      enableDeepAgent: true,
    })
    const events: any[] = []
    const answer = await engine.execute('请做一次多来源深度调研', 'deep-session', event => { events.push(event) })

    expect(answer).toContain('请做一次多来源深度调研')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thought', content: expect.stringContaining('Deep Agents') }),
    ]))
    expect((await engine.getTaskSnapshot('deep-session')).status).toBe('completed')
  })
})
