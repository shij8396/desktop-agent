import Anthropic from '@anthropic-ai/sdk'
import { config } from './config.js'
import { ingestPath, type Chunk } from './document.js'
import { VectorStore } from './vectorStore.js'
import { Memory } from './memory.js'
import { createLogger } from './logger.js'
import { CORE_TOOLS, FILE_TOOLS, TOOLS, executeTool, setAgentRef } from './tools.js'

const log = createLogger('ragAgent')

const MAX_TOOL_ROUNDS = 5

const SYSTEM_PROMPT = `你是一个简洁可靠的桌面 AI 助手。

优先直接回答用户问题，不要为了闲聊、常识、翻译、简单编程解释或简单计算而调用工具。

只有在下面场景调用工具：
- 用户明确要求联网搜索、最新新闻、股价、天气等实时信息
- 用户明确要求读取、写入、查找、导入本地文件
- 用户的问题明显需要查询本地知识库

回答要求：
- 使用用户提问的语言
- 简洁、直接、可执行
- 如果使用了工具，说明结果来源和关键限制
- 不要编造文件内容、搜索结果或系统状态`

const FORCE_WEB_SUFFIX = `\n\n[重要指令] 用户要求联网搜索。你必须先调用 web_search 工具获取最新信息，再基于搜索结果回答。不要只依赖内置知识。`

const FILE_KEYWORDS = /读|写|打开|删除|查找|搜索文件|列目录|目录|文件|磁盘|导入|剪贴板|file|read|write|open|delete|list|find|disk|ingest|clipboard/i

function selectTools(question: string): Anthropic.Tool[] {
  if (FILE_KEYWORDS.test(question)) return TOOLS
  return CORE_TOOLS
}

export interface RagAgentDeps {
  client?: Anthropic
  store?: VectorStore
  memory?: Memory
}

export class RagAgent {
  private store: VectorStore
  private memory: Memory
  private client: Anthropic
  private initialized = false

  constructor(deps?: RagAgentDeps) {
    this.store = deps?.store ?? new VectorStore()
    this.memory = deps?.memory ?? new Memory()
    if (deps?.client) {
      this.client = deps.client
    } else {
      if (!config.anthropicApiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is required')
      }
      this.client = new Anthropic({
        apiKey: config.anthropicApiKey,
        baseURL: config.anthropicBaseUrl,
      })
    }

    setAgentRef({
      ingest: (paths) => this.ingest(paths),
      searchInKb: (query) => this.searchInKb(query),
    })
  }

  async init(): Promise<void> {
    if (this.initialized) return
    const loaded = await this.store.load()
    if (loaded) {
      log.info('Loaded existing index', { chunks: this.store.size() })
    }
    this.initialized = true
  }

  async ingest(docPaths: string[]): Promise<number> {
    const allChunks: Chunk[] = []
    for (const docPath of docPaths) {
      try {
        const chunks = await ingestPath(docPath)
        for (const source of new Set(chunks.map(chunk => chunk.source))) {
          this.store.removeBySource(source)
        }
        allChunks.push(...chunks)
        log.info('Ingested path', { path: docPath, chunks: chunks.length })
      } catch (error) {
        log.warn('Skipping path', { path: docPath, error: error instanceof Error ? error.message : String(error) })
      }
    }

    if (allChunks.length === 0) {
      log.info('No documents found to ingest')
      return 0
    }

    for (const chunk of allChunks) {
      this.store.add(chunk.id, chunk.text, chunk.source, chunk.chunkIndex)
    }

    await this.store.save()
    log.info('Ingestion complete', { ingested: allChunks.length, total: this.store.size() })
    return allChunks.length
  }

  searchInKb(query: string): string {
    if (this.store.size() === 0) return 'Knowledge base is empty. No documents have been ingested yet.'

    const results = this.store.searchByText(query, 5)
    if (results.length === 0) return 'No relevant documents found in the knowledge base.'

    return results.map((r, i) =>
      `[${i + 1}] (score: ${r.score.toFixed(2)}) ${r.source}\n${r.text.slice(0, 300)}`
    ).join('\n\n')
  }

