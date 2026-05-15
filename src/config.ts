import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '',
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  llmModel: process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',

  // Chunking: Chinese-optimal sizes (~500 chars ≈ 256 tokens)
  chunkSize: parseInt(process.env.CHUNK_SIZE || '500', 10),
  chunkOverlap: parseInt(process.env.CHUNK_OVERLAP || '100', 10),
  topK: parseInt(process.env.TOP_K || '5', 10),

  // Safety limits
  maxFileSize: 10 * 1024 * 1024, // 10MB per file
  maxDepth: 5,                     // max directory recursion
  maxQuestionLength: 2000,         // max question chars
  maxHistoryChars: 2000,           // max history chars in prompt
  maxContextChars: parseInt(process.env.MAX_CONTEXT_CHARS || '8000', 10), // max context chars in prompt

  // Search
  searchEngine: process.env.SEARCH_ENGINE || 'auto', // 'auto' | 'bing' | 'duckduckgo'

  // Server
  serverPort: parseInt(process.env.SERVER_PORT || '3000', 10),

  // Paths
  dataDir: path.join(ROOT, 'data'),
  chatHistoryDir: path.join(ROOT, 'chat-history'),
  metadataFile: path.join(ROOT, 'data', 'metadata.json'),
} as const
