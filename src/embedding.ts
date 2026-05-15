// BM25 text retrieval with lightweight Chinese tokenization.
// This keeps the app fully local and avoids downloading embedding models.

export interface DocumentStats {
  docCount: number
  avgDocLength: number
  termDocFreq: Map<string, number>
}

const CJK_REGEX = /[\u3400-\u9fff]/
const TOKEN_CHAR_REGEX = /[\u3400-\u9fffA-Za-z0-9]/

const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都',
  '一', '一个', '也', '很', '到', '说', '要', '去', '你', '会',
  '着', '看', '好', '这', '他', '她', '它', '们', '那',
])

function tokenize(text: string): string[] {
  const tokens: string[] = []
  const normalized = text.toLowerCase().replace(/\s+/g, ' ')
  const chars = [...normalized]

  for (let i = 0; i < chars.length; i++) {
    if (!CJK_REGEX.test(chars[i])) continue

    if (i + 1 < chars.length && CJK_REGEX.test(chars[i + 1])) {
      const bigram = chars[i] + chars[i + 1]
      if (!STOP_WORDS.has(bigram)) tokens.push(bigram)
    }

    if (i + 2 < chars.length && CJK_REGEX.test(chars[i + 1]) && CJK_REGEX.test(chars[i + 2])) {
      tokens.push(chars[i] + chars[i + 1] + chars[i + 2])
    }
  }

  const words = normalized
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0)

  for (const word of words) {
    if (/[a-zA-Z0-9]/.test(word)) tokens.push(word)
  }

  return tokens
}

const K1 = 1.5
const B = 0.75

export function buildDocStats(docs: string[]): DocumentStats {
  const termDocFreq = new Map<string, number>()
  let totalLength = 0

  for (const doc of docs) {
    const tokens = tokenize(doc)
    totalLength += tokens.length
    const seen = new Set<string>()
    for (const token of tokens) {
      if (!seen.has(token)) {
        seen.add(token)
        termDocFreq.set(token, (termDocFreq.get(token) || 0) + 1)
      }
    }
  }

  return {
    docCount: docs.length,
    avgDocLength: docs.length > 0 ? totalLength / docs.length : 1,
    termDocFreq,
  }
}

function termFrequency(term: string, docTokens: string[]): number {
  let count = 0
  for (const token of docTokens) {
    if (token === term) count++
  }
  return count
}

export function bm25Score(query: string, doc: string, stats: DocumentStats): number {
  const queryTokens = tokenize(query)
  const docTokens = tokenize(doc)
  const docLength = docTokens.length
  const avgLen = stats.avgDocLength || 1

  let score = 0
  const seen = new Set<string>()

  for (const term of queryTokens) {
    if (seen.has(term)) continue
    seen.add(term)

    const tf = termFrequency(term, docTokens)
    if (tf === 0) continue

    const df = stats.termDocFreq.get(term) || 0
    const idf = Math.log((stats.docCount - df + 0.5) / (df + 0.5) + 1)

    const numerator = tf * (K1 + 1)
    const denominator = tf + K1 * (1 - B + B * (docLength / avgLen))

    score += idf * (numerator / denominator)
  }

  return score
}

export function charOverlapScore(query: string, doc: string): number {
  const queryChars = new Set([...query.toLowerCase()].filter(c => TOKEN_CHAR_REGEX.test(c)))
  if (queryChars.size === 0) return 0

  const docChars = new Set([...doc.toLowerCase()].filter(c => TOKEN_CHAR_REGEX.test(c)))

  let matches = 0
  for (const ch of queryChars) {
    if (docChars.has(ch)) matches++
  }

  return matches / queryChars.size
}
