import Anthropic from '@anthropic-ai/sdk'
import { exec, execFile } from 'child_process'
import vm from 'node:vm'
import { readFile, writeFile, mkdir, readdir, stat, unlink, rm } from 'fs/promises'
import { dirname, resolve, join, extname, basename, relative, isAbsolute } from 'path'
import { webSearch } from './webSearch.js'
import { createLogger } from './logger.js'
import { readSystemClipboard } from './clipboard.js'
import { homedir, tmpdir } from 'os'

const log = createLogger('tools')

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB max read
const EXEC_TIMEOUT = 15_000 // 15s

// Allowed base directories (user can access these freely)
const HOME = homedir()
const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const ALLOWED_ROOTS = [
  HOME,
  PROJECT_ROOT,
  resolve(PROJECT_ROOT, 'sample-docs'),
  resolve(PROJECT_ROOT, 'data'),
  resolve(PROJECT_ROOT, 'chat-history'),
]

// Truly dangerous paths that should never be touched
const BLOCKED_PATHS = [
  /Windows[\/\\]System32/i,
  /Windows[\/\\]SysWOW64/i,
  /\$Recycle\.Bin/i,
  /pagefile\.sys/i,
  /hiberfil\.sys/i,
  /swapfile\.sys/i,
  /\.ssh[\/\\]id_/i,
  /\.ssh[\/\\]known_hosts/i,
]

// ---- Tool Definitions ----

export const CORE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'web_search',
    description: 'Search the web for current events or unknown topics.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_search',
    description: 'Search local knowledge base for relevant documents.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate a math expression. Supports +, -, *, /, Math functions.',
    input_schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'get_datetime',
    description: 'Get current date and time.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
]

export const FILE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_files',
    description: 'List files in a directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file by full path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates dirs if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file or directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete' },
        recursive: { type: 'boolean', description: 'Delete recursively' },
      },
      required: ['path'],
    },
  },
  {
    name: 'open_file',
    description: 'Open file/folder with default app.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to open' },
      },
      required: ['path'],
    },
  },
  {
    name: 'find_files',
    description: 'Find files by name pattern in a directory.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory to search' },
        pattern: { type: 'string', description: 'Filename pattern (*.pdf, *temp*)' },
        maxDepth: { type: 'number', description: 'Max depth (default 3)' },
      },
      required: ['directory', 'pattern'],
    },
  },
  {
    name: 'disk_usage',
    description: 'Check disk space for a drive or directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Drive or directory' },
      },
      required: ['path'],
    },
  },
  {
    name: 'ingest_docs',
    description: 'Ingest documents (PDF, DOCX, TXT, MD, HTML) into knowledge base.',
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File or directory paths',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'read_clipboard',
    description: 'Read text from system clipboard.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
]

export const TOOLS: Anthropic.Tool[] = [...CORE_TOOLS, ...FILE_TOOLS]

// ---- Agent reference ----
let agentRef: { ingest: (paths: string[]) => Promise<number>; searchInKb: (query: string) => string } | null = null

export function setAgentRef(ref: typeof agentRef) {
  agentRef = ref
}

// ---- Safety Checks ----
// Whitelist: only these command bases are allowed (desktop assistant scope)
const ALLOWED_COMMANDS = [
  'whoami', 'hostname', 'date', 'uptime', 'ver',
  'ping', 'ipconfig', 'ifconfig', 'nslookup', 'tracert', 'traceroute',
  'tasklist', 'ps', 'top', 'free', 'vmstat',
  'df', 'du', 'dir', 'ls', 'tree', 'cat', 'head', 'tail', 'wc', 'file', 'stat',
  'git', 'npm', 'node', 'npx',
  'python', 'python3', 'pip', 'pip3',
  'echo', 'env', 'set', 'path', 'where', 'which', 'type', 'uname',
]

