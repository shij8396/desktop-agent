/** Validate the agent capability fixture without executing desktop or file tools. */
import { readFile } from 'node:fs/promises'
import { TOOLS } from '../src/tools.js'
import { riskForTool } from '../src/agent/workflow.js'

interface Case {
  question: string
  expected: {
    requiredTool?: string
    alternativeTools?: string[]
    risk?: 'L0' | 'L1' | 'L2' | 'L3'
    mode?: 'standard' | 'deep'
    requiresApproval?: boolean
    requiresPlanning?: boolean
    mustDeny?: boolean
    mustDenyBypass?: boolean
  }
}

const cases = JSON.parse(await readFile(new URL('../evals/desktop-agent-cases.json', import.meta.url), 'utf8')) as Case[]
const knownTools = new Set(TOOLS.map(tool => tool.name))
const questions = new Set<string>()
const problems: string[] = []
for (const [index, item] of cases.entries()) {
  if (!item.question?.trim()) problems.push(`Case ${index + 1}: empty question`)
  if (questions.has(item.question)) problems.push(`Case ${index + 1}: duplicate question`)
  questions.add(item.question)
  if (item.expected.requiredTool && !knownTools.has(item.expected.requiredTool)) problems.push(`Case ${index + 1}: unknown tool ${item.expected.requiredTool}`)
  for (const alternative of item.expected.alternativeTools ?? []) {
    if (!knownTools.has(alternative)) problems.push(`Case ${index + 1}: unknown alternative tool ${alternative}`)
    if (item.expected.risk !== riskForTool(alternative)) problems.push(`Case ${index + 1}: expected risk does not match alternative tool policy`)
  }
  if (item.expected.requiredTool && item.expected.risk !== riskForTool(item.expected.requiredTool)) problems.push(`Case ${index + 1}: expected risk does not match tool policy`)
  if (item.expected.requiresApproval && item.expected.risk !== 'L2' && item.expected.risk !== 'L3') problems.push(`Case ${index + 1}: approval needs L2/L3 risk`)
}
console.log(`Fixture: ${cases.length} synthetic cases, ${knownTools.size} available tools`)
if (problems.length) {
  for (const problem of problems) console.error(problem)
  process.exitCode = 1
} else {
  console.log('Offline fixture validation passed. Use npm run eval:runtime for model/tool execution checks.')
}
