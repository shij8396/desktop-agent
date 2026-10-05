/**
 * wordDoc — Word 文档生成/编辑（基于 docx 库）。
 *
 * 能力：
 * - createDocx：用轻量 markdown（标题/列表/表格/段落/加粗）生成 .docx
 * - editDocx：读出现有文档文本（复用 document.ts 的 loadDocument），用新内容重建覆盖
 *
 * 说明：docx 库不支持通用原地编辑，复杂排版（图片/批注/宏）会在重建时丢失。
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } from 'docx'
import { writeFile, mkdir, copyFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { createLogger } from './logger.js'
import { loadDocument } from './document.js'
import { isAuthorizedPath, expandHome, getAuthorizedRoots } from './pathPolicy.js'

const log = createLogger('word')
const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const

export interface DocxResult {
  ok: boolean
  path?: string
  backupPath?: string
  error?: string
  message?: string
}

/** 解析轻量 markdown → docx Paragraph/Table 节点。 */
export function markdownToDocx(content: string): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = []
  const lines = content.split(/\r?\n/)

  let tableBuffer: string[][] = []
  const flushTable = () => {
    if (tableBuffer.length === 0) return
    const rows = tableBuffer.map(
      cells =>
        new TableRow({
          children: cells.map(
            cell =>
              new TableCell({
                children: [new Paragraph({ children: renderInline(cell.trim()) })],
              }),
          ),
        }),
    )
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows,
    }))
    tableBuffer = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    // 表格行 | a | b |
    if (line.trimStart().startsWith('|') && line.trim().endsWith('|') && line.includes('|') && line.split('|').length > 2) {
      const cells = line
        .trim()
        .slice(1, -1)
        .split('|')
        .map(c => c.trim())
      tableBuffer.push(cells)
      continue
    }
    flushTable()

    // 分隔行 --- 或 ===，忽略
    if (/^[-=]{3,}\s*$/.test(line.trim())) {
      children.push(new Paragraph({ text: line.trim(), alignment: AlignmentType.CENTER }))
      continue
    }

    // 标题
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6) as 1 | 2 | 3 | 4 | 5 | 6
      children.push(new Paragraph({ children: renderInline(headingMatch[2]), heading: HEADING_LEVELS[level - 1] }))
      continue
    }

    // 无序列表
    if (/^\s*[-*•]\s+/.test(line)) {
      children.push(new Paragraph({ children: renderInline(line.replace(/^\s*[-*•]\s+/, '')), bullet: { level: 0 } }))
      continue
    }

    // 有序列表 1. xxx
    const orderedMatch = line.match(/^\s*(\d+)[.、]\s+(.+)$/)
    if (orderedMatch) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${orderedMatch[1]}. `, bold: true }),
            ...renderInline(orderedMatch[2]),
          ],
        }),
      )
      continue
    }

    // 空行 → 间隔
    if (!line.trim()) {
      children.push(new Paragraph({ text: '', spacing: { after: 60 } }))
      continue
    }

    // 普通段落
    children.push(new Paragraph({ children: renderInline(line) }))
  }
  flushTable()

  // 头部大标题：如果第一行是非标题文本，不额外插入；markdownToDocx 仅按输入转换
  return children
}

/** **加粗** 与 `代码` 行内渲染。 */
function renderInline(text: string): (TextRun | TextRun)[] {
  const runs: TextRun[] = []
  // 先按代码片段切分，再在片段内处理加粗
  const codeParts = text.split(/(`[^`]+`)/g)
  for (const part of codeParts) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      runs.push(new TextRun({ text: part.slice(1, -1), font: 'Consolas', size: 21 }))
      continue
    }
    // 加粗 **xxx**
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g)
    for (const bp of boldParts) {
      if (bp.startsWith('**') && bp.endsWith('**') && bp.length > 4) {
        runs.push(new TextRun({ text: bp.slice(2, -2), bold: true }))
      } else if (bp) {
        runs.push(new TextRun({ text: bp }))
      }
    }
  }
  return runs
}

/** 解析目标路径：支持 "桌面/xx.docx"、"文档/xx.docx" 这类中文意图路径映射到真实目录。 */
function resolveDocxPath(targetPath: string): string {
  const t = targetPath.trim()
  const home = os.homedir()
  if (/^桌面[\\/]/.test(t) || /^Desktop[\\/]/i.test(t)) return path.join(home, 'Desktop', t.replace(/^桌面[\\/]/i, '').replace(/^Desktop[\\/]/i, ''))
  if (/^文档[\\/]/.test(t) || /^Documents[\\/]/i.test(t)) return path.join(home, 'Documents', t.replace(/^文档[\\/]/i, '').replace(/^Documents[\\/]/i, ''))
  return expandHome(targetPath)
}

