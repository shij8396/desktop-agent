import { describe, expect, it } from 'vitest'
import { decideShortReply, extractOfferedChoices } from '../src/agent/dialogue.js'

describe('grounded short replies', () => {
  it('asks which action when an affirmative follows two choices', () => {
    const pending = extractOfferedChoices('需要我帮你打开文章，还是导出 Word 文档？')
    expect(pending?.options).toEqual(['打开文章', '导出 Word 文档'])
    expect(decideShortReply('需要', pending)).toMatchObject({ kind: 'clarify', pendingChoice: pending })
  })

  it('resolves an ordinal to exactly the offered choice', () => {
    const pending = extractOfferedChoices('你想让我做哪一项？\n1. 打开原文\n2. 导出 Word\n回复“第一个”即可。')
    expect(pending?.options).toEqual(['打开原文', '导出 Word'])
    expect(decideShortReply('第一个', pending)).toMatchObject({ kind: 'execute', question: expect.stringContaining('打开原文') })
  })

  it('continues one explicit offer and cancels without a tool call', () => {
    const pending = extractOfferedChoices('需要我打开记事本吗？')
    expect(pending?.options).toEqual(['打开记事本'])
    expect(decideShortReply('好', pending)).toMatchObject({ kind: 'execute', question: expect.stringContaining('打开记事本') })
    expect(decideShortReply('不要', pending)).toMatchObject({ kind: 'cancel' })
  })

  it('does not invent options from an open question', () => {
    expect(extractOfferedChoices('你希望我怎么帮你？')).toBeUndefined()
    expect(decideShortReply('需要')).toMatchObject({ kind: 'clarify' })
    expect(decideShortReply('继续')).toMatchObject({ kind: 'pass' })
  })

  it('recognizes an offered pair even when it ends as a statement', () => {
    const pending = extractOfferedChoices('如果需要，我可以帮你打开文章或导出 Word 文档。')
    expect(pending?.options).toEqual(['打开文章', '导出 Word 文档'])
    expect(decideShortReply('继续', pending)).toMatchObject({ kind: 'clarify' })
  })
})
