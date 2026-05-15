import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { VectorStore } from './vectorStore.js'

let tmpDir: string
let metadataFile: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vs-test-'))
  metadataFile = path.join(tmpDir, 'metadata.json')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('VectorStore', () => {
  it('should add entries', () => {
    const store = new VectorStore(metadataFile)
    store.add('1', 'TypeScript is typed', 'doc.md', 0)
    store.add('2', 'Python is dynamic', 'doc.md', 1)
    expect(store.size()).toBe(2)
  })

  it('should dedup by id on add', () => {
    const store = new VectorStore(metadataFile)
    store.add('1', 'original text', 'doc.md', 0)
    store.add('1', 'updated text', 'doc.md', 0)
    expect(store.size()).toBe(1)
    const results = store.searchByText('updated', 5)
    expect(results[0].text).toBe('updated text')
  })

  it('should search by text', () => {
    const store = new VectorStore(metadataFile)
    store.add('1', 'TypeScript is a typed language', 'doc.md', 0)
    store.add('2', 'Python is dynamically typed', 'doc.md', 1)
    const results = store.searchByText('TypeScript', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toContain('TypeScript')
  })

  it('should return empty for empty store', () => {
    const store = new VectorStore(metadataFile)
    const results = store.searchByText('anything', 5)
    expect(results).toEqual([])
  })

  it('should remove by source', () => {
    const store = new VectorStore(metadataFile)
    store.add('1', 'text one', 'a.md', 0)
    store.add('2', 'text two', 'b.md', 0)
    store.removeBySource('a.md')
    expect(store.size()).toBe(1)
    expect(store.getSources()).toEqual(['b.md'])
  })

  it('should save and load', async () => {
    const store = new VectorStore(metadataFile)
    store.add('1', 'test content', 'source.txt', 0)
    await store.save()

    const loaded = new VectorStore(metadataFile)
    const ok = await loaded.load()
    expect(ok).toBe(true)
    expect(loaded.size()).toBe(1)
  })

  it('should return unique sources', () => {
    const store = new VectorStore(metadataFile)
    store.add('1', 'a', 'doc.md', 0)
    store.add('2', 'b', 'doc.md', 1)
    store.add('3', 'c', 'other.md', 0)
    expect(store.getSources()).toEqual(['doc.md', 'other.md'])
  })
})
