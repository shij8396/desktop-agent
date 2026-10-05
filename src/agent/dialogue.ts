/** Grounded follow-up choices from the assistant's latest visible reply. */
export interface PendingChoice {
  options: string[]
  sourceAnswer: string
}

export type ShortReplyDecision =
  | { kind: 'execute'; question: string }
  | { kind: 'clarify'; answer: string; pendingChoice?: PendingChoice }
  | { kind: 'cancel'; answer: string }
  | { kind: 'pass' }

const AFFIRMATIVE = /^(?:需要|要|好的?|好呀|可以|行|是的?|对|嗯|继续|接着|麻烦了|请继续|就这样|确定|同意)[。！!，,\s]*$/u
const NEGATIVE = /^(?:不需要|不用|不要|算了|取消|先不用|别做了|停止)[。！!，,\s]*$/u
const ORDINAL = /^(?:选|就|要|选择)?\s*第([一二三四五12345])(?:个|项|种)?(?:吧|就好|即可)?[。！!，,\s]*$/u
const ORDINAL_INDEX: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 }

function cleanOption(value: string): string {
  return value.trim()
    .replace(/^[：:，,\s]+|[？?。！!；;，,\s]+$/gu, '')
    .replace(/^如果需要[，,]\s*/u, '')
    .replace(/^(?:你(?:希望|想|要)?我|你可以|需要我|要我|让我|我(?:可以|来|帮你)|是否|请|帮你|帮我|可以|要不要|想要|需要|还是|也可以)\s*/u, '')
    .replace(/^帮你/u, '')
    .replace(/(?:吗|么|呢|嘛)$/u, '')
    .replace(/^\*+|\*+$/gu, '')
    .trim()
}

function validOption(value: string): boolean {
  return value.length >= 2 && value.length <= 100
    && !/^(?:什么|怎么|如何|哪[个些]|谁|多少|继续|需要|好的?|可以)/u.test(value)
}

export function extractOfferedChoices(answer: string): PendingChoice | undefined {
  const text = answer.trim()
  if (!text || text.length > 2000) return undefined
  const numbered = [...text.matchAll(/(?:^|\n)\s*(?:[1-5][.、)）]|[①②③④⑤])\s*([^\n]+)/gu)]
    .map(match => cleanOption(match[1]))
    .filter(validOption)
  if (numbered.length >= 2) return { options: numbered.slice(0, 5), sourceAnswer: text }

  const lastClause = text.split(/[。！？!?\n]/u).map(part => part.trim()).filter(Boolean).at(-1)
  if (!lastClause || lastClause.length > 160) return undefined
  const separator = lastClause.match(/还是|或者|也可以|或|\s+or\s+/iu)
  if (separator && separator.index !== undefined) {
    const left = cleanOption(lastClause.slice(0, separator.index))
    const right = cleanOption(lastClause.slice(separator.index + separator[0].length))
    if (/(?:需要我|要我|可以帮你|我可以|你可以|请选择|选择|你想|你希望)/u.test(lastClause)
      && validOption(left) && validOption(right)) return { options: [left, right], sourceAnswer: text }
  }
  const single = cleanOption(lastClause)
  if (/[？?]\s*$/u.test(text) && /(?:需要|要不要|是否|要我|想不想|可以)/u.test(lastClause) && validOption(single)) {
    return { options: [single], sourceAnswer: text }
  }
  return undefined
}

export function decideShortReply(reply: string, pendingChoice?: PendingChoice): ShortReplyDecision {
  const short = reply.trim()
  if (short.length > 24) return { kind: 'pass' }
  const ordinal = short.match(ORDINAL)
  const affirmative = AFFIRMATIVE.test(short)
  const negative = NEGATIVE.test(short)
  if (!ordinal && !affirmative && !negative) return { kind: 'pass' }
  if (negative && pendingChoice) return { kind: 'cancel', answer: '好的，刚才提议的操作不继续执行。' }
  if (negative) return { kind: 'pass' }
  if (!pendingChoice?.options.length) {
    return short === '需要' || ordinal
      ? { kind: 'clarify', answer: '你希望我接下来具体做什么？请告诉我目标，我再继续。' }
      : { kind: 'pass' }
  }
  const index = ordinal ? ORDINAL_INDEX[ordinal[1]] : pendingChoice.options.length === 1 ? 0 : -1
  if (index >= pendingChoice.options.length) {
    return { kind: 'clarify', answer: renderClarification(pendingChoice), pendingChoice }
  }
  if (index < 0) return { kind: 'clarify', answer: renderClarification(pendingChoice), pendingChoice }
  return {
    kind: 'execute',
    question: pendingChoice.options[index],
  }
}

function renderClarification(choice: PendingChoice): string {
  return `你想让我做哪一项？\n${choice.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}\n回复“第一个”或直接说出要做的事即可。`
}
