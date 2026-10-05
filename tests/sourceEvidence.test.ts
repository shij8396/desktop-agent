import { describe, expect, it } from 'vitest'
import { auditAnswerSources, collectSourceEvidence } from '../src/agent/sourceEvidence.js'

describe('tool-backed source audit', () => {
  it('accepts only successful search results as source identifiers', () => {
    expect(collectSourceEvidence('web_search', JSON.stringify({ ok: true, results: [
      { url: 'https://example.org/report', title: 'Report' },
      { url: 'file:///secret', title: 'Local' },
    ] }))).toEqual([{ kind: 'search', source: 'https://example.org/report' }])
    expect(collectSourceEvidence('web_search', JSON.stringify({ ok: false, results: [{ url: 'https://fake.test' }] }))).toEqual([])
    expect(collectSourceEvidence('fetch_webpage', JSON.stringify({ ok: false, url: 'https://example.org/report' }))).toEqual([])
  })

  it('removes invented URLs and labels search-only evidence honestly', () => {
    const sources = collectSourceEvidence('web_search', JSON.stringify({ ok: true, results: [{ url: 'https://example.org/report' }] }))
    const answer = auditAnswerSources('参考 https://fake.test/data。', sources)
    expect(answer).not.toContain('https://fake.test/data')
    expect(answer).toContain('未核实链接')
    expect(answer).toContain('仅搜索结果摘要')
    expect(answer).toContain('https://example.org/report')
    expect(auditAnswerSources('参考 https://example.org/report。', sources)).not.toContain('未核实链接')
    expect(auditAnswerSources('See https://example.org/report.', sources)).not.toContain('未核实链接')
    const querySource = collectSourceEvidence('web_search', JSON.stringify({ ok: true, results: [{ url: 'https://example.org/search?q=agent' }] }))
    expect(auditAnswerSources('See https://example.org/search?q=agent.', querySource)).not.toContain('未核实链接')
  })

  it('does not invent evidence when no tool returned a source', () => {
    expect(auditAnswerSources('无法联网核实。', [])).toBe('无法联网核实。')
    expect(auditAnswerSources('参考 https://invented.test', [])).not.toContain('https://invented.test')
    expect(collectSourceEvidence('kb_search', '[1] 来源：guide.pdf；片段：2\n内容')).toEqual([
      { kind: 'document', source: 'guide.pdf' },
    ])
  })
})
