import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 被测模块（ESM import，模块不存在时 RED 阶段会失败）
import {
  clampToWorkArea,
  getWorkArea,
  persist,
  restore,
  scaleSizeToWorkArea,
  validateAndClamp,
} from '../desktop/windowBoundsManager.js'

describe('WindowBoundsManager', () => {
  let localStorageStub

  beforeEach(() => {
    // mock localStorage（浏览器 API，node 环境需要 stub）
    const store = new Map()
    localStorageStub = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, val) => void store.set(key, String(val)),
      removeItem: (key) => void store.delete(key),
      clear: () => store.clear(),
    }
    vi.stubGlobal('localStorage', localStorageStub)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('clampToWorkArea', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1032 }

    it('prevents dragging out of right edge (AC-2)', () => {
      const result = clampToWorkArea(
        { x: 5000, y: 500 },
        area,
        { width: 230, height: 330 },
      )
      // 右边界：area.x + area.width - MIN_VISIBLE = 1920 - 80 = 1840
      expect(result.x).toBeLessThanOrEqual(1840)
      expect(result.y).toBeLessThanOrEqual(1032 - 80)
    })

    it('prevents dragging out of left edge (AC-2)', () => {
      const result = clampToWorkArea(
        { x: -5000, y: -5000 },
        area,
        { width: 230, height: 330 },
      )
      // 左边界：area.x - winSize.width + MIN_VISIBLE = -230 + 80 = -150
      expect(result.x).toBeGreaterThanOrEqual(-150)
      expect(result.y).toBeGreaterThanOrEqual(-250)
    })

    it('keeps position unchanged if already in bounds', () => {
      const result = clampToWorkArea(
        { x: 500, y: 500 },
        area,
        { width: 230, height: 330 },
      )
      expect(result.x).toBe(500)
      expect(result.y).toBe(500)
    })

    it('handles work area with negative x (multi-monitor, AC-8)', () => {
      const areaNegative = { x: -1920, y: 0, width: 1920, height: 1032 }
      const result = clampToWorkArea(
        { x: -5000, y: 500 },
        areaNegative,
        { width: 230, height: 330 },
      )
      // 左边界：-1920 - 230 + 80 = -2070
      expect(result.x).toBeGreaterThanOrEqual(-2070)
    })
  })

  describe('getWorkArea', () => {
    it('returns area from invoke when available', async () => {
      const invoke = vi.fn().mockResolvedValue({ x: 100, y: 100, width: 1720, height: 932 })
      const result = await getWorkArea(() => invoke)
      expect(result).toEqual({ x: 100, y: 100, width: 1720, height: 932 })
      expect(invoke).toHaveBeenCalledWith('get_work_area')
    })

    it('returns default 1920x1032 when invoke throws', async () => {
      const invoke = vi.fn().mockRejectedValue(new Error('ACL denied'))
      const result = await getWorkArea(() => invoke)
      expect(result).toEqual({ x: 0, y: 0, width: 1920, height: 1032 })
    })

    it('returns default when invoke is null', async () => {
      const result = await getWorkArea(() => null)
      expect(result).toEqual({ x: 0, y: 0, width: 1920, height: 1032 })
    })
  })

  describe('restore (AC-1, AC-8)', () => {
    it('clamps out-of-bounds saved position to work area (AC-1, AC-8)', async () => {
      // localStorage 保存了越界位置（比如外接显示器拔出后）
      localStorageStub.setItem(
        'rag-pet-position',
        JSON.stringify({ x: 5000, y: 5000 }),
      )
      const invoke = vi.fn().mockResolvedValue({ x: 0, y: 0, width: 1920, height: 1032 })
      const result = await restore(
        { x: 1600, y: 700 },
        { width: 230, height: 330 },
        () => invoke,
      )
      // 夹回工作区
      expect(result.x).toBeLessThanOrEqual(1840)
      expect(result.y).toBeLessThanOrEqual(952)
      expect(result.x).toBeGreaterThanOrEqual(-150)
      expect(result.y).toBeGreaterThanOrEqual(-250)
    })

    it('uses default position when localStorage is empty', async () => {
      const invoke = vi.fn().mockResolvedValue({ x: 0, y: 0, width: 1920, height: 1032 })
      const result = await restore(
        { x: 1600, y: 700 },
        { width: 230, height: 330 },
        () => invoke,
      )
      // 默认位置 1600, 700 在工作区内，应保持不变
      expect(result.x).toBe(1600)
      expect(result.y).toBe(700)
    })

    it('handles corrupted localStorage JSON by falling back to default', async () => {
      localStorageStub.setItem('rag-pet-position', 'not valid json {')
      const invoke = vi.fn().mockResolvedValue({ x: 0, y: 0, width: 1920, height: 1032 })
      const result = await restore(
        { x: 1600, y: 700 },
        { width: 230, height: 330 },
        () => invoke,
      )
      expect(result.x).toBe(1600)
      expect(result.y).toBe(700)
    })
  })

  describe('persist', () => {
    it('writes position to localStorage (AC-3)', () => {
      persist({ x: 100, y: 200 })
      const stored = localStorageStub.getItem('rag-pet-position')
      expect(stored).toBe(JSON.stringify({ x: 100, y: 200 }))
    })

    it('does not throw when localStorage.setItem throws', () => {
      localStorageStub.setItem = () => { throw new Error('quota exceeded') }
      expect(() => persist({ x: 100, y: 200 })).not.toThrow()
    })
  })

  describe('validateAndClamp (AC-3 roundtrip)', () => {
    it('round-trips persist then validateAndClamp with clamping', async () => {
      persist({ x: 100, y: 200 })
      const invoke = vi.fn().mockResolvedValue({ x: 0, y: 0, width: 1920, height: 1032 })
      const result = await validateAndClamp(
        { x: 100, y: 200 },
        { width: 230, height: 330 },
        () => invoke,
      )
      // 100, 200 在工作区内，应保持不变
      expect(result.x).toBe(100)
      expect(result.y).toBe(200)
    })

    it('clamps out-of-bounds position using fresh work area', async () => {
      const invoke = vi.fn().mockResolvedValue({ x: 0, y: 0, width: 800, height: 600 })
      const result = await validateAndClamp(
        { x: 5000, y: 5000 },
        { width: 230, height: 330 },
        () => invoke,
      )
      // 在 800x600 工作区内夹回
      expect(result.x).toBeLessThanOrEqual(800 - 80)
      expect(result.y).toBeLessThanOrEqual(600 - 80)
    })
  })

  describe('expanded chat panel fits in work area (AC-4)', () => {
    it('clamps expanded window position so at least 80px stays in bounds', () => {
      const area = { x: 0, y: 0, width: 1920, height: 1032 }
      const expandedSize = { width: 650, height: 500 }
      // 窗口原本在 1500, 600，展开 650x500 后大部分超出工作区
      const result = clampToWorkArea({ x: 1500, y: 600 }, area, expandedSize)
      // AC-4 与 AC-2 一致：至少 80px 露在工作区内（完整显示由 resizePetWindow 保证）
      // 右边界 maxX = 0 + 1920 - min(650, 80) = 1840
      expect(result.x).toBeLessThanOrEqual(1840)
      // 下边界 maxY = 0 + 1032 - min(500, 80) = 952
      expect(result.y).toBeLessThanOrEqual(952)
    })

    it('keeps expanded window in bounds when already well-positioned', () => {
      const area = { x: 0, y: 0, width: 1920, height: 1032 }
      const expandedSize = { width: 650, height: 500 }
      const result = clampToWorkArea({ x: 100, y: 100 }, area, expandedSize)
      expect(result.x).toBe(100)
      expect(result.y).toBe(100)
    })
  })

  describe('multi-monitor scenarios (AC-8)', () => {
    it('handles work area offset to the right (second monitor right of primary)', () => {
      // 第二显示器在主显示器右侧，工作区 x 从 1920 开始
      const area = { x: 1920, y: 0, width: 1920, height: 1032 }
      const winSize = { width: 230, height: 330 }
      // 保存的位置在主显示器（x=100），现在工作区已平移
      const result = clampToWorkArea({ x: 100, y: 500 }, area, winSize)
      // 100 < 1920（工作区左边界），应被夹回到至少 80px 在工作区内
      // 左边界：1920 - 230 + 80 = 1770
      expect(result.x).toBeGreaterThanOrEqual(1770)
    })

    it('handles work area with negative x (second monitor left of primary)', () => {
      const area = { x: -1920, y: 0, width: 1920, height: 1032 }
      const winSize = { width: 230, height: 330 }
      // 保存的位置在主显示器（x=1000），现在工作区在左侧
      const result = clampToWorkArea({ x: 1000, y: 500 }, area, winSize)
      // 右边界：-1920 + 1920 - 80 = -80
      expect(result.x).toBeLessThanOrEqual(-80)
    })

    it('clamps position saved on disconnected monitor back to current work area', async () => {
      // 模拟：保存的位置在外接显示器（x=3000），现在外接显示器拔出
      localStorageStub.setItem(
        'rag-pet-position',
        JSON.stringify({ x: 3000, y: 500 }),
      )
      const invoke = vi.fn().mockResolvedValue({ x: 0, y: 0, width: 1920, height: 1032 })
      const result = await restore(
        { x: 1600, y: 700 },
        { width: 230, height: 330 },
        () => invoke,
      )
      // 应夹回到当前工作区内
      expect(result.x).toBeLessThanOrEqual(1840)
      expect(result.x).toBeGreaterThanOrEqual(-150)
    })
  })

  describe('scaleSizeToWorkArea (AC-5, AC-6)', () => {
    it('keeps size unchanged when work area is large enough', () => {
      const area = { x: 0, y: 0, width: 1920, height: 1032 }
      const result = scaleSizeToWorkArea({ width: 650, height: 500 }, area)
      expect(result.width).toBe(650)
      expect(result.height).toBe(500)
    })

    it('scales down expanded chat when work area width < 650 (AC-5)', () => {
      // 工作区 800x600，展开聊天 650x500 — 宽度足够但保守测试边界
      // 用更小的工作区 500x400 触发缩放
      const area = { x: 0, y: 0, width: 500, height: 400 }
      const result = scaleSizeToWorkArea({ width: 650, height: 500 }, area)
      // 可用宽 = 500 - 16 = 484，缩放比 = 484/650 ≈ 0.7446
      // 缩放后宽 = floor(650 * 0.7446) = 484
      // 缩放后高 = floor(500 * 0.7446) = 372
      expect(result.width).toBeLessThanOrEqual(484)
      expect(result.width).toBeGreaterThanOrEqual(220) // 不低于最小宽度
      expect(result.height).toBeLessThanOrEqual(400)
      expect(result.height).toBeGreaterThanOrEqual(280) // 不低于最小高度
    })

    it('scales down settings drawer when work area width < 1044 (AC-6)', () => {
      // 工作区 800x600，设置抽屉 1044x500 — 宽度不够
      const area = { x: 0, y: 0, width: 800, height: 600 }
      const result = scaleSizeToWorkArea({ width: 1044, height: 500 }, area)
      // 可用宽 = 800 - 16 = 784，缩放比 = 784/1044 ≈ 0.7510
      // 缩放后宽 = floor(1044 * 0.7510) = 784
      expect(result.width).toBeLessThanOrEqual(784)
      // 高度按比例缩放：floor(500 * 0.7510) = 375
      expect(result.height).toBeLessThanOrEqual(375)
      expect(result.height).toBeGreaterThanOrEqual(280)
    })

    it('scales by height when work area height is the limiting factor', () => {
      // 工作区 1000x400，请求 650x500 — 高度不够
      const area = { x: 0, y: 0, width: 1000, height: 400 }
      const result = scaleSizeToWorkArea({ width: 650, height: 500 }, area)
      // 可用高 = 400 - 16 = 384，缩放比 = 384/500 = 0.768
      // 缩放后高 = floor(500 * 0.768) = 384
      // 缩放后宽 = floor(650 * 0.768) = 499
      expect(result.height).toBeLessThanOrEqual(384)
      expect(result.width).toBeLessThanOrEqual(499)
    })

    it('enforces minimum width and height even on tiny work area', () => {
      // 极端小工作区 100x100
      const area = { x: 0, y: 0, width: 100, height: 100 }
      const result = scaleSizeToWorkArea({ width: 650, height: 500 }, area)
      // 不低于最小尺寸（默认 220x280）
      expect(result.width).toBeGreaterThanOrEqual(220)
      expect(result.height).toBeGreaterThanOrEqual(280)
    })

    it('respects custom margin option', () => {
      // 用足够大的高度隔离测试 margin 对宽度的影响（避免高度二次缩放干扰）
      const area = { x: 0, y: 0, width: 600, height: 1200 }
      // margin=0 → 可用宽 = 600
      const result = scaleSizeToWorkArea(
        { width: 650, height: 500 },
        area,
        { margin: 0 },
      )
      // 缩放比 = 600/650 ≈ 0.923
      // 缩放后宽 = floor(650 * 0.923) = 600
      expect(result.width).toBe(600)
      // 缩放后高 = floor(500 * 0.923) = 461（未触发高度二次缩放）
      expect(result.height).toBe(461)
    })

    it('respects custom min dimensions', () => {
      const area = { x: 0, y: 0, width: 100, height: 100 }
      const result = scaleSizeToWorkArea(
        { width: 650, height: 500 },
        area,
        { minWidth: 300, minHeight: 350 },
      )
      expect(result.width).toBeGreaterThanOrEqual(300)
      expect(result.height).toBeGreaterThanOrEqual(350)
    })
  })
})
