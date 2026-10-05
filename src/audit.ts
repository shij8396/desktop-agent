import { appendFile, mkdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { config } from './config.js'

export interface ToolAuditEvent {
  name: string
  input: Record<string, unknown>
  result: string
  durationMs: number
}

/** Writes metadata and hashes only. Raw user files, clipboard and model content are never logged. */
export async function recordToolAudit(event: ToolAuditEvent): Promise<void> {
  const inputHash = createHash('sha256').update(JSON.stringify(event.input)).digest('hex')
  const resultHash = createHash('sha256').update(event.result).digest('hex')
  const line = JSON.stringify({ eventId: randomUUID(), timestamp: new Date().toISOString(), type: 'tool_execution', tool: event.name, inputHash, resultHash, durationMs: event.durationMs }) + '\n'
  try {
    await mkdir(config.auditDir, { recursive: true })
    await appendFile(join(config.auditDir, 'tool-audit.jsonl'), line, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Auditing must not expose data or make a read-only action fail. Production
    // deployments should monitor this through the runtime health endpoint.
  }
}

export async function recordActionAudit(event: 'requested' | 'approved' | 'rejected' | 'expired' | 'failed', action: { id: string; name: string; input: Record<string, unknown>; risk: string; status: string }): Promise<void> {
  const inputHash = createHash('sha256').update(JSON.stringify(action.input)).digest('hex')
  const line = JSON.stringify({ eventId: randomUUID(), timestamp: new Date().toISOString(), type: 'action_confirmation', event, actionId: action.id, action: action.name, risk: action.risk, status: action.status, inputHash }) + '\n'
  try {
    await mkdir(config.auditDir, { recursive: true })
    await appendFile(join(config.auditDir, 'tool-audit.jsonl'), line, { encoding: 'utf8', mode: 0o600 })
  } catch {}
}
