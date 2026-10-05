import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

export type LlmProvider = 'deepseek' | 'openai' | 'ollama'

export interface UserModelSettings {
  provider: LlmProvider
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface ConfigStatus {
  configured: boolean
  source: 'user' | 'env' | 'none'
  provider: LlmProvider
  model: string
  baseUrl?: string
  hasApiKey: boolean
  webSearch: 'hosted' | 'local'
  configPath: string
  dataDir: string
  logDir: string
  langsmith: { enabled: boolean; project: string }
}

function appDataRoot(): string {
  if (process.env.RAG_PET_HOME) return process.env.RAG_PET_HOME
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'RAG Pet')
  }
  return path.join(os.homedir(), '.rag-pet')
}

// AppData\Roaming may inherit Deny-Write ACLs (from parental controls, security
// software, or sandboxed launch contexts) that block the server process from
// persisting chat history, logs and metadata. Probe writability and fall back to
// the system temp dir so the app keeps working even when AppData is read-only.
function isDirWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, '1', 'utf8')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function resolveWritableRoot(primary: string): string {
  if (isDirWritable(primary)) return primary
  const fallback = path.join(os.tmpdir(), 'RAG Pet')
  fs.mkdirSync(fallback, { recursive: true })
  return fallback
}

// CONFIG_ROOT points at AppData\Roaming\RAG Pet and holds the read-only config.json.
// WRITABLE_ROOT holds chat history, data, logs and audit — falls back to temp when
// AppData is not writable.
const CONFIG_ROOT = appDataRoot()
const WRITABLE_ROOT = resolveWritableRoot(CONFIG_ROOT)
const USER_CONFIG_FILE = process.env.RAG_PET_CONFIG || path.join(CONFIG_ROOT, 'config.json')
const DATA_DIR = process.env.RAG_PET_DATA_DIR || path.join(WRITABLE_ROOT, 'data')
const CHAT_HISTORY_DIR = process.env.RAG_PET_CHAT_DIR || path.join(WRITABLE_ROOT, 'chat-history')
const LOG_DIR = process.env.RAG_PET_LOG_DIR || path.join(WRITABLE_ROOT, 'logs')
const AUDIT_DIR = process.env.RAG_PET_AUDIT_DIR || path.join(WRITABLE_ROOT, 'audit')

function normalizeProvider(value: unknown): LlmProvider | undefined {
  return value === 'deepseek' || value === 'openai' || value === 'ollama' ? value : undefined
}

function readUserSettings(): UserModelSettings | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'))
    const provider = normalizeProvider(parsed.provider)
    if (!provider) return null
    return {
      provider,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : '',
      model: typeof parsed.model === 'string' ? parsed.model.trim() : '',
    }
  } catch {
    return null
  }
}

function envProvider(): LlmProvider | undefined {
  return normalizeProvider(process.env.LLM_PROVIDER) ||
    (process.env.DEEPSEEK_API_KEY ? 'deepseek' : undefined) ||
    (process.env.OPENAI_API_KEY ? 'openai' : undefined)
}

function defaultBaseUrl(provider: LlmProvider): string | undefined {
  if (provider === 'deepseek') return 'https://api.deepseek.com'
  if (provider === 'ollama') return 'http://localhost:11434/v1'
  return undefined
}

function defaultModel(provider: LlmProvider): string {
  if (provider === 'deepseek') return 'deepseek-chat'
  if (provider === 'openai') return 'gpt-4o-mini'
  return 'qwen2.5:7b'
}

function buildConfig() {
  const user = readUserSettings()
  const provider = user?.provider || envProvider() || 'deepseek'
  const key = user?.apiKey || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || (provider === 'ollama' ? 'ollama' : '')
  const source: ConfigStatus['source'] = user ? 'user' : envProvider() ? 'env' : 'none'

  return {
    llmProvider: provider,
    openaiApiKey: key,
    openaiBaseUrl: user?.baseUrl || process.env.OPENAI_BASE_URL || defaultBaseUrl(provider),
    llmModel: user?.model || process.env.OPENAI_MODEL || process.env.LLM_MODEL || defaultModel(provider),
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    configSource: source,

    chunkSize: parseInt(process.env.CHUNK_SIZE || '500', 10),
    chunkOverlap: parseInt(process.env.CHUNK_OVERLAP || '100', 10),
    topK: parseInt(process.env.TOP_K || '5', 10),

    maxFileSize: 10 * 1024 * 1024,
    maxDepth: 5,
    maxQuestionLength: 2000,
    maxHistoryChars: 2000,
    maxContextChars: parseInt(process.env.MAX_CONTEXT_CHARS || '8000', 10),

    searchEngine: process.env.SEARCH_ENGINE || 'auto',
    serverPort: parseInt(process.env.SERVER_PORT || '3000', 10),

    appDataDir: CONFIG_ROOT,
    configFile: USER_CONFIG_FILE,
    dataDir: DATA_DIR,
    chatHistoryDir: CHAT_HISTORY_DIR,
    logDir: LOG_DIR,
    auditDir: AUDIT_DIR,
    langsmithTracing: /^(1|true)$/i.test(process.env.LANGSMITH_TRACING || ''),
    langsmithProject: process.env.LANGSMITH_PROJECT || 'rag-agent-desktop',
    metadataFile: path.join(DATA_DIR, 'metadata.json'),
  }
}

export const config = buildConfig()

export function reloadConfig(): void {
  Object.assign(config, buildConfig())
}

export async function saveUserSettings(settings: UserModelSettings): Promise<void> {
  const provider = normalizeProvider(settings.provider)
  if (!provider) throw new Error('provider must be deepseek, openai, or ollama')
  const apiKey = settings.apiKey?.trim() || ''
  if (provider !== 'ollama' && !apiKey) throw new Error('API Key is required')

  const normalized: UserModelSettings = {
    provider,
    apiKey,
    baseUrl: settings.baseUrl?.trim() || defaultBaseUrl(provider),
    model: settings.model?.trim() || defaultModel(provider),
  }
  await fs.promises.mkdir(path.dirname(USER_CONFIG_FILE), { recursive: true })
  await fs.promises.writeFile(USER_CONFIG_FILE, JSON.stringify(normalized, null, 2), 'utf8')
  reloadConfig()
}

export async function clearUserSettings(): Promise<void> {
  try {
    await fs.promises.unlink(USER_CONFIG_FILE)
  } catch {}
  reloadConfig()
}

export function getConfigStatus(): ConfigStatus {
  const configured = config.llmProvider === 'ollama' || Boolean(config.openaiApiKey)
  return {
    configured,
    source: config.configSource,
    provider: config.llmProvider,
    model: config.llmModel,
    baseUrl: config.openaiBaseUrl,
    hasApiKey: Boolean(config.openaiApiKey),
    webSearch: 'local',
    configPath: config.configFile,
    dataDir: config.dataDir,
    logDir: config.logDir,
    langsmith: { enabled: config.langsmithTracing, project: config.langsmithProject },
  }
}

export function getDefaultSettings(provider: LlmProvider): UserModelSettings {
  return {
    provider,
    apiKey: '',
    baseUrl: defaultBaseUrl(provider),
    model: defaultModel(provider),
  }
}
