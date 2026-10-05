import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile as fsWriteFile, readFile as fsReadFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDocx, editDocx, markdownToDocx } from '../src/wordDoc.js'
import { setAuthorizedRoots, getAuthorizedRoots } from '../src/pathPolicy.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'worddoc-test-'))
  // 只授权临时目录，避免污染桌面；保存原白名单以恢复
  const savedRoots = getAuthorizedRoots()
  setAuthorizedRoots([tempDir])
  ;(globalThis as unknown as Record<string, unknown>).__savedRoots = savedRoots
})

afterEach(async () => {
  const saved = (globalThis as unknown as Record<string, unknown>).__savedRoots as string[]
  if (saved) setAuthorizedRoots(saved)
  await rm(tempDir, { recursive: true, force: true })
})

async function mammothText(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

describe('markdownToDocx', () => {
  it('解析标题/段落并保留文本', async () => {
    const { Document, Packer } = await import('docx')
    const doc = new Document({ sections: [{ properties: {}, children: markdownToDocx('# 周报\n本周完成模块开发') }] })
    const buf = await Packer.toBuffer(doc)
    const text = await mammothText(buf)
    expect(text).toContain('周报')
    expect(text).toContain('本周完成模块开发')
  })

  it('解析列表与表格', async () => {
    const { Document, Packer } = await import('docx')
    const md = '- 项目A\n- 项目B\n\n| 名称 | 状态 |\n| 登录 | 完成 |'
    const doc = new Document({ sections: [{ properties: {}, children: markdownToDocx(md) }] })
    const buf = await Packer.toBuffer(doc)
    const text = await mammothText(buf)
    expect(text).toContain('项目A')
    expect(text).toContain('登录')
  })
})

describe('createDocx', () => {
  it('生成成功后读回内容一致', async () => {
    const filePath = path.join(tempDir, 'report.docx')
    const res = await createDocx(filePath, '# 测试报告\n\n第一段内容')
    expect(res.ok).toBe(true)
    expect(res.path).toContain('report.docx')
    const buf = await fsReadFile(filePath)
    const text = await mammothText(buf)
    expect(text).toContain('测试报告')
    expect(text).toContain('第一段内容')
  })

  it('创建文档不会覆盖同名文件', async () => {
    const filePath = path.join(tempDir, 'existing.docx')
    expect((await createDocx(filePath, '原内容')).ok).toBe(true)
    const before = await fsReadFile(filePath)
    const second = await createDocx(filePath, '新内容')
    expect(second).toMatchObject({ ok: false, error: 'ALREADY_EXISTS' })
    expect(await fsReadFile(filePath)).toEqual(before)
  })

  it('非 .docx 扩展名被拒绝', async () => {
    const res = await createDocx(path.join(tempDir, 'report.txt'), '内容')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('ACCESS_DENIED')
  })

  it('白名单外路径被拒绝', async () => {
    const res = await createDocx('C:\\Windows\\System32\\evil.docx', '内容')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('ACCESS_DENIED')
  })

  it('用户目录前缀写错(Users\\Public)自动纠偏到真实用户目录', async () => {
    // 把授权临时目录中的真实用户名替换为 Public，模拟 LLM 猜错用户目录
    const wrong = tempDir.replace(/Users[\\/][^\\/]+/, 'Users\\Public')
    const filePath = path.join(wrong, 'pub-fixed.docx')
    expect(filePath).not.toBe(tempDir)
    const res = await createDocx(filePath, '# 待办\n纠偏测试')
    expect(res.ok).toBe(true)
    expect(res.path).toContain(tempDir)
    const buf = await fsReadFile(path.join(tempDir, 'pub-fixed.docx'))
    const text = await mammothText(buf)
    expect(text).toContain('纠偏测试')
  })
})

describe('editDocx', () => {
  it('已存在文件重建覆盖后读回新内容', async () => {
    const filePath = path.join(tempDir, 'edit.docx')
    const create = await createDocx(filePath, '# 旧标题\n旧内容')
    expect(create.ok).toBe(true)
    const edit = await editDocx(filePath, '# 新标题\n新内容')
    expect(edit.ok).toBe(true)
    expect(edit.backupPath).toBeTruthy()
    expect(await mammothText(await fsReadFile(edit.backupPath!))).toContain('旧标题')
    const buf = await fsReadFile(filePath)
    const text = await mammothText(buf)
    expect(text).toContain('新标题')
    expect(text).toContain('新内容')
    expect(text).not.toContain('旧标题')
  })

  it('不存在的文件报 NOT_FOUND', async () => {
    const filePath = path.join(tempDir, 'missing.docx')
    const res = await editDocx(filePath, '内容')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('NOT_FOUND')
  })
})
