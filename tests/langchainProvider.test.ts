import { describe, it, expect } from 'vitest'
import { ChatOpenAI } from '@langchain/openai'
import { createLangChainModel } from '../src/providers/langchain.js'

describe('LangChain model factory', () => {
  it('creates the official ChatOpenAI integration for OpenAI-compatible providers', () => {
    const model = createLangChainModel({
      provider: 'ollama',
      apiKey: 'ollama',
      baseURL: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
    })
    expect(model).toBeInstanceOf(ChatOpenAI)
    expect(model.model).toBe('qwen2.5:7b')
  })
})
