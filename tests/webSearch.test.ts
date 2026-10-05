import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { webSearch, fetchUrl } from '../src/webSearch.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('webSearch (Bing)', () => {
  it('should parse Bing search results', async () => {
    const mockHtml = `
      <li class="b_algo">
        <h2><a href="https://example.com/page">Test Result Title</a></h2>
        <p>This is a test snippet from Bing.</p>
      </li>
    `

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    }) as any

    const results = await webSearch('test query')
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Test Result Title')
    expect(results[0].url).toBe('https://example.com/page')
    expect(results[0].snippet).toContain('test snippet')
  })

  it('should return empty on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as any

    const results = await webSearch('test')
    expect(results).toEqual([])
  })

  it('should return empty on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as any

    const results = await webSearch('test')
    expect(results).toEqual([])
  })
})

describe('fetchUrl', () => {
  it('should extract text from HTML', async () => {
    const mockHtml = '<html><body><p>Hello world</p></body></html>'
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    }) as any

    const text = await fetchUrl('https://example.com')
    expect(text).toContain('Hello world')
  })

  it('should truncate to maxChars', async () => {
    const longText = 'a'.repeat(5000)
    const mockHtml = `<html><body>${longText}</body></html>`
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    }) as any

    const text = await fetchUrl('https://example.com', 100)
    expect(text.length).toBeLessThanOrEqual(100)
  })

  it('should return error message on HTTP failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as any

    const text = await fetchUrl('https://example.com/missing')
    expect(text).toContain('404')
  })
})
