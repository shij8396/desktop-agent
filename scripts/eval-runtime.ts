/** Read-only synthetic end-to-end evaluation against the configured model. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { config, getConfigStatus } from '../src/config.js'
import { createLangChainModel } from '../src/providers/langchain.js'
import { AgentEngine } from '../src/agent/engine.js'
import { Memory } from '../src/memory.js'
import { VectorStore } from '../src/vectorStore.js'
import { executeTool } from '../src/tools.js'

if (!getConfigStatus().configured) throw new Error('No model configured; runtime evaluation was not run')
const isOllama = config.llmProvider === 'ollama'
const model = createLangChainModel({
  provider: config.llmProvider,
  model: isOllama ? config.ollamaModel : config.llmModel,
  baseURL: isOllama ? `${config.ollamaBaseUrl.replace(/\/$/, '')}/v1` : config.openaiBaseUrl,
  apiKey: isOllama ? 'ollama' : config.openaiApiKey,
})
const temporary = await mkdtemp(join(tmpdir(), 'rag-agent-eval-'))
const safeRoot = resolve(tmpdir())
if (!resolve(temporary).startsWith(`${safeRoot}\\`) && !resolve(temporary).startsWith(`${safeRoot}/`)) throw new Error('Unexpected evaluation temp path')
try {
  const store = new VectorStore(join(temporary, 'vectors.json'))
  store.add('aurora-1', 'Aurora 项目的发布日期是 2025 年 4 月 3 日。', 'aurora.md', 0)
  const engine = new AgentEngine(model, new Memory(join(temporary, 'history')), store.asRetriever(3), {
    checkpointPath: ':memory:', enableDeepAgent: false,
  })
  const cases: Array<{ question: string; requiredTools: string[]; expected: RegExp }> = [
    { question: '现在几点？', requiredTools: ['get_datetime'], expected: /\d{1,2}[:：]\d{2}|年|月|日/ },
    { question: '计算 17 乘以 23', requiredTools: ['calculate'], expected: /391/ },
    { question: '根据本地知识库，Aurora 项目的发布日期是什么？请标出来源。', requiredTools: ['kb_search'], expected: /2025.*4.*3[\s\S]*aurora\.md|aurora\.md[\s\S]*2025.*4.*3/i },
    { question: '本地知识库里有量子纠缠资料吗？', requiredTools: ['kb_search'], expected: /没有|未检索到|无相关|不足|不包含/ },
  ]
  if (process.argv.includes('--travel')) cases.push({
    question: '我想国庆节去开封旅游，请结合当前日期与联网信息给出有来源的攻略。',
    requiredTools: ['get_datetime', 'web_search'],
    expected: /开封|无法联网核实/,
  })
  let passed = 0
  for (const [index, item] of cases.entries()) {
    const usedTools: string[] = []
    let finalStatus = ''
    const answer = await engine.execute(item.question, `eval-${index + 1}`, event => {
      if (event.type === 'action' && event.tool) usedTools.push(event.tool)
      if (event.type === 'plan' && event.plan) finalStatus = event.plan.status
    })
    const ok = item.requiredTools.every(tool => usedTools.includes(tool)) && item.expected.test(answer) && finalStatus === 'completed'
    if (ok) passed++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${index + 1}: status=${finalStatus || 'unknown'} tools=${usedTools.join(',') || 'none'} answer=${answer.slice(0, 300)}`)
  }
  console.log(`Synthetic runtime score: ${passed}/${cases.length}`)
  if (passed !== cases.length) process.exitCode = 1
} finally {
  await executeTool('browser_close', {}).catch(() => {})
  await rm(temporary, { recursive: true, force: true })
}
