import { readdir, readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const desktopDir = join(root, 'desktop')
const files = await readdir(desktopDir)
let failed = false

for (const file of files.filter(name => name.endsWith('.js'))) {
  const fullPath = join(desktopDir, file)
  const result = spawnSync(process.execPath, ['--check', fullPath], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed = true
    console.error(result.stderr || result.stdout)
  }
}

for (const file of files.filter(name => name.endsWith('.html'))) {
  const html = await readFile(join(desktopDir, file), 'utf8')
  const required = ['<!DOCTYPE html>', '<html', '</html>', '<head>', '</head>', '<body', '</body>']
  for (const marker of required) {
    if (!html.includes(marker)) {
      failed = true
      console.error(`${file}: missing ${marker}`)
    }
  }
  if (html.includes('\uFFFD')) {
    failed = true
    console.error(`${file}: contains replacement characters`)
  }
  const scriptRefs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1])
  const stylesheetRefs = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(match => match[1])
  for (const ref of [...scriptRefs, ...stylesheetRefs]) {
    try {
      const target = resolve(desktopDir, ref.split('?')[0])
      const info = await stat(target)
      if (!info.isFile()) throw new Error('not a file')
    } catch {
      failed = true
      console.error(`${file}: missing resource ${ref}`)
    }
  }
  if (file === 'pet.html') {
    for (const requiredId of ['compact-task', 'compact-task-open', 'task-panel-button-label', 'settings-voice-enabled']) {
      if (!html.includes(`id="${requiredId}"`)) {
        failed = true
        console.error(`${file}: missing interaction surface #${requiredId}`)
      }
    }
    try { await stat(join(desktopDir, 'vendor', 'Phosphor.woff2')) }
    catch { failed = true; console.error(`${file}: missing local icon font`) }
  }
  for (const badRef of ['live2d.min.js', 'sprite-renderer.js', 'sprite-manager.js', 'character-sprites.js', 'anime2d-renderer.js', 'renderer-factory.js', 'character-runtime.js', 'desktop-behavior.js']) {
    if (html.includes(badRef)) {
      failed = true
      console.error(`${file}: references removed runtime ${badRef}`)
    }
  }
  if (file === 'pet.html') {
    for (const requiredId of ['messages', 'chat-input', 'task-panel', 'task-steps', 'approval-list', 'activity-list', 'settings-drawer']) {
      if (!html.includes(`id="${requiredId}"`)) {
        failed = true
        console.error(`${file}: missing desktop assistant surface #${requiredId}`)
      }
    }
  }
}

if (failed) process.exit(1)
console.log('Desktop JS and HTML checks passed.')
