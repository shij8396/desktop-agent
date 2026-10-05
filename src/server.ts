import 'dotenv/config'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { config } from './config.js'
import { clearUserSettings, getDefaultSettings, saveUserSettings } from './config.js'
import { RagAgent } from './ragAgent.js'
import { createLogger } from './logger.js'
import { confirmAction, listPendingActions, rejectAction } from './actions.js'
import { getAuthorizedRoots, setAuthorizedRoots, resolveDesktopActionResult } from './tools.js'
import { modelRouter } from './providers/router.js'
import { getContextManager } from './contextManager.js'
import { UserMemory, UserProfile } from './memory.js'

const log = createLogger('server')

const MAX_SCREENSHOT_LENGTH = 2_000_000 // ~1.5MB base64
const BASE64_REGEX = /^[A-Za-z0-9+/]+=*$/
const SESSION_ID_MAX_LENGTH = 64
const PROVIDERS = ['deepseek', 'openai', 'ollama'] as const
const MEMORY_TYPES = ['app', 'path', 'command', 'preference'] as const
const PROFILE_CATEGORIES = ['persona', 'preference', 'routine', 'skill'] as const
const LOCAL_TOKEN = process.env.RAG_PET_LOCAL_TOKEN || ''
const REQUIRE_LOCAL_TOKEN = process.env.RAG_PET_REQUIRE_LOCAL_TOKEN === 'true'
const ALLOWED_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'http://localhost',
  'http://127.0.0.1:3000',
  // 开发模式前端端口（Vite 5173、Node 3001 等）
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
])

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
// The Runtime is a loopback-only service. A per-launch token blocks other
// local processes and pages from invoking tools even when they know the port.
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin')
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return c.json({ error: 'Origin is not allowed' }, 403)
  }
  if (REQUIRE_LOCAL_TOKEN && (!LOCAL_TOKEN || c.req.header('x-assistant-token') !== LOCAL_TOKEN)) {
    log.warn('Unauthorized local runtime request', { path: c.req.path, origin: origin || '(none)' })
    return c.json({ error: 'Unauthorized local runtime request' }, 401)
  }
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Vary', 'Origin')
  }
  c.header('Access-Control-Allow-Headers', 'Content-Type, X-Assistant-Token')
  c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

// Request logging
app.use('/api/*', async (c, next) => {
  const start = Date.now()
  await next()
  log.info('Request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - start,
  })
})

// 静态文件服务 — 提供 desktop 目录的 HTML/JS/CSS 资源
// 让 Tauri WebView2 可以从 Node 服务器加载 pet.html，不依赖 Tauri 的 asset 服务器
// 下方中间件对所有响应加 Cache-Control: no-cache — 前端 JS 改动后立即生效，
// 防止 WebView2 启发式缓存命中旧版本（曾出现：磁盘已是修复版，但 webview 加载了
// 缓存的旧 pet-window.js，交互层整体失效）
app.use('/*', (c, next) => {
  c.header('Cache-Control', 'no-cache')
  return next()
})
app.use('/*', serveStatic({
  root: './desktop',
  rewriteRequestPath: (p) => p === '/' ? '/pet.html' : p,
}))

// GET /api/status
app.get('/api/status', (c) => {
  const status = agent.getStatus()
  return c.json({ ...status, controlPlane: { mode: 'local-enterprise', role: process.env.ASSISTANT_ROLE || 'employee', authorizedRoots: getAuthorizedRoots().length } })
})

app.get('/api/authorizations', (c) => c.json({ roots: getAuthorizedRoots() }))

app.get('/api/memories', async (c) => c.json({
  memories: await UserMemory.getInstance().listEntries(),
  profile: await UserProfile.getInstance().getProfile(),
}))