// Patterns that indicate command chaining or shell injection
const COMMAND_INJECTION = /[;&|`\$\(\)\{\}]|\|\||>/

function isSafePath(filePath: string): boolean {
  const resolved = resolve(filePath)
  if (BLOCKED_PATHS.some(p => p.test(resolved))) return false
  return ALLOWED_ROOTS.some(root => {
    const rel = relative(root, resolved)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
  })
}

function isSafeCommand(command: string): boolean {
  if (COMMAND_INJECTION.test(command)) return false
  const cmdBase = command.trim().split(/\s+/)[0].toLowerCase()
  return ALLOWED_COMMANDS.includes(cmdBase)
}

// ---- Tool Executor ----
export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  log.debug('Executing tool', { name, input: JSON.stringify(input).slice(0, 200) })

  try {
    switch (name) {
      case 'web_search': return await handleWebSearch(input.query as string)
      case 'kb_search': return handleKbSearch(input.query as string)
      case 'calculate': return handleCalculate(input.expression as string)
      case 'get_datetime': return handleGetDatetime()
      case 'list_files': return await handleListFiles(input.path as string)
      case 'read_file': return await handleReadFile(input.path as string)
      case 'write_file': return await handleWriteFile(input.path as string, input.content as string)
      case 'delete_file': return await handleDeleteFile(input.path as string, input.recursive as boolean)
      case 'open_file': return await handleOpenFile(input.path as string)
      case 'find_files': return await handleFindFiles(input.directory as string, input.pattern as string, (input.maxDepth as number) || 3)
      case 'disk_usage': return await handleDiskUsage(input.path as string)
      case 'exec_command': return await handleExecCommand(input.command as string)
      case 'ingest_docs': return await handleIngestDocs(input.paths as string[])
      case 'read_clipboard': return await handleReadClipboard()
      default: return `Error: Unknown tool "${name}"`
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log.error('Tool execution failed', { name, error: msg })
    return `Error executing ${name}: ${msg}`
  }
}

// ---- Tool Implementations ----

async function handleWebSearch(query: string): Promise<string> {
  const results = await webSearch(query, 5)
  if (results.length === 0) return 'No search results found.'

  return results.slice(0, 3).map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`
  ).join('\n\n')
}

function handleKbSearch(query: string): string {
  if (!agentRef) return 'Error: Knowledge base not available'
  return agentRef.searchInKb(query)
}

function handleCalculate(expression: string): string {
  // Allowlist: only safe math characters
  if (!/^[\d\s+\-*/%().,eE]+$/.test(expression) && !/Math\.\w+/.test(expression)) {
    return 'Error: Invalid characters in expression'
  }

  // Whitelist Math functions
  const sanitized = expression.replace(/Math\.\w+/g, (match) => {
    const allowed = ['Math.abs', 'Math.ceil', 'Math.floor', 'Math.round', 'Math.sqrt',
      'Math.pow', 'Math.log', 'Math.log10', 'Math.sin', 'Math.cos', 'Math.tan',
      'Math.PI', 'Math.E', 'Math.max', 'Math.min']
    return allowed.includes(match) ? match : 'undefined'
  })

  // Block prototype escapes
  if (/constructor|prototype|__proto__|eval|Function|import|require/.test(sanitized)) {
    return 'Error: Forbidden expression'
  }

  try {
    const result = vm.runInNewContext(sanitized, Object.create(null), { timeout: 1000 })
    return `Result: ${result}`
  } catch (error) {
    return `Error: Could not evaluate: ${error instanceof Error ? error.message : String(error)}`
  }
}

function handleGetDatetime(): string {
  const now = new Date()
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `Current time: ${now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })}\n` +
    `Date: ${now.toISOString().split('T')[0]}\n` +
    `Day: ${days[now.getDay()]}`
}

