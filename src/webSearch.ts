import { createLogger } from './logger.js'
import { config } from './config.js'
import { stripHtml } from './html.js'

const log = createLogger('webSearch')

export interface WebResult {
  title: string
  url: string
  snippet: string
}

// Search via Bing
async function bingSearch(query: string, maxResults: number): Promise<WebResult[]> {
  try {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&cc=CN`
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      log.warn('Bing search HTTP error', { status: res.status })
      return []
    }

    const html = await res.text()
    const results: WebResult[] = []

    // Parse Bing search results - look for <li class="b_algo">
    const resultRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g
    let match

    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const block = match[1]

      const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      if (!titleMatch) continue

      const url = titleMatch[1]
      const title = stripHtml(titleMatch[2])

      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ''

      if (title && url.startsWith('http')) {
        results.push({ title, url, snippet })
      }
    }

    // Fallback: try simpler regex
    if (results.length === 0) {
      const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/g
      const seen = new Set<string>()
      let linkMatch
      while ((linkMatch = linkRegex.exec(html)) !== null && results.length < maxResults) {
        const url = linkMatch[1]
        const title = stripHtml(linkMatch[2])
        if (title.length > 5 && !seen.has(url) && !url.includes('bing.com') && !url.includes('microsoft.com')) {
          seen.add(url)
          results.push({ title, url, snippet: '' })
        }
      }
    }

    return results
  } catch (error) {
    log.warn('Bing search failed', { error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

// Search via DuckDuckGo HTML
async function duckDuckGoSearch(query: string, maxResults: number): Promise<WebResult[]> {
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      log.warn('DuckDuckGo search HTTP error', { status: res.status })
      return []
    }

    const html = await res.text()
    const results: WebResult[] = []

    // DDG HTML: results in <a class="result__a"> with snippets in <a class="result__snippet">
    const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let match

    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const rawUrl = match[1]
      const title = stripHtml(match[2])
      const snippet = stripHtml(match[3])

      // DDG wraps URLs in redirects: //duckduckgo.com/l/?uddg=ENCODED_URL
      const urlParamMatch = rawUrl.match(/uddg=([^&]+)/)
      const url = urlParamMatch ? decodeURIComponent(urlParamMatch[1]) : rawUrl

      if (title && url.startsWith('http')) {
        results.push({ title, url, snippet })
      }
    }

    return results
  } catch (error) {
    log.warn('DuckDuckGo search failed', { error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

// Single search attempt across configured engine(s)
async function searchOnce(query: string, maxResults: number): Promise<WebResult[]> {
  const engine = config.searchEngine

  if (engine === 'bing') return bingSearch(query, maxResults)
  if (engine === 'duckduckgo') return duckDuckGoSearch(query, maxResults)

  // auto mode: Bing first, DDG fallback
  const bingResults = await bingSearch(query, maxResults)
  if (bingResults.length > 0) {
    log.debug('Search completed', { engine: 'bing', results: bingResults.length })
    return bingResults
  }
  log.info('Bing returned 0 results, falling back to DuckDuckGo')
  const ddgResults = await duckDuckGoSearch(query, maxResults)
  log.debug('Search completed', { engine: 'duckduckgo', results: ddgResults.length })
  return ddgResults
}

/**
 * Dual-engine search orchestrator with one retry on empty results.
 * Retry logic: if the first attempt yields 0 results, wait 1.5s and retry
 * once with a slightly different query format (quotes stripped, etc).
 */
export async function webSearch(query: string, maxResults: number = 5): Promise<WebResult[]> {
  let results = await searchOnce(query, maxResults)
  if (results.length > 0) return results

  // Retry once after a short delay with a normalized query
  log.info('First search attempt returned 0 results, retrying once')
  await new Promise(resolve => setTimeout(resolve, 1500))
  const normalized = query.replace(/["'"']+}/g, '').replace(/\s+/g, ' ').trim()
  results = await searchOnce(normalized, maxResults)
  if (results.length === 0) {
    log.warn('Search returned 0 results after retry', { query })
  }
  return results
}

/**
 * Fetch a URL and extract its text content. Strips HTML, normalizes
 * whitespace, and truncates to maxChars. Used by fetch_webpage tool for
 * content summarization.
 */
export async function fetchUrl(url: string, maxChars: number = 3000): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) return `Failed to fetch: HTTP ${res.status}`

    const html = await res.text()
    const text = stripHtml(html)
    return text.slice(0, maxChars)
  } catch (error) {
    return `Fetch failed: ${error instanceof Error ? error.message : error}`
  }
}

/**
 * Query weather via wttr.in (free, no API key required).
 * Accepts a location string (city name, airport code, or coordinates).
 * Returns a concise text summary suitable for the LLM to format.
 */
export async function getWeather(location: string, format: string = '4'): Promise<string> {
  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=${encodeURIComponent(format)}&lang=zh`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) curl/8.0',
        'Accept': 'text/plain',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return `天气查询失败: HTTP ${res.status}`
    const text = await res.text()
    return text.trim().slice(0, 800)
  } catch (error) {
    return `天气查询失败: ${error instanceof Error ? error.message : error}`
  }
}

