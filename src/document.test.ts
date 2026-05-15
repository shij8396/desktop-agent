import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { chunkText, loadDocument, ingestPath, resetContentHashes } from './document.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-test-'))
  await resetContentHashes()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('chunkText', () => {
  it('should split text into chunks', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
    const chunks = chunkText(text, 'test.md')
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].source).toBe('test.md')
    expect(chunks[0].id).toContain('test.md::')
  })

  it('should assign sequential chunk indices', () => {
    const text = 'Para one.\n\nPara two.\n\nPara three.'
    const chunks = chunkText(text, 'test.md')
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i)
    }
  })

  it('should handle empty text', () => {
    const chunks = chunkText('', 'test.md')
    expect(chunks).toEqual([])
  })
})

describe('loadDocument', () => {
  it('should load .txt files', async () => {
    const filePath = path.join(tmpDir, 'test.txt')
    await fs.writeFile(filePath, 'Hello world')
    const text = await loadDocument(filePath)
    expect(text).toBe('Hello world')
  })

  it('should load .md files', async () => {
    const filePath = path.join(tmpDir, 'test.md')
    await fs.writeFile(filePath, '# Title\n\nContent here')
    const text = await loadDocument(filePath)
    expect(text).toContain('# Title')
  })
})

describe('ingestPath', () => {
  it('should ingest a single file', async () => {
    const filePath = path.join(tmpDir, 'doc.txt')
    await fs.writeFile(filePath, 'Some test content for ingestion.')
    const chunks = await ingestPath(filePath)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('should ingest a directory recursively', async () => {
    const subDir = path.join(tmpDir, 'sub')
    await fs.mkdir(subDir)
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'File A content.')
    await fs.writeFile(path.join(subDir, 'b.txt'), 'File B content.')
    const chunks = await ingestPath(tmpDir)
    expect(chunks.length).toBeGreaterThan(0)
    const sources = new Set(chunks.map(c => c.source))
    expect(sources.size).toBe(2)
  })

  it('should skip unsupported extensions', async () => {
    const filePath = path.join(tmpDir, 'test.xyz')
    await fs.writeFile(filePath, 'Unsupported format')
    const chunks = await ingestPath(filePath)
    expect(chunks).toEqual([])
  })
})
