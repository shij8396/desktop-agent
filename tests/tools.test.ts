import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { CORE_TOOLS, FILE_TOOLS, TOOLS, executeTool, setAuthorizedRoots } from '../src/tools.js'
import { ModelRouter } from '../src/providers/router.js'

function parse(result: string) {
  return JSON.parse(result)
}

describe('read-only tool catalog', () => {
  it('only exposes safe tools to the model', () => {
    // Core read-only tools must always be available
    expect(CORE_TOOLS.map(tool => tool.name)).toEqual(expect.arrayContaining(['web_search', 'kb_search', 'calculate', 'get_datetime']))
    // File tools must include the read-only set
    expect(FILE_TOOLS.map(tool => tool.name)).toEqual(expect.arrayContaining(['list_files', 'find_files', 'disk_usage', 'cpu_usage', 'list_recent_files', 'read_file_content', 'analyze_file', 'launch_app', 'find_program', 'take_screenshot', 'batch_move_files']))
    // Dangerous tools must never appear in the TOOLS catalog sent to the LLM
    expect(TOOLS.map(tool => tool.name)).not.toEqual(expect.arrayContaining(['write_file', 'delete_file', 'open_file', 'exec_command', 'read_clipboard']))
    expect(TOOLS.map(tool => tool.name)).not.toContain('browser_eval')
    // UserProfile tools are exposed to the LLM
    expect(CORE_TOOLS.map(tool => tool.name)).toEqual(expect.arrayContaining(['set_profile', 'get_profile', 'add_emotion', 'add_relationship_event']))
  })
})

describe('web evidence failures', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('identifies a forbidden page as missing evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    const result = parse(await executeTool('fetch_webpage', { url: 'https://example.com/private' }))
    expect(result).toMatchObject({ ok: false, error: 'HTTP_FORBIDDEN' })
    expect(result).not.toHaveProperty('content')
    expect(result.nextStep).toContain('其它来源')
  })

  it('does not report an empty search as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    const result = parse(await executeTool('web_search', { query: '测试查询' }))
    expect(result).toMatchObject({ ok: false, error: 'SEARCH_EMPTY', results: [] })
  })
})

describe('read-only filesystem tools', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-tool-test-'))
    setAuthorizedRoots([root])
    await fs.writeFile(path.join(root, 'contract.txt'), 'hello')
    await fs.writeFile(path.join(root, 'notes.md'), 'notes')
    await fs.mkdir(path.join(root, 'nested'))
    await fs.writeFile(path.join(root, 'nested', 'contract-final.txt'), 'final')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('lists an authorized directory with structured metadata', async () => {
    const result = parse(await executeTool('list_files', { path: root }))
    expect(result).toMatchObject({ ok: true, path: root, limit: 20 })
    expect(result.items.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(['contract.txt', 'nested']))
  })

  it('finds matching files only in an authorized directory', async () => {
    const result = parse(await executeTool('find_files', { directory: root, pattern: 'contract*.txt', maxDepth: 3 }))
    expect(result.ok).toBe(true)
    expect(result.matches).toHaveLength(2)
  })

  it('routes a path outside the granted directory to the desktop bridge', async () => {
    // 授权目录外（如 C:\）不再直接拒绝 — 改为 DESKTOP_REQUIRED 桥接，
    // 由前端经 Tauri list_directory 读取，安全性由设置面板「文件读取」开关把关。
    const result = parse(await executeTool('list_files', { path: 'C:\\Windows\\System32' }))
    expect(result).toMatchObject({ ok: false, error: 'DESKTOP_REQUIRED', tool: 'list_files' })
    expect(typeof result.toolId).toBe('string')
  })

  it('returns disk capacity without spawning a shell', async () => {
    const result = parse(await executeTool('disk_usage', { path: root }))
    expect(result).toMatchObject({ ok: true, path: expect.any(String), totalBytes: expect.any(Number), availableBytes: expect.any(Number) })
  })
})

