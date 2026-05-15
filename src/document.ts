import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'
import { createLogger } from './logger.js'
import { stripHtml } from './html.js'

const log = createLogger('document')

export interface Chunk {
  id: string
  text: string
  source: string
  chunkIndex: number
}

export async function loadDocument(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.pdf') {
    const pdfParse = (await import('pdf-parse')).default
    const buffer = await fs.readFile(filePath)
    const data = await pdfParse(buffer)
    return data.text
  }

  if (ext === '.docx') {
    const mammoth = await import('mammoth')
    const buffer = await fs.readFile(filePath)
    const result = await mammoth.extractRawText({ buffer })
    return result.value
  }

  if (ext === '.html' || ext === '.htm') {
    const raw = await fs.readFile(filePath, 'utf-8')
    return stripHtml(raw)
  }

  return fs.readFile(filePath, 'utf-8')
}

function computeContentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function findSentenceBoundary(text: string, searchStart: number): number {
  const region = text.slice(searchStart)
  const boundaries = ['。', '！', '？', '；', '. ', '! ', '? ', '; ', '\n']
  let lastIdx = -1
  for (const boundary of boundaries) {
    const idx = region.lastIndexOf(boundary)
    if (idx > lastIdx) lastIdx = idx
  }
  return lastIdx >= 0 ? searchStart + lastIdx + 1 : -1
}

function splitBySentences(text: string, chunkSize: number, chunkOverlap: number): Chunk[] {
  const sentences = text.split(/(?<=[。！？；.!?;])\s*/)
  const chunks: Chunk[] = []
  let current = ''
  let chunkIndex = 0

  for (const sentence of sentences) {
    if ((current + sentence).length <= chunkSize) {
      current += sentence
    } else {
      if (current.trim()) {
        chunks.push({ id: '', text: current.trim(), source: '', chunkIndex: chunkIndex++ })
      }
      if (chunkOverlap > 0 && current.length > chunkOverlap) {
        const boundary = findSentenceBoundary(current, current.length - chunkOverlap)
        current = boundary > 0 ? current.slice(boundary) : current.slice(-chunkOverlap)
      } else {
        current = ''
      }
      current += sentence
    }
  }
  if (current.trim()) {
    chunks.push({ id: '', text: current.trim(), source: '', chunkIndex: chunkIndex++ })
  }
  return chunks
}

export function chunkText(text: string, source: string): Chunk[] {
  const { chunkSize, chunkOverlap } = config
  const chunks: Chunk[] = []

  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim())
  let currentChunk = ''
  let chunkIndex = 0

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim()

    if ((currentChunk + '\n\n' + trimmed).length <= chunkSize) {
      currentChunk = currentChunk ? currentChunk + '\n\n' + trimmed : trimmed
    } else {
      if (currentChunk) {
        chunks.push({
          id: `${source}::${chunkIndex}`,
          text: currentChunk,
          source,
          chunkIndex,
        })
        chunkIndex++

        if (chunkOverlap > 0 && currentChunk.length > chunkOverlap) {
          const boundary = findSentenceBoundary(currentChunk, currentChunk.length - chunkOverlap)
          currentChunk = boundary > 0
            ? currentChunk.slice(boundary) + '\n\n' + trimmed
            : currentChunk.slice(-chunkOverlap) + '\n\n' + trimmed
        } else {
          currentChunk = trimmed
        }
      } else {
        const subChunks = splitBySentences(trimmed, chunkSize, chunkOverlap)
        for (const sub of subChunks) {
          chunks.push({
            id: `${source}::${chunkIndex}`,
            text: sub.text,
            source,
            chunkIndex,
          })
          chunkIndex++
        }
        currentChunk = ''
      }
    }
  }

  if (currentChunk.trim()) {
    chunks.push({
      id: `${source}::${chunkIndex}`,
      text: currentChunk.trim(),
      source,
      chunkIndex,
    })
  }

  return chunks
}

function isSupportedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ['.md', '.txt', '.pdf', '.docx', '.html', '.htm'].includes(ext)
}

let contentHashes: Map<string, string> | null = null
const hashesFile = path.join(config.dataDir, 'content-hashes.json')

async function loadContentHashes(): Promise<Map<string, string>> {
  if (contentHashes) return contentHashes
  contentHashes = new Map()
  try {
    const raw = await fs.readFile(hashesFile, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') contentHashes.set(key, value)
      }
    }
  } catch {
    // Missing or corrupted hash cache is safe to rebuild.
  }
  return contentHashes
}

async function saveContentHashes(): Promise<void> {
  if (!contentHashes) return
  await fs.mkdir(path.dirname(hashesFile), { recursive: true })
  const obj: Record<string, string> = {}
  for (const [key, value] of contentHashes) obj[key] = value
  const tmp = hashesFile + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2))
  await fs.rename(tmp, hashesFile)
}

export async function resetContentHashes(): Promise<void> {
  contentHashes = null
  try {
    await fs.unlink(hashesFile)
  } catch {
    // File might not exist.
  }
}

export async function ingestPath(
  inputPath: string,
  basePath: string = inputPath,
  depth: number = 0,
): Promise<Chunk[]> {
  if (depth > config.maxDepth) return []

  const stat = await fs.stat(inputPath)

  if (stat.isFile()) {
    if (!isSupportedFile(inputPath)) return []
    if (stat.size > config.maxFileSize) {
      log.warn('Skipping large file', { size: `${(stat.size / 1024 / 1024).toFixed(1)}MB`, path: inputPath })
      return []
    }
    const text = await loadDocument(inputPath)
    const relativePath = path.relative(basePath, inputPath) || path.basename(inputPath)

    const hashes = await loadContentHashes()
    const hash = computeContentHash(text)
    if (hashes.get(relativePath) === hash) {
      log.info('Skipping unchanged file', { source: relativePath })
      return []
    }
    hashes.set(relativePath, hash)
    await saveContentHashes()

    return chunkText(text, relativePath)
  }

  if (stat.isDirectory()) {
    const allChunks: Chunk[] = []
    const entries = await fs.readdir(inputPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(inputPath, entry.name)
      const subChunks = await ingestPath(fullPath, basePath, entry.isDirectory() ? depth + 1 : depth)
      allChunks.push(...subChunks)
    }
    return allChunks
  }

  return []
}