async function handleListFiles(dirPath: string): Promise<string> {
  if (!isSafePath(dirPath)) return `Error: Access denied to "${dirPath}"`

  const resolved = resolve(dirPath)
  try {
    const entries = await readdir(resolved, { withFileTypes: true })
    const lines: string[] = []

    for (const entry of entries.sort((a, b) => {
      // Directories first, then by name
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue // skip hidden files

      const fullPath = join(resolved, entry.name)
      if (entry.isDirectory()) {
        lines.push(`[DIR]  ${entry.name}/`)
      } else {
        try {
          const s = await stat(fullPath)
          const size = s.size > 1024 * 1024
            ? `${(s.size / 1024 / 1024).toFixed(1)}MB`
            : s.size > 1024
              ? `${(s.size / 1024).toFixed(1)}KB`
              : `${s.size}B`
          lines.push(`[FILE] ${entry.name}  (${size})`)
        } catch {
          lines.push(`[FILE] ${entry.name}`)
        }
      }
    }

    if (lines.length === 0) return `Directory is empty: ${resolved}`
    return `Contents of ${resolved}:\n${lines.join('\n')}`
  } catch (error) {
    return `Error listing directory: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function handleReadFile(filePath: string): Promise<string> {
  if (!isSafePath(filePath)) return `Error: Access denied to "${filePath}"`

  const resolved = resolve(filePath)
  try {
    const s = await stat(resolved)
    if (s.size > MAX_FILE_SIZE) {
      return `Error: File too large (${(s.size / 1024 / 1024).toFixed(1)}MB). Max is ${MAX_FILE_SIZE / 1024 / 1024}MB.`
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return `Error: File not found: "${filePath}"`
    if (code === 'EACCES') return `Error: Permission denied: "${filePath}"`
    throw error
  }

  const ext = extname(resolved).toLowerCase()
  // Binary formats that shouldn't be read as text
  const binaryExts = ['.exe', '.dll', '.so', '.dylib', '.bin', '.zip', '.rar', '.7z', '.jpg', '.jpeg', '.png', '.gif', '.mp3', '.mp4', '.avi', '.mov', '.woff', '.woff2', '.ttf', '.eot']
  if (binaryExts.includes(ext)) {
    return `Error: Cannot read binary file (${ext}). Use list_files to see file info.`
  }

  const content = await readFile(resolved, 'utf-8')
  if (content.length > MAX_FILE_SIZE) {
    return content.slice(0, MAX_FILE_SIZE) + '\n...(file truncated)'
  }
  return content
}

async function handleWriteFile(filePath: string, content: string): Promise<string> {
  if (!isSafePath(filePath)) return `Error: Access denied to "${filePath}"`

  const resolved = resolve(filePath)
  try {
    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, content, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES') return `Error: Permission denied: "${filePath}"`
    if (code === 'ENOSPC') return `Error: Disk full, cannot write to "${filePath}"`
    throw error
  }
  return `Successfully wrote ${content.length} characters to ${filePath}`
}

async function handleDeleteFile(filePath: string, recursive?: boolean): Promise<string> {
  if (!isSafePath(filePath)) return `Error: Access denied to "${filePath}"`

  const resolved = resolve(filePath)

  const dirName = basename(resolved)

  try {
    const s = await stat(resolved)
    if (s.isDirectory()) {
      // Block deleting project root or home dir
      if (resolved === PROJECT_ROOT || resolved === HOME) {
        return `Error: Cannot delete project root or home directory`
      }
      // Block recursive deletion of important user directories
      const important = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']
      if (important.some(d => d.toLowerCase() === dirName.toLowerCase()) && recursive) {
        return `Error: Refusing to recursively delete "${dirName}" — this is an important user directory. Delete specific files instead.`
      }
      if (recursive) {
        await rm(resolved, { recursive: true, force: true })
        return `Deleted directory and all contents: ${filePath}`
      } else {
        const entries = await readdir(resolved)
        if (entries.length > 0) {
          return `Error: Directory is not empty (${entries.length} items). Use recursive=true to delete all contents.`
        }
        await rm(resolved, { recursive: false })
        return `Deleted empty directory: ${filePath}`
      }
    } else {
      await unlink(resolved)
      return `Deleted file: ${filePath}`
    }
  } catch (error) {
    return `Error deleting: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function handleOpenFile(filePath: string): Promise<string> {
  if (!isSafePath(filePath)) return `Error: Access denied to "${filePath}"`

  const resolved = resolve(filePath)
  const command = process.platform === 'win32'
    ? 'powershell.exe'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open'
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-Command', 'Start-Process -LiteralPath $args[0]', resolved]
    : [resolved]

  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error) => {
      if (error) {
        resolve(`Error opening file: ${error.message}`)
      } else {
        resolve(`Opened: ${filePath}`)
      }
    })
  })
}

async function handleFindFiles(directory: string, pattern: string, maxDepth: number): Promise<string> {
  if (!isSafePath(directory)) return `Error: Access denied to "${directory}"`

  const resolved = resolve(directory)
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
  const matches: string[] = []

  async function search(dir: string, depth: number) {
    if (depth > maxDepth) return
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isFile() && regex.test(entry.name)) {
          matches.push(fullPath)
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await search(fullPath, depth + 1)
        }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  await search(resolved, 0)
  if (matches.length === 0) return `No files matching "${pattern}" found in ${resolved}`
  return `Found ${matches.length} file(s):\n${matches.join('\n')}`
}

async function handleDiskUsage(path: string): Promise<string> {
  const cmd = process.platform === 'win32'
    ? `wmic logicaldisk where "DeviceID='${path.replace(/[\/\\]/g, '')}'" get Size,FreeSpace /format:value`
    : `df -h "${path}"`

  return new Promise((resolve) => {
    exec(cmd, { timeout: 10000 }, (error, stdout) => {
      if (error) {
        resolve(`Error: ${error.message}`)
      } else {
        resolve(stdout.trim() || 'No output')
      }
    })
  })
}

async function handleExecCommand(command: string): Promise<string> {
  if (!isSafeCommand(command)) return `Error: Command blocked for security reasons`

  return new Promise((resolve) => {
    exec(command, {
      timeout: EXEC_TIMEOUT,
      maxBuffer: 1024 * 1024,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    }, (error, stdout, stderr) => {
      if (error) {
        resolve(`Error: ${error.message}\n${stderr}`.trim())
      } else {
        const output = stdout || stderr || '(no output)'
        resolve(output.length > 3000 ? output.slice(0, 3000) + '\n...(output truncated)' : output)
      }
    })
  })
}

async function handleIngestDocs(paths: string[]): Promise<string> {
  if (!agentRef) return 'Error: Knowledge base not available'
  const count = await agentRef.ingest(paths)
  return `Successfully ingested. Added ${count} chunks to knowledge base.`
}

async function handleReadClipboard(): Promise<string> {
  const { text, error } = await readSystemClipboard()
  if (error) return error
  return `Clipboard content:\n${text}`
}