app.post('/api/memories/update', async (c) => {
  const body = await parseJsonBody(c)
  if (!body || typeof body.key !== 'string' || !body.key.trim() || typeof body.value !== 'string' || !body.value.trim()) {
    return c.json({ ok: false, error: 'key and value are required' }, 400)
  }
  if (body.scope === 'memory' && MEMORY_TYPES.includes(body.type) && body.key.length <= 100 && body.value.length <= 500) {
    const entry = await UserMemory.getInstance().updateEntry(body.type, body.key, body.value)
    return entry ? c.json({ ok: true, entry }) : c.json({ ok: false, error: 'MEMORY_NOT_FOUND' }, 404)
  }
  if (body.scope === 'profile' && PROFILE_CATEGORIES.includes(body.type) && body.key.length <= 60 && body.value.length <= 300) {
    const entry = await UserProfile.getInstance().updateProfileEntry(body.type, body.key, body.value)
    return entry ? c.json({ ok: true, entry }) : c.json({ ok: false, error: 'PROFILE_NOT_FOUND' }, 404)
  }
  return c.json({ ok: false, error: 'Invalid memory scope, type, or size' }, 400)
})

app.post('/api/memories/delete', async (c) => {
  const body = await parseJsonBody(c)
  if (!body || typeof body.key !== 'string' || !body.key.trim()) return c.json({ ok: false, error: 'key is required' }, 400)
  if (body.scope === 'memory' && MEMORY_TYPES.includes(body.type)) {
    const deleted = await UserMemory.getInstance().deleteEntry(body.type, body.key)
    return deleted ? c.json({ ok: true }) : c.json({ ok: false, error: 'MEMORY_NOT_FOUND' }, 404)
  }
  if (body.scope === 'profile' && PROFILE_CATEGORIES.includes(body.type)) {
    const deleted = await UserProfile.getInstance().deleteProfileEntry(body.type, body.key)
    return deleted ? c.json({ ok: true }) : c.json({ ok: false, error: 'PROFILE_NOT_FOUND' }, 404)
  }
  return c.json({ ok: false, error: 'Invalid memory scope or type' }, 400)
})

app.post('/api/authorizations', async (c) => {
  const body = await parseJsonBody(c)
  if (!body || !Array.isArray(body.roots) || body.roots.length === 0 || body.roots.length > 10 || !body.roots.every((root: unknown) => typeof root === 'string' && root.length <= 260)) {
    return c.json({ error: 'roots must be an array of 1 to 10 paths' }, 400)
  }
  setAuthorizedRoots(body.roots)
  return c.json({ ok: true, roots: getAuthorizedRoots() })
})

app.get('/api/actions', (c) => c.json({ actions: listPendingActions() }))

// GET /api/connectivity — check network and model availability
app.get('/api/connectivity', async (c) => {
  const selection = await modelRouter.selectProvider()
  return c.json({
    state: modelRouter.currentState,
    provider: selection.provider,
    model: selection.model,
    online: selection.online,
    fallback: selection.fallback,
    reason: selection.reason,
  })
})

app.post('/api/actions/:id/confirm', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'Invalid action id' }, 400)
  const result = await confirmAction(id)
  if (!result.ok) return c.json(result, 400)
  const action = result.action as { sessionId?: string } | undefined
  if (!action?.sessionId) return c.json(result)
  try {
    const answer = await agent.resumeTask(action.sessionId, { approved: true, actionId: id, result })
    return c.json({ ...result, resumed: { ok: true, answer } })
  } catch (error) {
    return c.json({ ...result, resumed: { ok: false, error: error instanceof Error ? error.message : String(error) } })
  }
})

app.post('/api/actions/:id/reject', async (c) => {
  const id = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'Invalid action id' }, 400)
  const result = await rejectAction(id)
  if (!result.ok) return c.json(result, 400)
  const action = result.action as { sessionId?: string } | undefined
  if (!action?.sessionId) return c.json(result)
  try {
    const answer = await agent.resumeTask(action.sessionId, { approved: false, actionId: id, result })
    return c.json({ ...result, resumed: { ok: true, answer } })
  } catch (error) {
    return c.json({ ...result, resumed: { ok: false, error: error instanceof Error ? error.message : String(error) } })
  }
})

