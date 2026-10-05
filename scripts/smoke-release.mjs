import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = join(root, '.release', 'runtime')
await stat(join(runtime, 'node.exe'))
await stat(join(runtime, 'dist', 'server.js'))

const reservation = createServer()
await new Promise((resolve, reject) => reservation.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))

const dataRoot = await mkdtemp(join(tmpdir(), 'rag-agent-release-smoke-'))
const localToken = 'isolated-release-smoke-token'
const safeRelative = relative(resolve(tmpdir()), resolve(dataRoot))
if (!safeRelative || safeRelative.startsWith('..') || safeRelative.includes('..\\') || safeRelative.includes('../')) {
  throw new Error('Unexpected smoke-test data path')
}
const child = spawn(join(runtime, 'node.exe'), ['dist/server.js'], {
  cwd: runtime,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, RAG_PET_HOME: dataRoot, SERVER_PORT: String(port), RAG_PET_LOCAL_TOKEN: localToken, RAG_PET_REQUIRE_LOCAL_TOKEN: 'true', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '' },
})
let stderr = ''
child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 1000) })
try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`Release service exited early: ${stderr.slice(-1000)}`)
    try {
      const status = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'X-Assistant-Token': localToken }, signal: AbortSignal.timeout(1000) })
      const page = await fetch(`http://127.0.0.1:${port}/pet.html`, { signal: AbortSignal.timeout(1000) })
      if (status.ok && page.ok && (await page.text()).includes('桌面智能助手')) { ready = true; break }
    } catch { /* The service may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (!ready) throw new Error(`Release service did not become ready: ${stderr.slice(-1000)}`)
  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/status`, {
    headers: { Origin: 'http://localhost' },
  })
  if (unauthenticated.status !== 401) throw new Error('Release service accepted a spoofable Origin without its launch token')
  console.log(`Release runtime smoke test passed on 127.0.0.1:${port}`)
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill()
    await new Promise(resolve => child.once('exit', resolve))
  }
  await rm(dataRoot, { recursive: true, force: true })
}
