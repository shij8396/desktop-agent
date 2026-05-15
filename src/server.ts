import 'dotenv/config'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { config } from './config.js'
import { RagAgent } from './ragAgent.js'
import { createLogger } from './logger.js'
import { readSystemClipboard } from './clipboard.js'

const log = createLogger('server')

const MAX_SCREENSHOT_LENGTH = 2_000_000 // ~1.5MB base64
const BASE64_REGEX = /^[A-Za-z0-9+/]+=*$/
const SESSION_ID_MAX_LENGTH = 64
const PATHS_MAX_COUNT = 20

const app = new Hono()
const agent = new RagAgent()

// Safe JSON parsing
async function parseJsonBody(c: any) {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

// CORS — allow all origins for local Tauri webview
app.use('*', cors())

// Request logging
app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  log.info('Request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - start,
  })
})

// GET /api/status
app.get('/api/status', (c) => {
  const status = agent.getStatus()
  return c.json(status)
})

// POST /api/ask
app.post('/api/ask', async (c) => {
  const body = await parseJsonBody(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const { question, sessionId = 'default', forceWeb = false, screenshot } = body

  if (!question || typeof question !== 'string') {
    return c.json({ error: 'question is required' }, 400)
  }
  if (question.length > config.maxQuestionLength) {
    return c.json({ error: `question too long (max ${config.maxQuestionLength} chars)` }, 400)
  }
  if (typeof sessionId !== 'string' || sessionId.length > SESSION_ID_MAX_LENGTH) {
    return c.json({ error: 'Invalid sessionId' }, 400)
  }
  if (screenshot && (typeof screenshot !== 'string' || screenshot.length > MAX_SCREENSHOT_LENGTH || !BASE64_REGEX.test(screenshot))) {
    return c.json({ error: 'Screenshot must be valid base64 and under 2MB' }, 400)
  }

  try {
    const answer = await agent.query(question, sessionId, forceWeb, screenshot)
    return c.json({ answer })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.error('Query failed', { error: msg })
    return c.json({ error: msg }, 500)
  }
})

// POST /api/ask/stream — SSE streaming
app.post('/api/ask/stream', async (c) => {
  const body = await parseJsonBody(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const { question, sessionId = 'default', forceWeb = false, screenshot } = body

  if (!question || typeof question !== 'string') {
    return c.json({ error: 'question is required' }, 400)
  }
  if (question.length > config.maxQuestionLength) {
    return c.json({ error: `question too long (max ${config.maxQuestionLength} chars)` }, 400)
  }
  if (typeof sessionId !== 'string' || sessionId.length > SESSION_ID_MAX_LENGTH) {
    return c.json({ error: 'Invalid sessionId' }, 400)
  }
  if (screenshot && (typeof screenshot !== 'string' || screenshot.length > MAX_SCREENSHOT_LENGTH || !BASE64_REGEX.test(screenshot))) {
    return c.json({ error: 'Screenshot must be valid base64 and under 2MB' }, 400)
  }

  return streamSSE(c, async (stream) => {
    try {
      for await (const data of agent.queryStream(question, sessionId, forceWeb, screenshot)) {
        await stream.writeSSE({
          data,
          event: 'token',
        })
      }
      await stream.writeSSE({
        data: JSON.stringify({ done: true }),
        event: 'done',
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('Stream query failed', { error: msg })
      await stream.writeSSE({
        data: JSON.stringify({ error: msg }),
        event: 'error',
      })
    }
  })
})

// POST /api/ingest
app.post('/api/ingest', async (c) => {
  const body = await parseJsonBody(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const { paths } = body

  if (!Array.isArray(paths) || paths.length === 0) {
    return c.json({ error: 'paths is required (array of file/directory paths)' }, 400)
  }
  if (paths.length > PATHS_MAX_COUNT) {
    return c.json({ error: `Too many paths (max ${PATHS_MAX_COUNT})` }, 400)
  }
  if (!paths.every((p: unknown) => typeof p === 'string')) {
    return c.json({ error: 'All paths must be strings' }, 400)
  }

  try {
    const chunksAdded = await agent.ingest(paths)
    return c.json({ chunksAdded })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.error('Ingest failed', { error: msg })
    return c.json({ error: msg }, 500)
  }
})

// ---- Clipboard endpoint ----

// GET /api/clipboard — read system clipboard
app.get('/api/clipboard', async (c) => {
  const result = await readSystemClipboard()
  return c.json(result)
})

async function startServer() {
  await agent.init()

  serve({
    fetch: app.fetch,
    port: config.serverPort,
  })

  log.info('Server started', { port: config.serverPort })
}

startServer().catch((err) => {
  log.error('Fatal error', { error: String(err) })
  process.exit(1)
})
