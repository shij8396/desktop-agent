import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { access, copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { config } from './config.js'
import { getAuthorizedRoots } from './tools.js'
import { recordActionAudit } from './audit.js'
import { createDocx, editDocx } from './wordDoc.js'

export type ActionName =
  | 'open_file'
  | 'write_file'
  | 'batch_move_files'
  | 'delete_file'
  | 'copy_file'
  | 'move_file'
  | 'rename_file'
  | 'create_folder'
  | 'create_docx'
  | 'edit_docx'
type ActionStatus = 'pending' | 'approved' | 'expired' | 'rejected' | 'failed'

export interface PendingAction {
  id: string
  name: ActionName
  input: Record<string, unknown>
  status: ActionStatus
  risk: 'L2' | 'L3'
  createdAt: string
  expiresAt: string
  taskId?: string
  sessionId?: string
  result?: Record<string, unknown>
}

const actions = new Map<string, PendingAction>()
const inFlightConfirmations = new Map<string, Promise<Record<string, unknown>>>()
const ACTION_TTL_MS = 60_000
const MAX_WRITE_SIZE = 1_000_000
const ACTIONS_FILE = join(config.dataDir, 'pending-actions.json')
const PERSIST_ACTIONS = process.env.NODE_ENV !== 'test' && !process.env.VITEST

loadPersistedActions()

function hasAuthorizedPath(pathValue: string): boolean {
  const target = resolve(pathValue)
  return getAuthorizedRoots().some(root => {
    const rel = relative(root, target)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
  })
}

function validate(name: ActionName, input: Record<string, unknown>): string | null {
  if (name === 'batch_move_files') {
    if (!Array.isArray(input.files) || input.files.length === 0) return 'files must be a non-empty array'
    if (input.files.length > 50) return 'Maximum 50 files per batch'
    for (const f of input.files) {
      if (typeof f !== 'string' || !hasAuthorizedPath(f)) return 'Source file outside authorized directories'
    }
    if (typeof input.target_dir !== 'string' || !hasAuthorizedPath(input.target_dir)) return 'Target directory outside authorized directories'
    return null
  }
  if (name === 'create_docx' || name === 'edit_docx') {
    if (typeof input.path !== 'string' || !input.path || !hasAuthorizedPath(input.path) || extname(input.path).toLowerCase() !== '.docx') {
      return 'Word document target must be a .docx file inside an authorized directory'
    }
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > MAX_WRITE_SIZE) {
      return 'Word document content must be non-empty and at most 1 MB'
    }
    return null
  }
  // delete_file / open_file / write_file — 单路径校验
  if (name === 'delete_file' || name === 'open_file' || name === 'write_file') {
    if (typeof input.path !== 'string' || !input.path || !hasAuthorizedPath(input.path)) return 'Target is outside user-authorized directories'
    if (name === 'write_file' && (typeof input.content !== 'string' || input.content.length > MAX_WRITE_SIZE)) return 'Text content must be at most 1 MB'
    return null
  }
  // copy_file / move_file — 源路径 + 目标目录校验
  if (name === 'copy_file' || name === 'move_file') {
    if (typeof input.source !== 'string' || !input.source || !hasAuthorizedPath(input.source)) return 'Source is outside user-authorized directories'
    if (typeof input.target_dir !== 'string' || !input.target_dir || !hasAuthorizedPath(input.target_dir)) return 'Target directory is outside user-authorized directories'
    return null
  }
  // rename_file — 旧路径 + 新名称校验
  if (name === 'rename_file') {
    if (typeof input.path !== 'string' || !input.path || !hasAuthorizedPath(input.path)) return 'Target is outside user-authorized directories'
    if (typeof input.new_name !== 'string' || !input.new_name || /[\\/:*?"<>|]/.test(input.new_name)) return 'new_name contains invalid filename characters'
    return null
  }
  // create_folder — 父目录 + 文件夹名校验
  if (name === 'create_folder') {
    if (typeof input.parent_dir !== 'string' || !input.parent_dir || !hasAuthorizedPath(input.parent_dir)) return 'Parent directory is outside user-authorized directories'
    if (typeof input.folder_name !== 'string' || !input.folder_name || /[\\/:*?"<>|]/.test(input.folder_name)) return 'folder_name contains invalid filename characters'
    return null
  }
  return null
}

export async function createPendingAction(
  name: ActionName,
  input: Record<string, unknown>,
  context?: { taskId?: string; sessionId?: string },
): Promise<Record<string, unknown>> {
  const error = validate(name, input)
  if (error) return { ok: false, error: 'POLICY_DENIED', message: error }
  const now = Date.now()
  if (context?.taskId) {
    const existing = [...actions.values()].find(item => item.taskId === context.taskId && item.name === name && sameInput(item.input, input))
    if (existing) {
      if (existing.status === 'approved') return existing.result ?? { ok: true, action: publicAction(existing) }
      if (existing.status === 'rejected') return { ok: false, error: 'ACTION_REJECTED', action: publicAction(existing), message: '用户拒绝了该操作。' }
      if (existing.status === 'failed') return existing.result ?? { ok: false, error: 'ACTION_FAILED', action: publicAction(existing) }
      if (existing.status === 'pending' && Date.parse(existing.expiresAt) >= now) {
        return { ok: false, error: 'CONFIRMATION_REQUIRED', action: publicAction(existing), message: `${name} requires explicit confirmation within 60 seconds` }
      }
    }
  }
  // delete_file / batch_move_files 为 L3（不可逆），其余 L2
  const risk: 'L2' | 'L3' = name === 'delete_file' || name === 'batch_move_files' || name === 'edit_docx' ? 'L3' : 'L2'
  const action: PendingAction = {
    id: randomUUID(), name, input, status: 'pending', risk,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ACTION_TTL_MS).toISOString(),
    taskId: context?.taskId, sessionId: context?.sessionId,
  }
  actions.set(action.id, action)
  persistActions()
  await recordActionAudit('requested', action)
  return { ok: false, error: 'CONFIRMATION_REQUIRED', action: publicAction(action), message: `${name} requires explicit confirmation within 60 seconds` }
}

function publicAction(action: PendingAction) {
  const target = typeof action.input.path === 'string' ? action.input.path : ''
  return {
    id: action.id, name: action.name, risk: action.risk, target,
    createdAt: action.createdAt, expiresAt: action.expiresAt, status: action.status,
    taskId: action.taskId, sessionId: action.sessionId,
    warning: action.name === 'edit_docx' ? '将重建并覆盖现有 Word 文档；确认后先备份原文件，复杂格式可能丢失。' : undefined,
  }
}

export async function confirmAction(id: string): Promise<Record<string, unknown>> {
  const running = inFlightConfirmations.get(id)
  if (running) return running
  const confirmation = runConfirmedAction(id)
  inFlightConfirmations.set(id, confirmation)
  try { return await confirmation } finally { inFlightConfirmations.delete(id) }
}

async function runConfirmedAction(id: string): Promise<Record<string, unknown>> {
  const action = actions.get(id)
  if (!action) return { ok: false, error: 'ACTION_NOT_FOUND' }
  if (action.status === 'approved' && action.result) return action.result
  if (action.status !== 'pending') return { ok: false, error: 'ACTION_NOT_PENDING', action: publicAction(action) }
  if (Date.now() > Date.parse(action.expiresAt)) {
    action.status = 'expired'
    persistActions()
    await recordActionAudit('expired', action)
    return { ok: false, error: 'ACTION_EXPIRED', action: publicAction(action) }
  }
  const validation = validate(action.name, action.input)
  if (validation) return { ok: false, error: 'POLICY_DENIED', message: validation }
  try {
    let documentResult: unknown
    if (action.name === 'create_docx' || action.name === 'edit_docx') {
      const result = action.name === 'create_docx'
        ? await createDocx(String(action.input.path), String(action.input.content))
        : await editDocx(String(action.input.path), String(action.input.content))
      if (!result.ok) throw new Error(result.message || result.error || 'Word document operation failed')
      documentResult = result
    }
    if (action.name === 'open_file') await openWithDefaultApp(String(action.input.path))
    if (action.name === 'write_file') {
      const target = resolve(String(action.input.path))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, String(action.input.content), 'utf8')
    }
    if (action.name === 'batch_move_files') {
      const files = action.input.files as string[]
      const targetDir = resolve(String(action.input.target_dir))
      await mkdir(targetDir, { recursive: true })
      const results: Array<{ file: string; success: boolean; error?: string }> = []
      for (const f of files) {
        try {
          const src = resolve(f)
          const fileName = basename(src)
          const dest = join(targetDir, fileName)
          // Don't overwrite — append number if exists
          let finalDest = dest
          let counter = 1
          while (await access(finalDest).then(() => true).catch(() => false)) {
            const ext = extname(dest)
            const base = basename(dest, ext)
            finalDest = join(targetDir, `${base}_${counter}${ext}`)
            counter++
          }
          await rename(src, finalDest)
          results.push({ file: f, success: true })
        } catch (moveError) {
          results.push({ file: f, success: false, error: moveError instanceof Error ? moveError.message : String(moveError) })
        }
      }
      const failedMoves = results.filter(item => !item.success)
      action.status = failedMoves.length ? 'failed' : 'approved'
      await recordActionAudit(failedMoves.length ? 'failed' : 'approved', action)
      const response = failedMoves.length
        ? { ok: false, error: 'PARTIAL_FAILURE', message: `${failedMoves.length} 个文件移动失败`, action: publicAction(action), results }
        : { ok: true, action: publicAction(action), results }
      action.result = response
      persistActions()
      return response
    }
    // === 新增文件操作工具 ===
    if (action.name === 'delete_file') {
      const target = resolve(String(action.input.path))
      await rm(target, { recursive: true, force: false })
    }
    if (action.name === 'copy_file') {
      const src = resolve(String(action.input.source))
      const targetDir = resolve(String(action.input.target_dir))
      await mkdir(targetDir, { recursive: true })
      const fileName = basename(src)
      let dest = join(targetDir, fileName)
      let counter = 1
      while (await access(dest).then(() => true).catch(() => false)) {
        const ext = extname(fileName)
        const base = basename(fileName, ext)
        dest = join(targetDir, `${base}_${counter}${ext}`)
        counter++
      }
      await copyFile(src, dest)
    }
    if (action.name === 'move_file') {
      const src = resolve(String(action.input.source))
      const targetDir = resolve(String(action.input.target_dir))
      await mkdir(targetDir, { recursive: true })
      const fileName = basename(src)
      let dest = join(targetDir, fileName)
      let counter = 1
      while (await access(dest).then(() => true).catch(() => false)) {
        const ext = extname(fileName)
        const base = basename(fileName, ext)
        dest = join(targetDir, `${base}_${counter}${ext}`)
        counter++
      }
      await rename(src, dest)
    }
    if (action.name === 'rename_file') {
      const target = resolve(String(action.input.path))
      const dir = dirname(target)
      const newName = String(action.input.new_name)
      const dest = join(dir, newName)
      if (await access(dest).then(() => true).catch(() => false)) {
        throw new Error(`目标已存在: ${newName}`)
      }
      await rename(target, dest)
    }
    if (action.name === 'create_folder') {
      const parentDir = resolve(String(action.input.parent_dir))
      const folderName = String(action.input.folder_name)
      const newFolder = join(parentDir, folderName)
      if (await access(newFolder).then(() => true).catch(() => false)) {
        throw new Error(`文件夹已存在: ${newFolder}`)
      }
      await mkdir(newFolder, { recursive: false })
    }
    action.status = 'approved'
    await recordActionAudit('approved', action)
    const response = { ok: true, action: publicAction(action), ...(documentResult ? { result: documentResult } : {}) }
    action.result = response
    persistActions()
    return response
  } catch (error) {
    action.status = 'failed'
    const response = { ok: false, error: 'ACTION_FAILED', message: error instanceof Error ? error.message : String(error), action: publicAction(action) }
    action.result = response
    persistActions()
    await recordActionAudit('failed', action)
    return response
  }
}

export async function rejectAction(id: string): Promise<Record<string, unknown>> {
  const action = actions.get(id)
  if (!action) return { ok: false, error: 'ACTION_NOT_FOUND' }
  if (action.status !== 'pending') return { ok: false, error: 'ACTION_NOT_PENDING', action: publicAction(action) }
  action.status = 'rejected'
  persistActions()
  await recordActionAudit('rejected', action)
  return { ok: true, rejected: true, action: publicAction(action) }
}

export function listPendingActions(): Record<string, unknown>[] {
  const now = Date.now()
  let changed = false
  const result = [...actions.values()].map(action => {
    if (action.status === 'pending' && Date.parse(action.expiresAt) < now) {
      action.status = 'expired'
      changed = true
    }
    return publicAction(action)
  })
  if (changed) persistActions()
  return result
}

/** Confirmed Word creations only; never exposes document content to the agent verifier. */
export function getApprovedDocxCreations(taskId: string): Array<{ path: string; actionId: string }> {
  return [...actions.values()]
    .filter(action => action.taskId === taskId && action.name === 'create_docx'
      && action.status === 'approved' && action.result?.ok === true
      && typeof action.input.path === 'string')
    .map(action => ({ path: String(action.input.path), actionId: action.id }))
}

function openWithDefaultApp(path: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(command, [path], { timeout: 10_000, windowsHide: true }, error => error ? reject(error) : resolvePromise())
  })
}

function sameInput(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return stableStringify(left) === stableStringify(right)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function loadPersistedActions(): void {
  if (!PERSIST_ACTIONS || !existsSync(ACTIONS_FILE)) return
  try {
    const parsed = JSON.parse(readFileSync(ACTIONS_FILE, 'utf8'))
    if (!Array.isArray(parsed)) return
    for (const item of parsed) {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.input !== 'object') continue
      actions.set(item.id, item as PendingAction)
    }
  } catch {
    // A corrupt optional recovery file must not block assistant startup.
  }
}

function persistActions(): void {
  if (!PERSIST_ACTIONS) return
  try {
    mkdirSync(dirname(ACTIONS_FILE), { recursive: true })
    writeFileSync(ACTIONS_FILE, JSON.stringify([...actions.values()], null, 2), 'utf8')
  } catch {
    // The audit log still records the request; persistence failure is surfaced
    // by the absence of recovery after restart rather than weakening policy.
  }
}
