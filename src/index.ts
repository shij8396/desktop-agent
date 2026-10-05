import 'dotenv/config'
import readline from 'node:readline'
import { config } from './config.js'
import { RagAgent } from './ragAgent.js'

const SESSION_ID = 'default'

function createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
}

let rlClosed = false

function prompt(rl: readline.Interface, text: string): Promise<string | null> {
  if (rlClosed) return Promise.resolve(null)
  return new Promise(resolve => {
    const onClose = () => {
      rlClosed = true
      resolve(null)
    }
    rl.once('close', onClose)
    try {
      rl.question(text, answer => {
        rl.removeListener('close', onClose)
        resolve(answer ?? null)
      })
    } catch {
      rlClosed = true
      resolve(null)
    }
  })
}

function printHelp(): void {
  console.log(`
RAG Agent - 开发调试 CLI

Commands:
  ingest <path>     导入文件或目录到知识库
  ask <question>    基于模型、知识库和必要工具回答
  web <question>    强制联网搜索后回答
  search <keyword>  直接搜索本地知识库，不调用模型
  status            查看知识库状态
  history           查看当前会话历史
  clear             清空当前会话历史
  sessions          列出会话
  help              显示帮助
  exit              退出
也可以直接输入问题开始对话。`)
}

async function main(): Promise<void> {
  if (config.llmProvider === 'openai' && !config.openaiApiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is required.')
    console.error('Create a .env file from .env.example and set OPENAI_API_KEY.')
    process.exit(1)
  }

  const agent = new RagAgent()
  await agent.init()

  printHelp()

  const rl = createRl()

  while (!rlClosed) {
    const input = await prompt(rl, '\n> ')
    if (input === null) {
      process.exit(0)
    }
    const trimmed = input.trim()
    if (!trimmed) continue

    const [cmd, ...args] = trimmed.split(/\s+/)

    try {
      switch (cmd) {
        case 'ingest': {
          if (args.length === 0) {
            console.log('Usage: ingest <file-or-directory-path>')
            break
          }
          const targetPath = args.join(' ')
          const count = await agent.ingest([targetPath])
          console.log(`Imported ${count} chunks.`)
          break
        }

        case 'ask': {
          if (args.length === 0) {
            console.log('Usage: ask <question>')
            break
          }
          const question = args.join(' ')
          console.log('Thinking...')
          const answer = await agent.query(question, SESSION_ID)
          console.log(`\n${answer}`)
          break
        }

        case 'web': {
          if (args.length === 0) {
            console.log('Usage: web <question>  (force web search)')
            break
          }
          const question = args.join(' ')
          console.log('Searching web + thinking...')
          const answer = await agent.query(question, SESSION_ID, true)
          console.log(`\n${answer}`)
          break
        }

        case 'search': {
          if (args.length === 0) {
            console.log('Usage: search <keyword>')
            break
          }
          const keyword = args.join(' ')
          console.log('Searching knowledge base...')
          console.log(agent.searchKbDirect(keyword))
          break
        }

        case 'status': {
          const status = agent.getStatus()
          console.log(`\nKnowledge base: ${status.chunkCount} chunks`)
          console.log(`Sources: ${status.sources.length > 0 ? status.sources.join(', ') : '(none)'}`)
          break
        }

        case 'history': {
          const history = await agent.getMemory().getHistory(SESSION_ID)
          if (history.length === 0) {
            console.log('No conversation history.')
          } else {
            console.log('\n--- Conversation History ---')
            for (const msg of history) {
              const prefix = msg.role === 'user' ? '[You]' : '[Agent]'
              console.log(`${prefix} ${msg.content}`)
            }
          }
          break
        }

        case 'clear': {
          await agent.getMemory().clearHistory(SESSION_ID)
          console.log('Conversation history cleared.')
          break
        }

        case 'sessions': {
          const sessions = await agent.getMemory().listSessions()
          console.log(sessions.length === 0 ? 'No sessions found.' : `Sessions: ${sessions.join(', ')}`)
          break
        }

        case 'help': {
          printHelp()
          break
        }

        case 'exit': {
          console.log('Goodbye!')
          rl.close()
          return
        }

        default: {
          console.log('Thinking...')
          const answer = await agent.query(trimmed, SESSION_ID)
          console.log(`\n${answer}`)
          break
        }
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error)
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
