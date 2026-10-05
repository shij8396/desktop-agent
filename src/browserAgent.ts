/**
 * browserAgent — 浏览器自动化（Playwright-core + 系统自带 Edge）。
 *
 * 共享单例 BrowserContext/Page：所有 browser_* 工具串行操作同一页面。
 * 复用系统 msedge（channel: 'msedge'，无需下载 Chromium）。
 *
 * 安全：页面操作在浏览器沙箱内，可逆无破坏性，仅需网络。
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright-core'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createLogger } from './logger.js'

const log = createLogger('browser')

export interface BrowserActionResult {
  ok: boolean
  error?: string
  message?: string
  url?: string
  title?: string
  text?: string
  data?: unknown
  screenshotPath?: string
  base64?: string
  openPages?: number
}

const NAV_TIMEOUT_MS = 30000
const STABILIZE_MS = 300

let browser: Browser | null = null
let context: BrowserContext | null = null
let page: Page | null = null

async function ensurePage(existing = false): Promise<Page> {
  if (!browser) {
    browser = await chromium.launch({
      channel: 'msedge',
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=AutomationControlled',
        '--no-first-run',
      ],
    })
  }
  if (!context) {
    context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1280, height: 900 },
      userAgent: undefined,
    })
    // 反自动化检测：隐藏 navigator.webdriver + 补全 chrome 标记
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      const win = window as unknown as { chrome?: { runtime?: Record<string, unknown> } }
      win.chrome = win.chrome || { runtime: {} }
    })
  }
  if (!page) {
    page = await context.newPage()
  } else if (existing && page.isClosed()) {
    page = await context.newPage()
  }
  return page
}

async function waitStable(): Promise<void> {
  await new Promise(r => setTimeout(r, STABILIZE_MS))
}

/** 打开/导航到指定 URL。 */
export async function open(url?: string): Promise<BrowserActionResult> {
  try {
    const p = await ensurePage()
    const target = url && url.trim() ? url.trim() : 'about:blank'
    await p.goto(target, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
    await waitStable()
    return { ok: true, url: p.url(), title: await p.title() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser open failed', { url, error: msg })
    return { ok: false, error: 'NAVIGATION_FAILED', message: `网页打开失败: ${msg}` }
  }
}

/**
 * 搜索引擎搜索。直接构造搜索引擎结果页 URL（对反爬站点如百度首页假输入框，
 * 跳过首页直达结果页），随后提取结果文本返回。
 * engine: bing / baidu / sogou / google（默认 bing —— 百度在 headless 下会触发图形验证码）。
 */
export async function search(query: string, engine = 'bing'): Promise<BrowserActionResult> {
  try {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { ok: false, error: 'INVALID_ARGUMENT', message: 'query 是必填参数（搜索关键词）' }
    }
    const q = encodeURIComponent(query.trim())
    const url = {
      baidu: `https://www.baidu.com/s?wd=${q}`,
      bing: `https://www.bing.com/search?q=${q}&setmkt=zh-CN&setlang=zh-hans&cc=cn`,
      sogou: `https://www.sogou.com/web?query=${q}`,
      google: `https://www.google.com/search?q=${q}&hl=zh-CN`,
    }[engine] ?? `https://www.bing.com/search?q=${q}&setmkt=zh-CN&setlang=zh-hans&cc=cn`
    const p = await ensurePage()
    await p.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
    await waitStable()
    const text = await p.evaluate(() => {
      const body = document.body
      if (!body) return ''
      const cloned = body.cloneNode(true) as HTMLElement
      for (const el of cloned.querySelectorAll('script,style,noscript,svg,canvas,iframe')) el.remove()
      return (cloned.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 8000)
    })
    return { ok: true, url: p.url(), title: await p.title(), text }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser search failed', { query, error: msg })
    return { ok: false, error: 'SEARCH_FAILED', message: `搜索失败: ${msg}` }
  }
}

/** 提取当前页渲染后的可见文本。 */
export async function extract(): Promise<BrowserActionResult> {
  try {
    const p = await ensurePage(true)
    await waitStable()
    const text = await p.evaluate(() => {
      const body = document.body
      if (!body) return ''
      const cloned = body.cloneNode(true) as HTMLElement
      for (const el of cloned.querySelectorAll('script,style,noscript,svg,canvas,iframe')) el.remove()
      return (cloned.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 8000)
    })
    return { ok: true, url: p.url(), title: await p.title(), text }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser extract failed', { error: msg })
    return { ok: false, error: 'EXTRACT_FAILED', message: `提取页面文本失败: ${msg}` }
  }
}

/**
 * 整页截图。给定 savePath 则存文件（返回 screenshotPath），否则返回 base64。
 */
export async function screenshot(savePath?: string): Promise<BrowserActionResult> {
  try {
    const p = await ensurePage(true)
    await waitStable()
    if (savePath && typeof savePath === 'string' && savePath.trim()) {
      const target = path.resolve(savePath.trim())
      await mkdir(path.dirname(target), { recursive: true })
      await p.screenshot({ path: target, fullPage: true })
      return { ok: true, url: p.url(), screenshotPath: target, message: `截图已保存: ${target}` }
    }
    const base64 = await p.screenshot({ fullPage: true })
    return { ok: true, url: p.url(), base64: base64.toString('base64'), message: '截图已生成(base64)' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser screenshot failed', { error: msg })
    return { ok: false, error: 'SCREENSHOT_FAILED', message: `截图失败: ${msg}` }
  }
}

/** 后退。 */
export async function back(): Promise<BrowserActionResult> {
  try {
    const p = await ensurePage(true)
    await p.goBack({ timeout: NAV_TIMEOUT_MS })
    await waitStable()
    return { ok: true, url: p.url(), title: await p.title() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser back failed', { error: msg })
    return { ok: false, error: 'BACK_FAILED', message: `后退失败: ${msg}` }
  }
}

/** 刷新。 */
export async function refresh(): Promise<BrowserActionResult> {
  try {
    const p = await ensurePage(true)
    await p.reload({ timeout: NAV_TIMEOUT_MS })
    await waitStable()
    return { ok: true, url: p.url(), title: await p.title() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser refresh failed', { error: msg })
    return { ok: false, error: 'REFRESH_FAILED', message: `刷新失败: ${msg}` }
  }
}

/** 关闭所有浏览器页面并释放进程。 */
export async function close(): Promise<BrowserActionResult> {
  try {
    if (browser) {
      await browser.close()
    }
    browser = null
    context = null
    page = null
    return { ok: true, message: '浏览器已关闭' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: 'CLOSE_FAILED', message: `关闭浏览器失败: ${msg}` }
  }
}

/** 解析 target（text=xxx 或 CSS 选择器）→ 定位器字符串。 */
function parseTarget(target: string): string {
  const t = target.trim()
  if (t.startsWith('text=')) return `text=${t.slice(5).trim()}`
  return t
}

/** 点击元素。target 支持 text=xxx 或 CSS 选择器。 */
export async function click(target: string): Promise<BrowserActionResult> {
  try {
    const p = await ensurePage(true)
    if (!target || typeof target !== 'string' || !target.trim()) {
      return { ok: false, error: 'INVALID_ARGUMENT', message: 'target 是必填参数（CSS 选择器或 text=文本）' }
    }
    const locator = p.locator(parseTarget(target)).first()
    await locator.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS })
    await locator.click({ timeout: NAV_TIMEOUT_MS })
    await waitStable()
    return { ok: true, url: p.url(), title: await p.title(), message: `已点击 ${target}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser click failed', { target, error: msg })
    return { ok: false, error: 'CLICK_FAILED', message: `点击 ${target} 失败: ${msg}` }
  }
}

/** 填充输入框。target 支持 CSS 选择器或 text=标签文本。 */
export async function fill(target: string, value: string): Promise<BrowserActionResult> {
  try {
    const p = await ensurePage(true)
    if (!target || typeof target !== 'string') {
      return { ok: false, error: 'INVALID_ARGUMENT', message: 'target 是必填参数（CSS 选择器）' }
    }
    if (typeof value !== 'string') {
      return { ok: false, error: 'INVALID_ARGUMENT', message: 'value 必须是字符串' }
    }
    const locator = p.locator(parseTarget(target)).first()
    // 部分站点在 headless 下会把输入框样式置为 hidden（如百度），fill 强制要求 visible 会失败
    await locator.waitFor({ state: 'attached', timeout: NAV_TIMEOUT_MS })
    try {
      await locator.fill(value, { timeout: 8000 })
    } catch {
      // 兜底：JS 直接赋值 + 触发 input/change 事件，随后回读验证实际值
      const readback = await p.evaluate(
        ([sel, val]) => {
          const el = document.querySelector(sel) as HTMLInputElement | null
          if (!el) throw new Error(`元素不存在: ${sel}`)
          const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          nativeSet?.call(el, val)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return el.value
        },
        [parseTarget(target), value] as [string, string],
      )
      if (String(readback).trim() !== String(value).trim()) {
        // 首次兜底未生效（站点框架未同步 value），二次兜底：清空后重填并触发 input/value 事件
        await p.evaluate(
          ([sel, val]) => {
            const el = document.querySelector(sel) as HTMLInputElement | null
            if (!el) return
            const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            nativeSet?.call(el, '')
            el.dispatchEvent(new Event('input', { bubbles: true }))
            nativeSet?.call(el, val)
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          },
          [parseTarget(target), value] as [string, string],
        )
      }
    }
    await waitStable()
    return { ok: true, url: p.url(), message: `已填入 ${target}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser fill failed', { target, error: msg })
    return { ok: false, error: 'FILL_FAILED', message: `填写 ${target} 失败: ${msg}` }
  }
}

/** 按键。selector 为 CSS 选择器（或空表示当前焦点），key 如 Enter/Tab/Escape。 */
export async function press(selector: string, key: string): Promise<BrowserActionResult> {
  try {
    const p = await ensurePage(true)
    if (!key || typeof key !== 'string' || !key.trim()) {
      return { ok: false, error: 'INVALID_ARGUMENT', message: 'key 是必填参数（如 Enter、Tab、Escape）' }
    }
    if (selector && typeof selector === 'string' && selector.trim()) {
      const locator = p.locator(parseTarget(selector)).first()
      await locator.waitFor({ state: 'attached', timeout: NAV_TIMEOUT_MS })
      await locator.press(key, { timeout: NAV_TIMEOUT_MS })
    } else {
      await p.keyboard.press(key)
    }
    await waitStable()
    return { ok: true, url: p.url(), message: `已按键 ${key}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser press failed', { key, error: msg })
    return { ok: false, error: 'PRESS_FAILED', message: `按键 ${key} 失败: ${msg}` }
  }
}

/** 滚动页面（up/down，可带 steps 次数）。 */
export async function scroll(direction: string): Promise<BrowserActionResult> {
  try {
    const p = await ensurePage(true)
    const dir = (direction || '').toLowerCase()
    if (!['up', 'down', 'top', 'bottom'].includes(dir)) {
      return { ok: false, error: 'INVALID_ARGUMENT', message: 'direction 必须是 up/down/top/bottom 之一' }
    }
    await p.evaluate(d => {
      if (d === 'top') return window.scrollTo(0, 0)
      if (d === 'bottom') return window.scrollTo(0, document.body.scrollHeight)
      const step = d === 'down' ? 800 : -800
      window.scrollBy(0, step)
    }, dir)
    await waitStable()
    return { ok: true, url: p.url(), message: `已滚动 ${dir}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser scroll failed', { error: msg })
    return { ok: false, error: 'SCROLL_FAILED', message: `滚动失败: ${msg}` }
  }
}

/** 在页面上下文执行 JS 并返回值（序列化对象/数字/字符串）。 */
export async function evalJs(code: string): Promise<BrowserActionResult> {
  try {
    const p = await ensurePage(true)
    if (!code || typeof code !== 'string' || !code.trim()) {
      return { ok: false, error: 'INVALID_ARGUMENT', message: 'js 是必填参数' }
    }
    const data = await p.evaluate(c => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`"use strict"; return (${c})`)
      const result = fn()
      return { value: result }
    }, code)
    await waitStable()
    return { ok: true, url: p.url(), data: data.value, message: 'JS 执行完成' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('browser eval failed', { error: msg })
    return { ok: false, error: 'EVAL_FAILED', message: `JS 执行失败: ${msg}` }
  }
}