describe('policy enforcement', () => {
  it.each(['write_file', 'delete_file', 'open_file', 'exec_command', 'ingest_docs'])('denies %s until the confirmation workflow exists', async (name) => {
    const result = parse(await executeTool(name, {}))
    expect(result).toMatchObject({ ok: false, error: 'POLICY_DENIED' })
  })

  it('rejects read_file with empty path (INVALID_ARGUMENT)', async () => {
    const result = parse(await executeTool('read_file', {}))
    expect(result).toMatchObject({ ok: false, error: 'INVALID_ARGUMENT' })
  })

  it('returns DESKTOP_REQUIRED for read_clipboard on Node side (Tauri-only tool)', async () => {
    const result = parse(await executeTool('read_clipboard', {}))
    expect(result).toMatchObject({ ok: false, error: 'DESKTOP_REQUIRED' })
  })

  it('calculates safely without exposing a general evaluator', async () => {
    expect(parse(await executeTool('calculate', { expression: 'Math.sqrt(16) + 2' }))).toMatchObject({ ok: true, result: 6 })
    expect(parse(await executeTool('calculate', { expression: 'process.exit(1)' }))).toMatchObject({ ok: false })
  })

  it('denies arbitrary JavaScript evaluation in the browser', async () => {
    expect(parse(await executeTool('browser_eval', { js: 'document.title' }))).toMatchObject({ ok: false, error: 'POLICY_DENIED' })
  })

  it('returns deterministic metadata for current time', async () => {
    expect(parse(await executeTool('get_datetime', {}))).toMatchObject({ ok: true, timestamp: expect.any(String), weekday: expect.any(String), timeZone: 'Asia/Shanghai' })
  })
})

describe('UserProfile tools', () => {
  it('set_profile validates category enum', async () => {
    const bad = parse(await executeTool('set_profile', { category: 'invalid_cat', key: 'k', value: 'v' }))
    expect(bad).toMatchObject({ ok: false, error: 'INVALID_ARGUMENT' })
  })

  it('set_profile validates required fields', async () => {
    const noKey = parse(await executeTool('set_profile', { category: 'persona', value: 'v' }))
    expect(noKey).toMatchObject({ ok: false, error: 'INVALID_ARGUMENT' })
  })

  it('set_profile accepts valid input and persists', async () => {
    const ok = parse(await executeTool('set_profile', {
      category: 'persona', key: '职业', value: '测试工程师', confidence: 0.9,
    }))
    expect(ok).toMatchObject({ ok: true, tool: 'set_profile' })
    expect(ok.entry).toMatchObject({ category: 'persona', confidence: 0.9 })
  })

  it('get_profile returns entries (possibly empty)', async () => {
    const r = parse(await executeTool('get_profile', { category: 'persona' }))
    expect(r).toMatchObject({ ok: true, tool: 'get_profile' })
    expect(Array.isArray(r.entries)).toBe(true)
  })

  it('add_emotion validates emotion enum', async () => {
    const bad = parse(await executeTool('add_emotion', { emotion: 'angry', intensity: 3 }))
    expect(bad).toMatchObject({ ok: false, error: 'INVALID_ARGUMENT' })
  })

  it('add_emotion clamps intensity to [1,5]', async () => {
    const ok = parse(await executeTool('add_emotion', { emotion: 'happy', intensity: 99, trigger: 'test' }))
    expect(ok).toMatchObject({ ok: true, tool: 'add_emotion' })
    expect(ok.entry.intensity).toBe(5)
  })

  it('add_relationship_event validates type enum', async () => {
    const bad = parse(await executeTool('add_relationship_event', { type: 'random', summary: 'x' }))
    expect(bad).toMatchObject({ ok: false, error: 'INVALID_ARGUMENT' })
  })

  it('add_relationship_event accepts milestone', async () => {
    const ok = parse(await executeTool('add_relationship_event', { type: 'milestone', summary: '首次测试通过' }))
    expect(ok).toMatchObject({ ok: true, tool: 'add_relationship_event' })
  })
})

describe('new read-only system tools', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-new-tools-'))
    setAuthorizedRoots([root])
    await fs.writeFile(path.join(root, 'contract.txt'), 'hello')
    await fs.writeFile(path.join(root, 'notes.md'), 'notes')
    await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0x00, 0xff, 0x42]))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('cpu_usage returns CPU and memory info', async () => {
    const result = parse(await executeTool('cpu_usage', {}))
    expect(result).toMatchObject({
      ok: true,
      cpu: {
        overallUsagePercent: expect.any(Number),
        coreCount: expect.any(Number),
        perCore: expect.any(Array),
        model: expect.any(String),
      },
      memory: {
        totalBytes: expect.any(Number),
        availableBytes: expect.any(Number),
        usedBytes: expect.any(Number),
        usedPercentage: expect.any(Number),
      },
      sampledAt: expect.any(String),
    })
    expect(result.cpu.coreCount).toBeGreaterThan(0)
    expect(result.memory.totalBytes).toBeGreaterThan(0)
  })

  it('list_recent_files with "昨天" resolves time and returns matching files', async () => {
    // Set a file mtime to yesterday so it falls within the resolved range
    const targetFile = path.join(root, 'yesterday-report.md')
    await fs.writeFile(targetFile, 'yesterday work')
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await fs.utimes(targetFile, yesterday, yesterday)

    const result = parse(await executeTool('list_recent_files', { timeExpression: '昨天', directory: root }))
    expect(result).toMatchObject({ ok: true, timeExpression: '昨天' })
    expect(result.resolvedRange.matched).toBe('昨天')
    expect(result.results).toBeInstanceOf(Array)
    const names = result.results.map((r: { name: string }) => r.name)
    expect(names).toContain('yesterday-report.md')
  })

  it('list_recent_files with an unparseable time expression returns TIME_PARSE_FAILED', async () => {
    const result = parse(await executeTool('list_recent_files', { timeExpression: 'xyz123无法识别的表达式', directory: root }))
    expect(result).toMatchObject({ ok: false, error: 'TIME_PARSE_FAILED' })
  })

  it('read_file_content reads a text file', async () => {
    const result = parse(await executeTool('read_file_content', { path: path.join(root, 'contract.txt') }))
    expect(result).toMatchObject({
      ok: true,
      path: path.join(root, 'contract.txt'),
      content: 'hello',
      encoding: 'utf-8',
    })
    expect(result.bytesRead).toBe(5)
  })

  it('read_file_content rejects an unauthorized path', async () => {
    const result = parse(await executeTool('read_file_content', { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }))
    expect(result).toMatchObject({ ok: false, error: 'ACCESS_DENIED' })
  })

  it('read_file_content rejects a non-text extension', async () => {
    const result = parse(await executeTool('read_file_content', { path: path.join(root, 'image.bin') }))
    expect(result).toMatchObject({ ok: false, error: 'UNSUPPORTED_TYPE' })
  })
})

