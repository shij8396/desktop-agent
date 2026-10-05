import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('The current release preparation targets Windows only.')
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = resolve(projectRoot, '.release')
const runtimeRoot = resolve(releaseRoot, 'runtime')
if (runtimeRoot !== join(projectRoot, '.release', 'runtime')) throw new Error('Unexpected release staging path')
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this script through npm run prepare:release')
await stat(join(projectRoot, 'dist', 'server.js'))

await rm(runtimeRoot, { recursive: true, force: true })
await mkdir(runtimeRoot, { recursive: true })
await Promise.all([
  copyFile(process.execPath, join(runtimeRoot, 'node.exe')),
  copyFile(join(projectRoot, 'package.json'), join(runtimeRoot, 'package.json')),
  copyFile(join(projectRoot, 'package-lock.json'), join(runtimeRoot, 'package-lock.json')),
  cp(join(projectRoot, 'dist'), join(runtimeRoot, 'dist'), { recursive: true }),
  cp(join(projectRoot, 'desktop'), join(runtimeRoot, 'desktop'), { recursive: true }),
])

const packageJson = JSON.parse(await readFile(join(runtimeRoot, 'package.json'), 'utf8'))
delete packageJson.scripts
await writeFile(join(runtimeRoot, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n')
const installed = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: runtimeRoot,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
})
if (installed.error) throw installed.error
if (installed.status !== 0) throw new Error(`Production dependency install failed (${installed.status})`)
await stat(join(runtimeRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'))
console.log(`Release runtime staged at ${runtimeRoot}`)