app.get('/api/agent/tasks/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  if (!sessionId || sessionId.length > SESSION_ID_MAX_LENGTH) return c.json({ error: 'Invalid sessionId' }, 400)
  try {
    return c.json({ ok: true, task: await agent.getTaskSnapshot(sessionId) })
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

// GET /api/settings - public runtime settings without secrets
app.get('/api/settings', (c) => {
  const status = agent.getStatus().config
  return c.json({
    status,
    defaults: {
      deepseek: getDefaultSettings('deepseek'),
      openai: getDefaultSettings('openai'),
    },
  })
})

// POST /api/settings - save local user model settings
app.post('/api/settings', async (c) => {
  const body = await parseJsonBody(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const { provider, apiKey, baseUrl, model } = body
  if (!PROVIDERS.includes(provider)) {
    return c.json({ error: 'provider must be deepseek, openai, or ollama' }, 400)
  }

  try {
    await saveUserSettings({ provider, apiKey, baseUrl, model })
    agent.reloadSettings()
    return c.json({ ok: true, status: agent.getStatus().config })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return c.json({ error: msg }, 400)
  }
})

// DELETE /api/settings - clear local user model settings
app.delete('/api/settings', async (c) => {
  await clearUserSettings()
  agent.reloadSettings()
  return c.json({ ok: true, status: agent.getStatus().config })
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

// POST /api/agent/execute — SSE streaming with Agent reasoning events
app.post('/api/agent/execute', async (c) => {
  const body = await parseJsonBody(c)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const { question, sessionId = 'default', forceWeb = false, screenshot, requestId } = body

  if (!question || typeof question !== 'string') {
    return c.json({ error: 'question is required' }, 400)
  }
  if (question.length > config.maxQuestionLength) {
    return c.json({ error: `question too long (max ${config.maxQuestionLength} chars)` }, 400)
  }
  if (typeof sessionId !== 'string' || sessionId.length > SESSION_ID_MAX_LENGTH) {
    return c.json({ error: 'Invalid sessionId' }, 400)
  }
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))) {
    return c.json({ error: 'Invalid requestId' }, 400)
  }

  return streamSSE(c, async (stream) => {
    try {
      const answer = await agent.executeWithEngine(
        question,
        sessionId,
        async (event) => {
          await stream.writeSSE({
            data: JSON.stringify(event),
            event: event.type,
          })
        },
        { forceWeb, screenshot, requestId },
      )
      await stream.writeSSE({
        data: JSON.stringify({ type: 'done', content: answer, timestamp: new Date().toISOString() }),
        event: 'done',
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('Agent execution failed', { error: msg })
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', content: msg, timestamp: new Date().toISOString() }),
        event: 'error',
      })
    }
  })
})

// POST /api/agent/desktop-result — 前端回传桌面端（Tauri）执行结果
// 引擎在 executeTool 返回 DESKTOP_REQUIRED + toolId 后等待此结果继续执行。
app.post('/api/agent/desktop-result', async (c) => {
  let body: { toolId?: unknown; result?: unknown } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400)
  }
  const { toolId, result } = body
  if (typeof toolId !== 'string' || toolId.length === 0) {
    return c.json({ ok: false, error: 'INVALID_ARGUMENT', message: 'toolId is required' }, 400)
  }
  const consumed = resolveDesktopActionResult(toolId, result)
  if (!consumed) {
    return c.json({ ok: false, error: 'UNKNOWN_TOOL_ID', message: 'toolId 已过期或不存在（可能已超时）' }, 404)
  }
  return c.json({ ok: true })
})

// Cancel the exact in-flight request; aborting the SSE fetch alone only closes the UI stream.
app.post('/api/agent/cancel', async (c) => {
  const body = await parseJsonBody(c)
  if (!body || typeof body.sessionId !== 'string' || typeof body.requestId !== 'string') {
    return c.json({ ok: false, error: 'sessionId and requestId are required' }, 400)
  }
  const cancelled = await agent.cancelTask(body.sessionId, body.requestId)
  return c.json({ ok: cancelled, ...(cancelled ? {} : { error: 'TASK_NOT_RUNNING' }) }, cancelled ? 200 : 404)
})

// POST /api/ingest — disabled in read-only release
app.post('/api/ingest', (c) => c.json({ error: 'Knowledge-base ingestion is disabled in the read-only release' }, 403))

// POST /api/desktop-file-changed — 桌面文件变更增量入知识库（白名单端点，仅来自桌面 watcher）
// removed → 移除该文件的 chunks；created/modified → 增量入库（ingestPath 内部哈希去重）
app.post('/api/desktop-file-changed', async (c) => {
  let body: { kind?: string; path?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'INVALID_JSON' }, 400)
  }
  const { kind, path } = body
  if (!path || typeof path !== 'string') {
    return c.json({ ok: false, error: 'INVALID_ARGUMENT', message: 'path is required' }, 400)
  }
  try {
    if (kind === 'removed') {
      // source 与入库保持一致：ingestPath 默认 basePath=inputPath → source=文件名
      const source = path.replace(/\\/g, '/').split('/').pop() || path
      await agent.removeSource(source)
    } else {
      await agent.ingest([path])
    }
    return c.json({ ok: true })
  } catch (error) {
    log.warn('Desktop file change ingest failed', { path, kind, error: error instanceof Error ? error.message : String(error) })
    return c.json({ ok: true }) // 静默失败，不打扰用户
  }
})