describe('phase 5 tools: analyze_file, launch_app, take_screenshot', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-phase5-'))
    setAuthorizedRoots([root])
    await fs.writeFile(path.join(root, 'contract.txt'), 'hello')
    await fs.writeFile(path.join(root, 'notes.md'), '# Notes\nThis is a note.')
    await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0x00, 0xff, 0x42]))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('analyze_file reads a text file and returns content', async () => {
    const result = parse(await executeTool('analyze_file', { path: path.join(root, 'contract.txt') }))
    expect(result).toMatchObject({
      ok: true,
      path: path.join(root, 'contract.txt'),
      fileName: 'contract.txt',
      fileType: '.txt',
    })
    expect(result.content).toBe('hello')
    expect(result.contentLength).toBe(5)
    expect(result.truncated).toBe(false)
    expect(result.analysisPrompt).toContain('contract.txt')
  })

  it('analyze_file rejects an unauthorized path', async () => {
    const result = parse(await executeTool('analyze_file', { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }))
    expect(result).toMatchObject({ ok: false, error: 'ACCESS_DENIED' })
  })

  it('analyze_file rejects an unsupported extension', async () => {
    const result = parse(await executeTool('analyze_file', { path: path.join(root, 'image.bin') }))
    expect(result).toMatchObject({ ok: false, error: 'UNSUPPORTED_TYPE' })
  })

  it('launch_app bridges the found path to the desktop with a toolId', async () => {
    await fs.writeFile(path.join(root, 'testapp.exe'), 'fake app content')
    const result = parse(await executeTool('launch_app', { app_name: 'testapp' }))
    expect(result).toMatchObject({ ok: false, error: 'DESKTOP_REQUIRED', tool: 'launch_app' })
    expect(result.input).toMatchObject({ program: expect.stringContaining('testapp.exe') })
    expect(typeof result.toolId).toBe('string')
  })

  it('launch_app returns error for empty app_name', async () => {
    const result = parse(await executeTool('launch_app', { app_name: '' }))
    expect(result).toMatchObject({ ok: false, error: 'INVALID_ARGUMENT' })
  })

  it('does not mistake a matching folder for an executable', async () => {
    await fs.mkdir(path.join(root, 'folderonly'))
    const result = parse(await executeTool('launch_program', { app_name: 'folderonly' }))
    expect(result).toMatchObject({ error: 'DESKTOP_REQUIRED', input: { program: 'folderonly' } })
  })

  it('denies shell interpreters and command arguments before desktop dispatch', async () => {
    expect(parse(await executeTool('launch_program', { app_name: 'powershell.exe' }))).toMatchObject({ error: 'POLICY_DENIED' })
    expect(parse(await executeTool('launch_program', { app_name: 'notepad.exe', args: ['-Command', 'echo hi'] }))).toMatchObject({ error: 'POLICY_DENIED' })
  })

  it('take_screenshot returns ok with region info', async () => {
    const result = parse(await executeTool('take_screenshot', { region: 'window' }))
    expect(result).toMatchObject({ ok: true, region: 'window' })
    expect(result.message).toEqual(expect.any(String))
  })
})

