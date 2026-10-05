import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // 测试统一归并到 tests/（Node 侧 TS + 浏览器侧 JS）
    // 浏览器侧 windowBoundsManager 用 UMD 导出 + localStorage stub，node 环境即可跑
    include: ['tests/**/*.test.ts', 'tests/**/*.test.js'],
    testTimeout: 10000,
    env: {
      LOG_LEVEL: 'warn',
    },
  },
})