// POST /api/context — 前端推送上下文事件（前台窗口变化、用户活动信号）
// 用于持续感知层：让 Node 端 Agent 知道用户当前在做什么
app.post('/api/context', async (c) => {
  try {
    const body = await c.req.json()
    const { type, summary, data } = body
    if (!type || !summary) {
      return c.json({ ok: false, error: 'INVALID_ARGUMENT', message: 'type and summary are required' }, 400)
    }
    getContextManager().pushEvent({ type, summary, data })
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ ok: false, error: 'INVALID_JSON', message: String(error) }, 400)
  }
})

// GET /api/context/snapshot — 查询当前上下文快照（调试用）
app.get('/api/context/snapshot', (c) => {
  return c.json({ ok: true, snapshot: getContextManager().getSnapshot() })
})

// GET /api/proactive/check — 主动事件检查（前端每 60s 轮询）
// 返回小伴应该主动开口的事件列表
let weatherRefreshing = false
let weatherLastRefresh = 0
const WEATHER_REFRESH_INTERVAL = 30 * 60 * 1000  // 30 分钟刷新一次

app.get('/api/proactive/check', async (c) => {
  try {
    const dndMode = c.req.query('dnd') === 'true'
    const { getProactiveEngine } = await import('./contextManager.js')
    const { UserProfile } = await import('./memory.js')
    const engine = getProactiveEngine()
    const profile = UserProfile.getInstance()
    // 异步刷新负面情绪计数缓存
    try {
      const recent = await profile.getRecentEmotions(120)  // 最近 2 小时
      const negative = recent.filter(e => e.emotion === 'frustrated' || e.emotion === 'tired')
      engine.cachedNegativeEmotionCount = negative.length
    } catch {}
    // 异步刷新天气缓存（30 分钟一次，不阻塞当前请求）
    const now = Date.now()
    if (
      !weatherRefreshing
      && now - weatherLastRefresh > WEATHER_REFRESH_INTERVAL
    ) {
      weatherRefreshing = true
      weatherLastRefresh = now
      ;(async () => {
        try {
          const { getWeather } = await import('./webSearch.js')
          const location = process.env.WEATHER_LOCATION || 'Beijing'
          // format=j1 返回 JSON
          const raw = await getWeather(location, 'j1')
          const parsed = JSON.parse(raw)
          const cur = parsed?.current_condition?.[0] ?? null
          if (cur) {
            engine.cachedWeather = {
              description: cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '未知',
              tempC: parseFloat(cur.temp_C || '0'),
              condition: cur.weatherCode || '',
              fetchedAt: Date.now(),
            }
          }
        } catch {
          // 静默失败 — 天气是可选优化项
        } finally {
          weatherRefreshing = false
        }
      })()
    }
    const events = engine.checkRules(
      getContextManager(),
      profile,
      dndMode,
    )
    return c.json({ ok: true, events })
  } catch (error) {
    return c.json({ ok: false, error: 'PROACTIVE_CHECK_FAILED', message: String(error) }, 500)
  }
})

