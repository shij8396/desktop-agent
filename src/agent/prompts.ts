import { ChatPromptTemplate } from '@langchain/core/prompts'
import { StringOutputParser } from '@langchain/core/output_parsers'
import { RunnableSequence } from '@langchain/core/runnables'

export const AGENT_PROMPT = ChatPromptTemplate.fromMessages([
  ['system', '{basePrompt}\n\n{dynamicContext}'],
])

export const SUMMARY_PROMPT = ChatPromptTemplate.fromMessages([
  ['system', '你是一个对话摘要助手。只输出摘要正文，不要加标题或解释。'],
  ['human', '{conversation}'],
])

export async function renderAgentPrompt(basePrompt: string, dynamicContext: string): Promise<string> {
  const value = await AGENT_PROMPT.invoke({ basePrompt, dynamicContext })
  const message = value.toChatMessages()[0]
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

export function createSummaryChain(model: any) {
  return RunnableSequence.from([
    SUMMARY_PROMPT,
    model,
    new StringOutputParser(),
  ])
}
