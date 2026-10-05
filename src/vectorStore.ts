import fs from 'node:fs/promises'
import path from 'node:path'
import { Document, type DocumentInterface } from '@langchain/core/documents'
import { VectorStore as LangChainVectorStore } from '@langchain/core/vectorstores'
import type { EmbeddingsInterface } from '@langchain/core/embeddings'
import { config } from './config.js'
import { bm25Score, buildDocStats, embedTextLocally, LocalHashEmbeddings, tokenize } from './embedding.js'
import { createLogger } from './logger.js'

const log = createLogger('vectorStore')

export interface Entry {
  id: string
  text: string
  source: string
  chunkIndex: number
  vector: number[]
}

export interface SearchResult {
  id: string
  text: string
  source: string
  chunkIndex: number
  score: number
  matchedByBm25: boolean
}

/**
 * Persistent local VectorStore implemented on LangChain's VectorStore contract.
 * It exposes a standard VectorStoreRetriever via asRetriever(), while retaining
 * the small compatibility surface used by the desktop app and its tests.
 */
export class VectorStore extends LangChainVectorStore {
  private entries: Entry[] = []
  private metadataFile: string

  constructor(metadataFile?: string, embeddings: EmbeddingsInterface = new LocalHashEmbeddings()) {
    super(embeddings, {})
    this.metadataFile = metadataFile ?? config.metadataFile
  }

  _vectorstoreType(): string {
    return 'rag-pet-langchain-local'
  }

  add(id: string, text: string, source: string, chunkIndex: number): void {
    this.upsert({ id, text, source, chunkIndex, vector: embedTextLocally(text) })
  }

  async addDocuments(documents: DocumentInterface[]): Promise<string[]> {
    const vectors = await this.embeddings.embedDocuments(documents.map(doc => doc.pageContent))
    return (await this.addVectors(vectors, documents)) as string[]
  }

  async addVectors(vectors: number[][], documents: DocumentInterface[]): Promise<string[]> {
    const ids: string[] = []
    documents.forEach((doc, index) => {
      const id = String(doc.id ?? doc.metadata.id ?? `${doc.metadata.source ?? 'document'}::${doc.metadata.chunkIndex ?? index}`)
      ids.push(id)
      this.upsert({
        id,
        text: doc.pageContent,
        source: String(doc.metadata.source ?? ''),
        chunkIndex: Number(doc.metadata.chunkIndex ?? index),
        vector: vectors[index] ?? embedTextLocally(doc.pageContent),
      })
    })
    return ids
  }

  async delete(params?: Record<string, any>): Promise<void> {
    const ids = Array.isArray(params?.ids) ? new Set(params.ids.map(String)) : null
    const source = typeof params?.source === 'string' ? params.source : null
    if (!ids && !source) return
    this.entries = this.entries.filter(entry => !(ids?.has(entry.id) || (source && entry.source === source)))
  }

  removeBySource(source: string): void {
    this.entries = this.entries.filter(entry => entry.source !== source)
  }

  async similaritySearchVectorWithScore(query: number[], k: number, filter?: this['FilterType']): Promise<[DocumentInterface, number][]> {
    return this.scoreVector(query, k, filter).map(result => [
      new Document({
        id: result.entry.id,
        pageContent: result.entry.text,
        metadata: { source: result.entry.source, chunkIndex: result.entry.chunkIndex, score: result.score },
      }),
      result.score,
    ])
  }

  override async similaritySearch(query: string, k = 4, filter?: this['FilterType']): Promise<DocumentInterface[]> {
    return (await this.similaritySearchWithScore(query, k, filter)).map(([document]) => document)
  }

  override async similaritySearchWithScore(query: string, k = 4, filter?: this['FilterType']): Promise<[DocumentInterface, number][]> {
    const vector = await this.embeddings.embedQuery(query)
    return this.hybridSearch(query, vector, k, filter).map(({ entry, score }) => [
      new Document({ id: entry.id, pageContent: entry.text, metadata: { source: entry.source, chunkIndex: entry.chunkIndex, score } }),
      score,
    ])
  }

  searchByText(query: string, topK: number = config.topK): SearchResult[] {
    return this.hybridSearch(query, embedTextLocally(query), topK).map(({ entry, score }) => ({
      id: entry.id,
      text: entry.text,
      source: entry.source,
      chunkIndex: entry.chunkIndex,
      score,
      matchedByBm25: false,
    }))
  }

  size(): number { return this.entries.length }

  getSources(): string[] {
    return [...new Set(this.entries.map(entry => entry.source))]
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.metadataFile), { recursive: true })
    const tmpFile = `${this.metadataFile}.tmp`
    await fs.writeFile(tmpFile, JSON.stringify(this.entries, null, 2))
    await fs.rename(tmpFile, this.metadataFile)
  }

  async load(): Promise<boolean> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.metadataFile, 'utf-8'))
      if (!Array.isArray(parsed)) return false
      this.entries = parsed
        .filter(entry => entry && typeof entry.id === 'string' && typeof entry.text === 'string')
        .map(entry => ({
          id: entry.id,
          text: entry.text,
          source: String(entry.source ?? ''),
          chunkIndex: Number(entry.chunkIndex ?? 0),
          vector: Array.isArray(entry.vector) ? entry.vector : embedTextLocally(entry.text),
        }))
      return true
    } catch (error) {
      if (error instanceof SyntaxError) log.warn('Corrupted metadata.json, ignoring')
      return false
    }
  }

  private upsert(entry: Entry): void {
    const index = this.entries.findIndex(current => current.id === entry.id)
    if (index >= 0) this.entries[index] = entry
    else this.entries.push(entry)
  }

  private scoreVector(query: number[], k: number, filter?: object | string): Array<{ entry: Entry; score: number }> {
    return this.entries
      .filter(entry => matchesFilter(entry, filter))
      .map(entry => ({ entry, score: cosineSimilarity(query, entry.vector) }))
      .filter(result => Number.isFinite(result.score) && result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  }

  private hybridSearch(query: string, vector: number[], k: number, filter?: object | string): Array<{ entry: Entry; score: number }> {
    const terms = new Set(tokenize(query))
    if (!terms.size) return []
    const candidates = this.entries.filter(entry => matchesFilter(entry, filter))
    const stats = buildDocStats(candidates.map(entry => entry.text))
    return candidates
      .map(entry => {
        const overlap = tokenize(entry.text).some(term => terms.has(term))
        const lexical = bm25Score(query, entry.text, stats)
        const semantic = cosineSimilarity(vector, entry.vector)
        return { entry, overlap, score: lexical / (lexical + 1) * 0.7 + semantic * 0.3 }
      })
      .filter(result => result.overlap && Number.isFinite(result.score) && result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ entry, score }) => ({ entry, score }))
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < length; i++) dot += a[i] * b[i]
  return dot
}

function matchesFilter(entry: Entry, filter?: object | string): boolean {
  if (!filter) return true
  if (typeof filter === 'string') return entry.source === filter
  return Object.entries(filter).every(([key, value]) => {
    if (key === 'source') return entry.source === value
    if (key === 'id') return entry.id === value
    if (key === 'chunkIndex') return entry.chunkIndex === value
    return true
  })
}
