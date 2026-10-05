import { ChatOpenAI } from '@langchain/openai'
import type { LlmProvider } from '../config.js'

export interface LangChainModelOptions {
  provider: LlmProvider
  apiKey: string
  baseURL?: string
  model: string
}

/** Build the LangChain chat model used by chains and createAgent. */
export function createLangChainModel(options: LangChainModelOptions): ChatOpenAI {
  return new ChatOpenAI({
    model: options.model,
    apiKey: options.apiKey || (options.provider === 'ollama' ? 'ollama' : 'missing-key'),
    temperature: 0.2,
    maxRetries: 2,
    configuration: options.baseURL ? { baseURL: options.baseURL } : undefined,
    // One chat-completions path works across OpenAI, DeepSeek and Ollama.
    useResponsesApi: false,
  })
}