describe('find_program tool', () => {
  it('rejects empty query (INVALID_ARGUMENT)', async () => {
    const result = parse(await executeTool('find_program', { query: '' }))
    expect(result).toMatchObject({ ok: false, error: 'INVALID_ARGUMENT' })
  })

  it('rejects missing query (INVALID_ARGUMENT)', async () => {
    const result = parse(await executeTool('find_program', {}))
    expect(result).toMatchObject({ ok: false, error: 'INVALID_ARGUMENT' })
  })

  it('rejects non-string query', async () => {
    const result = parse(await executeTool('find_program', { query: 123 }))
    expect(result).toMatchObject({ ok: false, error: 'INVALID_ARGUMENT' })
  })

  it('returns ok with searched_locations structure for valid query', async () => {
    const result = parse(await executeTool('find_program', { query: 'definitely_not_existing_app_xyz' }))
    expect(result).toMatchObject({ ok: true })
    expect(result.query).toBe('definitely_not_existing_app_xyz')
    expect(Array.isArray(result.results)).toBe(true)
    expect(result.total).toBe(0)  // 不存在的程序应该返回 0 结果
    expect(result.searched_locations).toBeDefined()
    expect(Array.isArray(result.searched_locations.start_menu)).toBe(true)
    expect(Array.isArray(result.searched_locations.install_dirs)).toBe(true)
  }, 60000)  // 全盘搜索回退可能很慢，给 60 秒

  it('finds a real system program (notepad on Windows)', async () => {
    if (process.platform !== 'win32') return  // 仅 Windows 测试
    const result = parse(await executeTool('find_program', { query: 'notepad' }))
    expect(result.ok).toBe(true)
    expect(result.total).toBeGreaterThan(0)
    expect(Array.isArray(result.results)).toBe(true)
    // 至少有一个结果包含 notepad 关键字
    const hasMatch = result.results.some((r: any) =>
      r.name.toLowerCase().includes('notepad') || r.path.toLowerCase().includes('notepad')
    )
    expect(hasMatch).toBe(true)
  }, 15000)  // 给 15 秒超时

  it('clamps max_results to [1, 50]', async () => {
    const r1 = parse(await executeTool('find_program', { query: 'test', max_results: 0 }))
    expect(r1.ok).toBe(true)  // 0 被钳制到 1
    const r2 = parse(await executeTool('find_program', { query: 'test', max_results: 100 }))
    expect(r2.ok).toBe(true)  // 100 被钳制到 50
  })
})

describe('ModelRouter connectivity', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('selectProvider returns online state when fetch succeeds', async () => {
    vi.useFakeTimers()
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mockFetch)
    const router = new ModelRouter()
    const selection = await router.selectProvider()
    expect(selection.online).toBe(true)
    expect(selection.fallback).toBe(false)
    expect(selection.reason).toContain('Online')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('selectProvider returns offline when fetch fails', async () => {
    vi.useFakeTimers()
    const mockFetch = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', mockFetch)
    const router = new ModelRouter()
    const selection = await router.selectProvider()
    expect(selection.online).toBe(false)
    expect(selection.provider).toBe('none')
    expect(selection.fallback).toBe(true)
  })
})

describe('batch_move_files tool', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-batch-move-'))
    setAuthorizedRoots([root])
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('returns CONFIRMATION_REQUIRED for valid input', async () => {
    const file1 = path.join(root, 'a.txt')
    const file2 = path.join(root, 'b.txt')
    await fs.writeFile(file1, 'a')
    await fs.writeFile(file2, 'b')
    const targetDir = path.join(root, 'moved')
    const result = parse(await executeTool('batch_move_files', { files: [file1, file2], target_dir: targetDir }))
    expect(result).toMatchObject({ ok: false, error: 'CONFIRMATION_REQUIRED' })
    expect(result.action).toMatchObject({ name: 'batch_move_files', risk: 'L3' })
  })

  it('rejects an unauthorized source path', async () => {
    const file1 = path.join(root, 'a.txt')
    await fs.writeFile(file1, 'a')
    const result = parse(await executeTool('batch_move_files', { files: [file1, 'C:\\Windows\\System32\\drivers\\etc\\hosts'], target_dir: path.join(root, 'moved') }))
    expect(result).toMatchObject({ ok: false, error: 'ACCESS_DENIED' })
  })

  it('rejects an unauthorized target directory', async () => {
    const file1 = path.join(root, 'a.txt')
    await fs.writeFile(file1, 'a')
    const result = parse(await executeTool('batch_move_files', { files: [file1], target_dir: 'C:\\Windows\\Temp' }))
    expect(result).toMatchObject({ ok: false, error: 'ACCESS_DENIED' })
  })

  it('rejects too many files (>50)', async () => {
    const files = Array.from({ length: 51 }, (_, i) => path.join(root, `file${i}.txt`))
    const result = parse(await executeTool('batch_move_files', { files, target_dir: path.join(root, 'moved') }))
    expect(result).toMatchObject({ ok: false, error: 'TOO_MANY_FILES' })
  })
})