// POST /api/vision/describe — 上传截屏生成情境描述 + 异常分析
// 隐私保护：只生成文本，不存图。同时返回结构化异常分类供前端/ProactiveEngine 使用
app.post('/api/vision/describe', async (c) => {
  try {
    const body = await c.req.json()
    const { image_base64, analyze_anomaly } = body
    if (!image_base64) {
      return c.json({ ok: false, error: 'INVALID_ARGUMENT', message: 'image_base64 is required' }, 400)
    }
    const { describeScreenFromBase64, analyzeScreenForAnomaly } = await import('./vision.js')
    // 描述用更轻量 prompt（短文本，给上下文用）
    const description = await describeScreenFromBase64(image_base64, '简短描述用户当前屏幕内容（不超过 100 字），用于辅助回答')
    // 推入上下文事件
    getContextManager().pushEvent({
      type: 'user_activity',
      summary: `屏幕: ${description.slice(0, 200)}`,
      data: { source: 'vision', description },
    })

    // 异常分析（可选，analyze_anomaly=true 时启用，否则默认开启 — 前端周期观察都希望做异常检测）
    let anomaly = null
    let proactiveEvent = null
    if (analyze_anomaly !== false) {
      try {
        anomaly = await analyzeScreenForAnomaly(image_base64)
        // 更新 ProactiveEngine 缓存 — 下次 /api/proactive/check 时会被检查
        const { getProactiveEngine } = await import('./contextManager.js')
        const engine = getProactiveEngine()
        engine.cachedScreenAnomaly = {
          scene: anomaly.scene,
          anomaly: anomaly.anomaly,
          summary: anomaly.summary,
          confidence: anomaly.confidence,
          fetchedAt: Date.now(),
        }
        // 立即检查是否需要触发主动介入事件（不等下次 60s 轮询）
        if (anomaly.anomaly !== 'none') {
          proactiveEvent = engine.checkScreenAnomaly()
        }
      } catch (e) {
        // 异常分析失败不影响描述本身
        log.warn('anomaly analysis failed', { error: String(e) })
      }
    }

    return c.json({ ok: true, description, anomaly, proactiveEvent })
  } catch (error) {
    return c.json({ ok: false, error: 'VISION_FAILED', message: String(error) }, 500)
  }
})

// GET /api/tts/status — 检查 Edge TTS 是否可用
app.get('/api/tts/status', async (c) => {
  try {
    const { isEdgeTtsAvailable } = await import('./edgeTts.js')
    const available = await isEdgeTtsAvailable()
    return c.json({ ok: true, available })
  } catch (error) {
    return c.json({ ok: false, available: false, error: String(error) })
  }
})

// POST /api/tts/synthesize — 合成单句文本为 MP3，返回二进制音频
// body: { text, tone?, lang?, rate?, pitch?, voice? }
app.post('/api/tts/synthesize', async (c) => {
  try {
    const body = await parseJsonBody(c)
    if (!body || typeof body.text !== 'string' || !body.text.trim()) {
      return c.json({ ok: false, error: 'INVALID_ARGUMENT', message: 'text is required' }, 400)
    }
    if (body.text.length > 1000) {
      return c.json({ ok: false, error: 'TEXT_TOO_LONG', message: 'max 1000 chars per request' }, 400)
    }
    const { synthesizeEdgeTts } = await import('./edgeTts.js')
    const buf = await synthesizeEdgeTts(body.text, {
      tone: typeof body.tone === 'string' ? body.tone : 'male-low',
      lang: typeof body.lang === 'string' ? body.lang : 'zh-CN',
      voice: typeof body.voice === 'string' ? body.voice : undefined,
      rate: typeof body.rate === 'number' ? body.rate : undefined,
      pitch: typeof body.pitch === 'number' ? body.pitch : undefined,
    })
    // 返回 MP3 二进制
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    log.warn('TTS synthesize failed', { error: String(error) })
    return c.json({ ok: false, error: 'TTS_FAILED', message: String(error) }, 500)
  }
})

async function startServer() {
  if (REQUIRE_LOCAL_TOKEN && !LOCAL_TOKEN) {
    throw new Error('RAG_PET_LOCAL_TOKEN is required when local runtime authentication is enabled')
  }
  await agent.init()

  // 启动时重新调度未触发的 reminders（错过的时间立即补发）
  try {
    const { rescheduleAllOnBoot, gcFiredReminders } = await import('./reminders.js')
    await rescheduleAllOnBoot()
    // 每天清理一次已 fired 的旧 reminders（>7 天）
    setInterval(() => { gcFiredReminders().catch(() => {}) }, 24 * 60 * 60 * 1000)
  } catch (error) {
    log.warn('Failed to reschedule reminders on boot', { error: String(error) })
  }

  serve({
    fetch: app.fetch,
    port: config.serverPort,
    hostname: '127.0.0.1',
  })

  log.info('Server started', { port: config.serverPort })
}

startServer().catch((err) => {
  log.error('Fatal error', { error: String(err) })
  process.exit(1)
})