  private async buildUserMessage(question: string, sessionId: string): Promise<string> {
    const history = await this.memory.getHistory(sessionId)
    const recent = history.slice(-6)
    let historyText = ''
    for (const m of recent) {
      const line = `${m.role === 'user' ? '用户' : '助手'}: ${m.content}\n`
      historyText += line
    }

    return `${historyText ? `对话历史：\n${historyText}\n` : ''}用户问题：${question}`
  }

  private buildUserContent(userMessage: string, screenshot?: string): Anthropic.ContentBlockParam[] {
    return screenshot
      ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } },
          { type: 'text', text: userMessage },
        ]
      : [{ type: 'text', text: userMessage }]
  }

  async query(question: string, sessionId: string = 'default', forceWeb: boolean = false, screenshot?: string): Promise<string> {
    if (question.length > config.maxQuestionLength) {
      return `问题过长，最多 ${config.maxQuestionLength} 个字符，请缩短后重试。`
    }

    const userMessage = await this.buildUserMessage(question, sessionId)
    const systemPrompt = forceWeb ? SYSTEM_PROMPT + FORCE_WEB_SUFFIX : SYSTEM_PROMPT
    const selectedTools = forceWeb ? TOOLS : selectTools(question)

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: this.buildUserContent(userMessage, screenshot) },
    ]

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.client.messages.create({
        model: config.llmModel,
        max_tokens: 2048,
        system: systemPrompt,
        messages,
        tools: selectedTools,
      })

      messages.push({ role: 'assistant', content: response.content })

      if (response.stop_reason === 'tool_use') {
        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of response.content) {
          if (block.type === 'tool_use') {
            log.debug('Tool call', { name: block.name, id: block.id })
            const result = await executeTool(block.name, block.input as Record<string, unknown>)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result,
            })
          }
        }

        messages.push({ role: 'user', content: toolResults })
        continue
      }

      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text')
      const answer = textBlocks.map(b => b.text).join('')

      await this.memory.addMessage(sessionId, 'user', question)
      await this.memory.addMessage(sessionId, 'assistant', answer)

      return answer
    }

    return '已达到最大工具调用轮数，无法完成请求。'
  }

  async *queryStream(question: string, sessionId: string = 'default', forceWeb: boolean = false, screenshot?: string): AsyncGenerator<string> {
    if (question.length > config.maxQuestionLength) {
      yield JSON.stringify({ token: `问题过长，最多 ${config.maxQuestionLength} 个字符，请缩短后重试。` })
      return
    }

    const userMessage = await this.buildUserMessage(question, sessionId)
    const systemPrompt = forceWeb ? SYSTEM_PROMPT + FORCE_WEB_SUFFIX : SYSTEM_PROMPT
    const selectedTools = forceWeb ? TOOLS : selectTools(question)

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: this.buildUserContent(userMessage, screenshot) },
    ]

    let fullAnswer = ''

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = this.client.messages.stream({
        model: config.llmModel,
        max_tokens: 2048,
        system: systemPrompt,
        messages,
        tools: selectedTools,
      })

      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          yield JSON.stringify({
            tool: event.content_block.name,
            toolId: event.content_block.id,
            input: event.content_block.input,
          })
        }

        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullAnswer += event.delta.text
          yield JSON.stringify({ token: event.delta.text })
        }
      }

      const finalMessage = await stream.finalMessage()
      messages.push({ role: 'assistant', content: finalMessage.content })

      if (finalMessage.stop_reason === 'tool_use') {
        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of finalMessage.content) {
          if (block.type === 'tool_use') {
            log.debug('Tool call', { name: block.name, id: block.id })
            const result = await executeTool(block.name, block.input as Record<string, unknown>)

            yield JSON.stringify({
              toolResult: block.name,
              toolId: block.id,
              result: result.slice(0, 500),
            })

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result,
            })
          }
        }

        messages.push({ role: 'user', content: toolResults })
        continue
      }

      await this.memory.addMessage(sessionId, 'user', question)
      await this.memory.addMessage(sessionId, 'assistant', fullAnswer)
      return
    }

    yield JSON.stringify({ token: '已达到最大工具调用轮数，无法完成请求。' })
  }

  searchKbDirect(query: string): string {
    return this.searchInKb(query)
  }

  getStatus(): { chunkCount: number; sources: string[] } {
    return {
      chunkCount: this.store.size(),
      sources: this.store.getSources(),
    }
  }

  getMemory(): Memory {
    return this.memory
  }
}
