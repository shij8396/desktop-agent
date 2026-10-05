import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const globalLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info'

function writeLogFile(line: string): void {
  try {
    fs.mkdirSync(config.logDir, { recursive: true })
    fs.appendFileSync(path.join(config.logDir, 'rag-pet.log'), line + '\n', 'utf8')
  } catch {
    // Logging must not break chat or startup.
  }
}

export function createLogger(module: string) {
  function log(level: LogLevel, message: string, ctx?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[globalLevel]) return

    const entry = {
      level,
      time: new Date().toISOString(),
      module,
      message,
      ...ctx,
    }

    const line = JSON.stringify(entry)
    writeLogFile(line)
    if (level === 'error') {
      process.stderr.write(line + '\n')
    } else {
      process.stdout.write(line + '\n')
    }
  }

  return {
    debug(message: string, ctx?: Record<string, unknown>): void {
      log('debug', message, ctx)
    },
    info(message: string, ctx?: Record<string, unknown>): void {
      log('info', message, ctx)
    },
    warn(message: string, ctx?: Record<string, unknown>): void {
      log('warn', message, ctx)
    },
    error(message: string, ctx?: Record<string, unknown>): void {
      log('error', message, ctx)
    },
  }
}
