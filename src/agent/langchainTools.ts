import { tool } from 'langchain'
import { randomUUID } from 'node:crypto'
import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables'
import type { BaseRetriever } from '@langchain/core/retrievers'
import { interrupt } from '@langchain/langgraph'
import { executeTool, awaitDesktopActionResult, TOOLS, type ToolDefinition } from '../tools.js'
import type { Memory } from '../memory.js'
import type { AgentEventCallback } from './types.js'
import { createLogger } from '../logger.js'

const log = createLogger('langchain-tools')
const DESKTOP_ACTION_TIMEOUT_MS = 120000
const RETRYABLE_READ_TOOLS = new Set(['web_search', 'fetch_webpage', 'get_weather', 'list_files', 'find_files', 'read_file_content'])

export interface ToolRuntimeContext {
  callback?: AgentEventCallback
  onResult?: (toolName: string, result: string) => void
  signal?: AbortSignal
  sessionId: string
  taskId: string
  memory: Memory
  retriever: BaseRetriever
}

export function createLangChainTools(context: ToolRuntimeContext) {
  const retrievalChain = RunnableSequence.from([
    context.retriever,
    RunnableLambda.from((documents: any[]) => documents.length
      ? documents.map((doc, index) => `[${index + 1}] 来源：${doc.metadata?.source ?? 'unknown'}；片段：${doc.metadata?.chunkIndex ?? 0}\n${String(doc.pageContent).slice(0, 1600)}`).join('\n\n')
      : '知识库未检索到相关片段；当前没有可引用的本地文档依据。'),
  ])

  return TOOLS.map(definition => tool(
    async (input: Record<string, unknown>) => {
      const invocationId = randomUUID()
      context.signal?.throwIfAborted()
      await emit(context.callback, { type: 'action', content: `调用工具: ${definition.name}`, tool: definition.name, toolInput: input, invocationId })
      context.signal?.throwIfAborted()
      const result = definition.name === 'kb_search'
        ? await raceWithAbort(retrievalChain.invoke(String(input.query ?? '')), context.signal)
        : await raceWithAbort(runWithReadOnlyRetry(definition.name, () => executeWithDesktopBridge(definition, input, context, invocationId)), context.signal)
      context.signal?.throwIfAborted()
      context.onResult?.(definition.name, String(result))
      await emit(context.callback, {
        type: 'observation',
        content: String(result).slice(0, 500),
        tool: definition.name,
        invocationId,
        toolOutcome: parseToolOutcome(result),
      })
      await trackFileEntity(context.memory, context.sessionId, definition.name, String(result))
      return result
    },
    {
      name: definition.name,
      description: definition.description,
      schema: definition.input_schema as any,
    },
  ))
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('任务已取消'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('任务已取消'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

async function executeWithDesktopBridge(
  definition: ToolDefinition,
  input: Record<string, unknown>,
  context: ToolRuntimeContext,
  invocationId: string,
): Promise<string> {
  const result = await executeTool(definition.name, input, { sessionId: context.sessionId, taskId: context.taskId })
  let parsed: any
  try { parsed = JSON.parse(result) } catch { return result }
  if (parsed?.error === 'CONFIRMATION_REQUIRED' && parsed.action) {
    await emit(context.callback, {
      type: 'confirmation_required',
      content: parsed.message ?? `需要确认：${definition.name}`,
      tool: definition.name,
      invocationId,
      toolInput: input,
      action: parsed.action,
    })
    const decision = interrupt({
      type: 'confirmation_required',
      taskId: context.taskId,
      sessionId: context.sessionId,
      tool: definition.name,
      action: parsed.action,
    }) as { approved?: boolean; result?: unknown }
    if (!decision?.approved) {
      return JSON.stringify({ ok: false, error: 'ACTION_REJECTED', message: '用户拒绝了该操作。' })
    }
    return typeof decision.result === 'string' ? decision.result : JSON.stringify(decision.result ?? { ok: true })
  }
  if (parsed?.error === 'DESKTOP_REQUIRED' && typeof parsed.toolId === 'string') {
    const toolName = String(parsed.tool ?? definition.name)
    const pendingResult = awaitDesktopActionResult(parsed.toolId, DESKTOP_ACTION_TIMEOUT_MS)
    await emit(context.callback, {
      type: 'desktop_request',
      content: `需要桌面端执行: ${toolName}`,
      toolId: parsed.toolId,
      tool: toolName,
      invocationId,
      toolInput: parsed.input && typeof parsed.input === 'object' ? parsed.input : input,
    })
    return pendingResult
  }
  if (parsed?.ok === false && RETRYABLE_READ_TOOLS.has(definition.name) && isRetryable(parsed.error)) {
    throw new Error(`${parsed.error}: ${parsed.message ?? 'tool failed'}`)
  }
  return result
}

function parseToolOutcome(result: unknown): { ok: boolean; error?: string; message?: string } | undefined {
  let parsed: any
  try { parsed = typeof result === 'string' ? JSON.parse(result) : result } catch { return undefined }
  if (!parsed || typeof parsed !== 'object') return undefined
  const outcome = parsed.ok === true && parsed.result && typeof parsed.result === 'object' && parsed.result.ok === false
    ? parsed.result : parsed
  if (typeof outcome.ok !== 'boolean') return undefined
  return {
    ok: outcome.ok,
    ...(typeof outcome.error === 'string' ? { error: outcome.error } : {}),
    ...(typeof outcome.message === 'string' ? { message: outcome.message.slice(0, 300) } : {}),
  }
}

function isRetryable(error: unknown): boolean {
  return /TIMEOUT|NETWORK|ECONN|EBUSY|FILE_LOCKED/i.test(String(error ?? ''))
}

export async function runWithReadOnlyRetry<T>(toolName: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!RETRYABLE_READ_TOOLS.has(toolName) || !isRetryable(error)) throw error
    await new Promise(resolve => setTimeout(resolve, 150))
    return operation()
  }
}

async function trackFileEntity(memory: Memory, sessionId: string, toolName: string, result: string): Promise<void> {
  if (!['find_files', 'list_files', 'list_recent_files', 'read_file_content'].includes(toolName)) return
  try {
    const parsed = JSON.parse(result)
    if (parsed?.ok !== true) return
    const filePath = parsed.matches?.[0] ?? parsed.results?.[0]?.path ?? parsed.items?.[0]?.path ?? parsed.path
    if (typeof filePath === 'string') {
      await memory.trackEntity(sessionId, { type: 'file', ref: 'last_result', value: filePath, mentioned_at: new Date().toISOString() })
    }
  } catch (error) {
    log.debug('file entity tracking skipped', { error: String(error) })
  }
}

async function emit(callback: AgentEventCallback | undefined, event: Record<string, unknown>): Promise<void> {
  if (!callback) return
  await callback({
    type: event.type as any,
    content: String(event.content ?? ''),
    toolId: event.toolId as string | undefined,
    invocationId: event.invocationId as string | undefined,
    tool: event.tool as string | undefined,
    toolInput: event.toolInput as Record<string, unknown> | undefined,
    action: event.action as Record<string, unknown> | undefined,
    toolOutcome: event.toolOutcome as { ok: boolean; error?: string; message?: string } | undefined,
    timestamp: new Date().toISOString(),
  })
}
