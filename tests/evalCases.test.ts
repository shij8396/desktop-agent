import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TOOLS } from '../src/tools.js'
import { riskForTool } from '../src/agent/workflow.js'

describe('desktop-agent evaluation cases', () => {
  it('keeps a broad, executable planner fixture aligned with the tool catalog', () => {
    const path = fileURLToPath(new URL('../evals/desktop-agent-cases.json', import.meta.url))
    const cases = JSON.parse(readFileSync(path, 'utf8')) as Array<{ question: string; expected: { requiredTool?: string; risk?: string } }>
    const tools = new Set(TOOLS.map(tool => tool.name))
    expect(cases.length).toBeGreaterThanOrEqual(50)
    expect(new Set(cases.map(item => item.question)).size).toBe(cases.length)
    for (const item of cases) {
      if (!item.expected.requiredTool) continue
      expect(tools.has(item.expected.requiredTool)).toBe(true)
      expect(item.expected.risk).toBe(riskForTool(item.expected.requiredTool))
    }
  })
})
