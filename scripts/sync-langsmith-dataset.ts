import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Client } from 'langsmith'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const datasetName = process.env.LANGSMITH_DATASET || 'rag-agent-desktop-regression'

if (!process.env.LANGSMITH_API_KEY) {
  throw new Error('LANGSMITH_API_KEY is required to sync the evaluation dataset.')
}

const client = new Client()
if (await client.hasDataset({ datasetName })) {
  console.log(`LangSmith dataset already exists: ${datasetName}`)
  process.exit(0)
}

const cases = JSON.parse(await readFile(join(root, 'evals', 'desktop-agent-cases.json'), 'utf8')) as Array<{
  question: string
  expected: Record<string, unknown>
}>

await client.createDataset(datasetName, {
  description: 'Desktop Agent routing, tool, approval, and safety regression cases.',
  dataType: 'kv',
  metadata: { application: 'rag-agent', suite: 'desktop-agent-regression' },
})
await client.createExamples({
  datasetName,
  inputs: cases.map(item => ({ question: item.question })),
  outputs: cases.map(item => item.expected),
  metadata: cases.map((_item, index) => ({ caseIndex: index + 1 })),
})

console.log(`Created LangSmith dataset ${datasetName} with ${cases.length} examples.`)
