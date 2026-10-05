/** Records only source identifiers from successful tool calls, never retrieved page text. */
export interface SourceEvidence {
  kind: 'search' | 'visited' | 'page' | 'document'
  source: string
}

export function collectSourceEvidence(toolName: string, result: unknown): SourceEvidence[] {
  if (toolName === 'kb_search') {
    const text = String(result)
    if (text.startsWith('知识库未检索到')) return []
    return [...text.matchAll(/来源：([^；\n]+)/gu)]
      .map(match => match[1].trim())
      .filter(source => source && source !== 'unknown')
      .slice(0, 10)
      .map(source => ({ kind: 'document' as const, source }))
  }
  let parsed: any
  try { parsed = typeof result === 'string' ? JSON.parse(result) : result } catch { return [] }
  if (!parsed || parsed.ok !== true) return []
  if (toolName === 'web_search') {
    return (Array.isArray(parsed.results) ? parsed.results : [])
      .map((item: any) => safeWebUrl(item?.url))
      .filter((source: string | null): source is string => source !== null)
      .slice(0, 10)
      .map((source: string) => ({ kind: 'search' as const, source }))
  }
  if (toolName === 'browser_open') {
    const source = safeWebUrl(parsed.url)
    return source ? [{ kind: 'visited', source }] : []
  }
  if (toolName === 'fetch_webpage' || toolName === 'browser_extract') {
    const source = safeWebUrl(parsed.url)
    return source ? [{ kind: 'page', source }] : []
  }
  // A browser search returns the search-results page, not verified destination pages.
  if (toolName === 'browser_search') {
    const source = safeWebUrl(parsed.url)
    return source ? [{ kind: 'search', source }] : []
  }
  return []
}

export function auditAnswerSources(answer: string, evidence: SourceEvidence[]): string {
  const webEvidence = evidence.filter(item => item.kind !== 'document')
  const trusted = new Set(webEvidence.map(item => normalizeUrl(item.source)))
  const unsupported: string[] = []
  const audited = answer.replace(/https?:\/\/[^\s<>\])，。；;！!？]+/giu, match => {
    const url = match.replace(/[.,:]+$/u, '')
    const punctuation = match.slice(url.length)
    if (trusted.has(normalizeUrl(url))) return match
    unsupported.push(url)
    return `[未核实链接]${punctuation}`
  })
  const cited = [...audited.matchAll(/https?:\/\/[^\s<>\])，。；;！!？]+/giu)]
    .some(match => trusted.has(normalizeUrl(match[0].replace(/[.,:]+$/u, ''))))
  const evidenceLevel = webEvidence.some(item => item.kind === 'page') ? '含已提取页面'
    : webEvidence.some(item => item.kind === 'search') ? '仅搜索结果摘要，未核对网页正文'
      : '仅访问地址，未核对网页正文'
  const sourceNote = cited || !webEvidence.length ? '' : `\n\n检索来源（${evidenceLevel}）：${webEvidence.slice(0, 3).map(item => item.source).join('；')}`
  const warning = unsupported.length ? '\n\n注意：回答中未经工具结果证实的链接已移除；相关结论仍需人工核对。' : ''
  return audited + sourceNote + warning
}

function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch { return null }
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.href.replace(/\/$/, '')
  } catch { return value }
}
