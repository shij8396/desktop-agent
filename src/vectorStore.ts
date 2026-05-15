import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { buildDocStats, bm25Score, charOverlapScore, type DocumentStats } from './embedding.js'
import { createLogger } from './logger.js'

const log = createLogger('vectorStore')

export interface Entry {
  id: string
  text: string
  source: string
  chunkIndex: number
}

export interface SearchResult {
  id: string
  text: string
  source: string
  chunkIndex: number
  score: number
  matchedByBm25: boolean
}

export class VectorStore {
  private entries: Entry[] = []
  private stats: DocumentStats | null = null
  private metadataFile: string

  constructor(metadataFile?: string) {
    this.metadataFile = metadataFile ?? config.metadataFile
  }

  add(id: string, text: string, source: string, chunkIndex: number): void {
    const existing = this.entries.findIndex(e => e.id === id)
    if (existing >= 0) {
      this.entries[existing] = { id, text, source, chunkIndex }
    } else {
      this.entries.push({ id, text, source, chunkIndex })
    }
    this.stats = null
  }

  removeBySource(source: string): void {
    this.entries = this.entries.filter(e => e.source !== source)
    this.stats = null
  }

  private buildStats(): DocumentStats {
    if (!this.stats) {
      this.stats = buildDocStats(this.entries.map(e => e.text))
    }
    return this.stats
  }

  searchByText(query: string, topK: number = config.topK): SearchResult[] {
    if (this.entries.length === 0) return []

    const stats = this.buildStats()

    const scored = this.entries.map(entry => ({
      id: entry.id,
      text: entry.text,
      source: entry.source,
      chunkIndex: entry.chunkIndex,
      score: bm25Score(query, entry.text, stats),
      matchedByBm25: true,
    }))

    // If BM25 found no matches at all, fall back to character overlap
    const hasAnyBm25Match = scored.some(s => s.score > 0)
    if (!hasAnyBm25Match) {
      for (const s of scored) {
        s.score = charOverlapScore(query, s.text) * 0.5
        s.matchedByBm25 = false
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }

  size(): number {
    return this.entries.length
  }

  getSources(): string[] {
    return [...new Set(this.entries.map(e => e.source))]
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.metadataFile), { recursive: true })
    const data = this.entries.map(e => ({
      id: e.id,
      text: e.text,
      source: e.source,
      chunkIndex: e.chunkIndex,
    }))
    // Atomic write: write to temp file, then rename
    const tmpFile = this.metadataFile + '.tmp'
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2))
    await fs.rename(tmpFile, this.metadataFile)
  }

  async load(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.metadataFile, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        log.warn('metadata.json is not an array, ignoring')
        return false
      }
      this.entries = parsed.filter((e: unknown): e is Entry => {
        return typeof e === 'object' && e !== null &&
          'id' in e && 'text' in e && 'source' in e && 'chunkIndex' in e
      })
      return true
    } catch (error) {
      if (error instanceof SyntaxError) {
        log.warn('Corrupted metadata.json, ignoring')
      }
      return false
    }
  }

}