/**
 * 纠正用户目录前缀写错/写占位符的路径（如 C:\Users\Public\... 或 C:\Users\当前用户\...），
 * 统一改写为真实用户主目录。只影响 Users\<任意名> 前缀段，不改其余部分。
 */
function rewriteUserPath(targetPath: string): string {
  const m = targetPath.trim().match(/^([a-zA-Z]:[\\/])Users[\\/][^\\/]+/)
  if (!m) return targetPath
  const rest = targetPath.trim().slice(m[0].length)
  return path.join(os.homedir(), rest)
}

/** 校验并解析目标路径：纠偏后在授权白名单内且扩展名为 .docx 才返回 path，否则返回 error。 */
function resolveTargetPath(targetPath: string): { path?: string; error?: string } {
  const original = targetPath.trim()
  let expanded = resolveDocxPath(original)
  if (!expanded || typeof expanded !== 'string') return { error: '参数 path 必须是字符串' }
  if (path.extname(expanded).toLowerCase() !== '.docx') return { error: '文件扩展名必须是 .docx' }

  if (!isAuthorizedPath(expanded)) {
    // 兜底纠偏：若只是用户目录写错/占位（Users\Public、Users\当前用户 等），改写为真实用户目录
    const rewritten = rewriteUserPath(original)
    const expandedRewritten = expanded === resolveDocxPath(rewritten) ? expanded : resolveDocxPath(rewritten)
    if (expandedRewritten !== expanded && isAuthorizedPath(expandedRewritten)) {
      expanded = expandedRewritten
    } else {
      const roots = getAuthorizedRoots().join(', ')
      return { error: `目标路径不在授权目录内(当前授权: ${roots || '无'})，仅允许写入桌面、文档、临时目录等授权位置` }
    }
  }
  return { path: expanded }
}

/** 生成新 Word 文档。 */
export async function createDocx(targetPath: string, content: string): Promise<DocxResult> {
  const resolved = resolveTargetPath(targetPath)
  if (resolved.error) return { ok: false, error: 'ACCESS_DENIED', message: resolved.error }

  const expanded = resolved.path!
  try {
    const buf = await toDocxBuffer(content)
    await mkdir(path.dirname(expanded), { recursive: true })
    await writeFile(expanded, buf, { flag: 'wx' })
    await loadDocument(expanded)
    log.info('createDocx ok', { path: expanded, bytes: buf.byteLength })
    return { ok: true, path: expanded, message: `已生成 Word 文档: ${expanded}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('createDocx failed', { path: expanded, error: msg })
    return { ok: false, error: (e as NodeJS.ErrnoException).code === 'EEXIST' ? 'ALREADY_EXISTS' : 'WRITE_FAILED', message: `生成文档失败: ${msg}` }
  }
}

/** 编辑既有 Word 文档：读出旧内容确认存在，再用新内容重建覆盖。 */
export async function editDocx(targetPath: string, newContent: string): Promise<DocxResult> {
  const resolved = resolveTargetPath(targetPath)
  if (resolved.error) return { ok: false, error: 'ACCESS_DENIED', message: resolved.error }

  const expanded = resolved.path!
  try {
    // 确认文件存在且能读取（不存在则报错）
    const oldText = await loadDocument(expanded)
    log.info('editDocx read previous', { path: expanded, chars: oldText.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: 'NOT_FOUND', message: `无法读取目标文档（文件可能不存在）: ${msg}` }
  }

  const backupPath = path.join(
    path.dirname(expanded),
    `${path.parse(expanded).name}.backup-${Date.now()}-${randomUUID().slice(0, 8)}.docx`,
  )
  try {
    const buf = await toDocxBuffer(newContent)
    await copyFile(expanded, backupPath, fsConstants.COPYFILE_EXCL)
    await writeFile(expanded, buf)
    await loadDocument(expanded)
    return { ok: true, path: expanded, backupPath, message: `已更新 Word 文档；原文件已备份到 ${backupPath}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('editDocx failed', { path: expanded, backupPath, error: msg })
    return { ok: false, error: 'WRITE_FAILED', backupPath, message: `更新文档失败: ${msg}` }
  }
}

/** markdown 内容 → .docx Buffer。 */
async function toDocxBuffer(content: string): Promise<Buffer> {
  const children = markdownToDocx(content)
  const doc = new Document({
    sections: [{ properties: {}, children }],
  })
  return Packer.toBuffer(doc)
}
