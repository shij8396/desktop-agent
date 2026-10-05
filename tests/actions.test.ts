import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { confirmAction, createPendingAction, rejectAction } from '../src/actions.js'
import { executeTool, setAuthorizedRoots } from '../src/tools.js'

describe('confirmation workflow', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-actions-'))
    setAuthorizedRoots([root])
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('creates a one-time confirmation before writing a file', async () => {
    const target = path.join(root, 'result.txt')
    const pending = await createPendingAction('write_file', { path: target, content: 'approved content' })
    expect(pending).toMatchObject({ ok: false, error: 'CONFIRMATION_REQUIRED', action: { name: 'write_file', risk: 'L2' } })
    await expect(fs.access(target)).rejects.toThrow()

    const result = await confirmAction((pending.action as { id: string }).id)
    expect(result).toMatchObject({ ok: true, action: { status: 'approved' } })
    await expect(confirmAction((pending.action as { id: string }).id)).resolves.toMatchObject({ ok: true, action: { status: 'approved' } })
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('approved content')
  })

  it('records an explicit rejection without executing the action', async () => {
    const target = path.join(root, 'rejected.txt')
    const pending = await createPendingAction('write_file', { path: target, content: 'no' }, { taskId: 'reject-task', sessionId: 'reject-session' })
    const result = await rejectAction((pending.action as { id: string }).id)
    expect(result).toMatchObject({ ok: true, rejected: true, action: { status: 'rejected', taskId: 'reject-task' } })
    await expect(fs.access(target)).rejects.toThrow()
  })

  it('does not create actions outside authorized directories', async () => {
    const result = await createPendingAction('write_file', { path: path.resolve(root, '..', 'outside.txt'), content: 'no' })
    expect(result).toMatchObject({ ok: false, error: 'POLICY_DENIED' })
  })

  it('requires an existing pending id to confirm', async () => {
    await expect(confirmAction('00000000-0000-0000-0000-000000000000')).resolves.toMatchObject({ ok: false, error: 'ACTION_NOT_FOUND' })
  })

  it('coalesces simultaneous confirmations into one file move', async () => {
    const source = path.join(root, 'source.txt')
    const destination = path.join(root, 'moved')
    await fs.writeFile(source, 'once')
    const pending = await createPendingAction('move_file', { source, target_dir: destination })
    const id = (pending.action as { id: string }).id
    const [first, second] = await Promise.all([confirmAction(id), confirmAction(id)])
    expect(first).toMatchObject({ ok: true })
    expect(second).toEqual(first)
    await expect(fs.readFile(path.join(destination, 'source.txt'), 'utf8')).resolves.toBe('once')
  })

  it('reports a failed confirmed action without presenting it as pending', async () => {
    const target = path.join(root, 'missing.docx')
    const pending = await createPendingAction('edit_docx', { path: target, content: 'new text' })
    const id = (pending.action as { id: string }).id
    const result = await confirmAction(id)
    expect(result).toMatchObject({ ok: false, error: 'ACTION_FAILED', action: { status: 'failed' } })
    await expect(confirmAction(id)).resolves.toMatchObject({ ok: false, error: 'ACTION_NOT_PENDING' })
  })

  it('requires confirmation before editing Word and keeps a recoverable backup', async () => {
    const target = path.join(root, 'report.docx')
    const created = JSON.parse(await executeTool('create_docx', { path: target, content: '旧内容' }, { taskId: 'doc-create' }))
    expect(created).toMatchObject({ error: 'CONFIRMATION_REQUIRED', action: { risk: 'L2' } })
    await expect(fs.access(target)).rejects.toThrow()
    const createResult = await confirmAction(created.action.id)
    expect(createResult).toMatchObject({ ok: true, result: { path: target } })

    const pending = JSON.parse(await executeTool('edit_docx', { path: target, content: '新内容' }, { taskId: 'doc-edit' }))
    expect(pending).toMatchObject({ error: 'CONFIRMATION_REQUIRED', action: { risk: 'L3', warning: expect.stringContaining('备份') } })
    const before = await fs.readFile(target)
    expect(await fs.readFile(target)).toEqual(before)
    const edited = await confirmAction(pending.action.id)
    expect(edited).toMatchObject({ ok: true, result: { path: target, backupPath: expect.any(String) } })
    expect(await fs.readFile(edited.result.backupPath)).toEqual(before)
    expect(await fs.readFile(target)).not.toEqual(before)
  })
})
