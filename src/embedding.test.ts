import { describe, it, expect } from 'vitest'
import { buildDocStats, bm25Score, charOverlapScore } from './embedding.js'

describe('buildDocStats', () => {
  it('should count documents and compute avg length', () => {
    const stats = buildDocStats(['hello world', 'foo bar baz'])
    expect(stats.docCount).toBe(2)
    expect(stats.avgDocLength).toBeGreaterThan(0)
  })

  it('should track term document frequency', () => {
    const stats = buildDocStats(['TypeScript is great', 'TypeScript is typed'])
    expect(stats.termDocFreq.has('typescript')).toBe(true)
  })
})

describe('bm25Score', () => {
  it('should score exact matches higher than 0', () => {
    const stats = buildDocStats(['TypeScript is a typed language'])
    const score = bm25Score('TypeScript', 'TypeScript is a typed language', stats)
    expect(score).toBeGreaterThan(0)
  })

  it('should return 0 for completely irrelevant text', () => {
    const stats = buildDocStats(['hello world', 'xyz qrs'])
    const score = bm25Score('TypeScript', 'xyz qrs', stats)
    expect(score).toBe(0)
  })

  it('should handle Chinese text', () => {
    const stats = buildDocStats(['这是一个中文测试文档'])
    const score = bm25Score('中文测试', '这是一个中文测试文档', stats)
    expect(score).toBeGreaterThan(0)
  })
})

describe('charOverlapScore', () => {
  it('should return 1 for full overlap', () => {
    const score = charOverlapScore('abc', 'abcdef')
    expect(score).toBe(1)
  })

  it('should return 0 for no overlap', () => {
    const score = charOverlapScore('abc', 'xyz')
    expect(score).toBe(0)
  })

  it('should return fraction for partial overlap', () => {
    const score = charOverlapScore('abc', 'ab')
    expect(score).toBeCloseTo(2 / 3, 1)
  })
})
