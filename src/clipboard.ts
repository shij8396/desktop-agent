import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const CLIPBOARD_MAX_CHARS = 3000

export async function readSystemClipboard(): Promise<{ text: string; error?: string }> {
  const cmd = process.platform === 'win32'
    ? 'powershell -Command "Get-Clipboard -Raw"'
    : 'xclip -selection clipboard -o 2>/dev/null || pbpaste'

  try {
    const { stdout } = await execAsync(cmd, { timeout: 5000, maxBuffer: 1024 * 1024 })
    const text = stdout.trim()
    if (!text) return { text: '', error: 'Clipboard is empty or contains non-text content' }
    return { text: text.slice(0, CLIPBOARD_MAX_CHARS) }
  } catch {
    return { text: '', error: 'Clipboard may contain non-text content' }
  }
}
