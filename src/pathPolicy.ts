/**
 * pathPolicy — 授权路径白名单。
 *
 * 从 tools.ts 抽出，供 tools.ts（文件类工具）与 wordDoc.ts（文档生成/编辑）共用，
 * 避免两模块互相 import 造成循环依赖。
 */

import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export function defaultAuthorizedRoots(): string[] {
  const configured = process.env.ASSISTANT_ALLOWED_ROOTS
  if (configured) return configured.split(';').filter(Boolean).map(root => resolve(root))

  const home = homedir()
  // TEMP and the project root are development-only conveniences. Production
  // policy must replace this via ASSISTANT_ALLOWED_ROOTS or the consent UI.
  return [join(home, 'Desktop'), join(home, 'Documents'), resolve(tmpdir()), resolve(import.meta.dirname, '..')]
}

let authorizedRoots = defaultAuthorizedRoots()

/** Set by the future directory-consent UI; exported to make the boundary testable. */
export function setAuthorizedRoots(roots: string[]): void {
  authorizedRoots = roots.map(root => resolve(root))
}

export function getAuthorizedRoots(): string[] {
  return [...authorizedRoots]
}

/**
 * 展开 ~/Desktop、~\Desktop 等带波浪号的路径为真实家目录。
 * Node 的 fs API 不自动展开 ~，必须手动处理。
 * 兼容：~/Desktop, ~\Desktop, ~, ~/Documents, ~/OneDrive/Desktop
 */
export function expandHome(p: string): string {
  if (typeof p !== 'string') return p
  // 匹配开头的 ~ 或 ~/ 或 ~\
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homedir(), p.slice(2))
  }
  if (p === '~\\' || p === '~/') return homedir()
  // Windows 风格 ~\Desktop 也处理（slice(2) 对 ~\ 也适用）
  if (p.startsWith('~')) {
    const rest = p.slice(1).replace(/^[\\/]/, '')
    return join(homedir(), rest)
  }
  return p
}

export function isAuthorizedPath(target: string): boolean {
  const resolved = resolve(target)
  return authorizedRoots.some(root => {
    const rel = relative(root, resolved)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
  })
}