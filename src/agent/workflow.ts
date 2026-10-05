import { randomUUID } from 'node:crypto'
import { AIMessage } from '@langchain/core/messages'
import { Annotation } from '@langchain/langgraph'
import type { RiskLevel, TaskPlan, TaskStep } from './types.js'
import type { PendingChoice } from './dialogue.js'

export const AssistantWorkflowState = Annotation.Root({
  taskId: Annotation<string>(),
  sessionId: Annotation<string>(),
  question: Annotation<string>(),
  resolvedQuestion: Annotation<string>(),
  dynamicContext: Annotation<string>(),
  forceWeb: Annotation<boolean>(),
  executionMode: Annotation<'standard' | 'deep' | 'clarify'>(),
  pendingChoice: Annotation<PendingChoice | undefined>(),
  screenshot: Annotation<string | undefined>(),
  plan: Annotation<TaskPlan>(),
  answer: Annotation<string>(),
  error: Annotation<string | undefined>(),
})

export type AssistantWorkflowStateValue = typeof AssistantWorkflowState.State

export function selectExecutionMode(question: string, enabled = true): 'standard' | 'deep' {
  if (!enabled) return 'standard'
  const explicitlyComplex = /(深度研究|深度调研|全面调研|多来源|批量分析|拆分子任务|子智能体|长时间任务|复杂任务|deep\s*agent)/i.test(question)
  return explicitlyComplex ? 'deep' : 'standard'
}

/** UI projection of real tool activity, not a second model-generated execution plan. */
export function createTaskPlan(question: string, taskId: string = randomUUID()): TaskPlan {
  return {
    plan_id: taskId,
    user_request: question,
    created_at: new Date().toISOString(),
    status: 'executing',
    steps: [],
  }
}

export function startPlanStep(plan: TaskPlan, toolName: string): TaskStep | undefined {
  const exact = plan.steps.find(step => (step.status === 'pending' || step.status === 'awaiting_confirm') && step.tool === toolName)
  const equivalent = plan.steps.find(step =>
    (step.status === 'pending' || step.status === 'awaiting_confirm')
    && ((step.tool === 'launch_app' && toolName === 'launch_program')
      || (step.tool === 'launch_program' && toolName === 'launch_app')),
  )
  const fallback = plan.steps.find(step => step.status === 'pending' && step.tool === 'auto')
  const step = exact ?? equivalent ?? fallback ?? {
    step_id: `step_${plan.steps.length + 1}`,
    description: `调用 ${toolName}`,
    tool: toolName,
    params: {},
    depends_on: [],
    risk_level: riskForTool(toolName),
    status: 'pending' as const,
  }
  if (!plan.steps.includes(step)) plan.steps.push(step)
  step.status = 'executing'
  step.tool = toolName
  step.risk_level = riskForTool(toolName)
  step.started_at = new Date().toISOString()
  return step
}

export function completePlanStep(step: TaskStep | undefined, result: unknown, reportedOutcome?: { ok: boolean; error?: string; message?: string }): void {
  if (!step) return
  let outcome: any = result
  if (typeof result === 'string') {
    try { outcome = JSON.parse(result) } catch { /* Non-JSON observations are successful text. */ }
  }
  if (reportedOutcome) outcome = reportedOutcome
  if (outcome && typeof outcome === 'object' && outcome.ok === false) {
    step.status = outcome.error === 'ACTION_REJECTED' ? 'skipped' : 'failed'
    step.error = String(outcome.message || outcome.error || '工具执行失败')
  } else {
    step.status = 'completed'
  }
  step.result = result
  step.completed_at = new Date().toISOString()
}

export function finishPlan(plan: TaskPlan, answer: string): void {
  const now = new Date().toISOString()
  const webEvidenceTools = new Set(['web_search', 'browser_search', 'fetch_webpage', 'browser_extract'])
  const requiresExactPage = /(这个网页|该网页|此网页|这个链接|提取.*正文|阅读.*网页|总结.*网页)/u.test(plan.user_request)
  for (const [index, step] of plan.steps.entries()) {
    if (step.status !== 'failed' || !['L0', 'L1'].includes(step.risk_level)) continue
    const laterSuccess = plan.steps.slice(index + 1).some(later => later.status === 'completed'
      && (requiresExactPage
        ? step.tool === 'fetch_webpage' && later.tool === 'fetch_webpage'
          && typeof step.params.urlHash === 'string' && later.params.urlHash === step.params.urlHash
        : later.tool === step.tool || (webEvidenceTools.has(step.tool) && webEvidenceTools.has(later.tool))))
    const existingWebSource = !requiresExactPage && webEvidenceTools.has(step.tool)
      && plan.steps.some(other => other !== step && other.status === 'completed' && webEvidenceTools.has(other.tool))
    if (laterSuccess || existingWebSource) {
      step.status = 'skipped'
      step.error = `${step.error || '首次调用失败'}；其它工具已提供替代结果`
    }
  }
  const failed = plan.steps.some(step => step.status === 'failed' || step.status === 'executing'
    || (step.status === 'pending' && step.tool !== 'auto'))
  const cancelled = plan.steps.some(step => {
    if (step.status !== 'skipped') return false
    try { return JSON.parse(String(step.result)).error === 'ACTION_REJECTED' } catch { return false }
  })
  for (const step of plan.steps) {
    if (step.status === 'executing') {
      // A started call without an observation is not proof that its side effect happened.
      step.status = 'failed'
      step.error ??= `未收到 ${step.tool} 的执行结果，无法确认是否完成`
      step.completed_at = now
    } else if (step.status === 'pending' && step.tool === 'auto') {
      step.status = failed || cancelled ? 'skipped' : 'completed'
      if (!failed && !cancelled) step.result = answer
      step.completed_at = now
    } else if (step.status === 'pending') {
      step.status = 'failed'
      step.error = `计划中的 ${step.tool} 工具未执行`
      step.completed_at = now
    }
  }
  plan.status = failed || plan.steps.some(step => step.status === 'failed') ? 'failed' : cancelled ? 'cancelled' : 'completed'
}

export function pausePlan(plan: TaskPlan, toolName: string): TaskStep | undefined {
  const step = plan.steps.find(item => item.status === 'executing' && item.tool === toolName)
    ?? startPlanStep(plan, toolName)
  if (step) step.status = 'awaiting_confirm'
  plan.status = 'paused'
  return step
}

export function failPlan(plan: TaskPlan, message: string): void {
  const active = plan.steps.find(step => step.status === 'executing' || step.status === 'awaiting_confirm')
  if (active) {
    active.status = 'failed'
    active.error = message
    active.completed_at = new Date().toISOString()
  }
  plan.status = 'failed'
}

export function cancelPlan(plan: TaskPlan): void {
  for (const step of plan.steps) {
    if (!['pending', 'executing', 'awaiting_confirm'].includes(step.status)) continue
    step.status = 'skipped'
    step.error = '用户已取消任务；已完成的操作不会回滚'
    step.completed_at = new Date().toISOString()
  }
  plan.status = 'cancelled'
}

export function extractLastAnswer(messages: unknown[] | undefined): string {
  const last = [...(messages ?? [])].reverse().find((message: any) => message?._getType?.() === 'ai' || message?.type === 'ai') as AIMessage | undefined
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  if (!Array.isArray(last.content)) return ''
  return last.content.map((part: any) => typeof part === 'string' ? part : part?.text ?? '').join('')
}

export function riskForTool(tool: string): RiskLevel {
  if (['auto', 'get_datetime', 'calculate'].includes(tool)) return 'L0'
  if (['delete_file', 'batch_move_files', 'edit_docx'].includes(tool)) return 'L3'
  if (['write_file', 'create_docx', 'copy_file', 'move_file', 'rename_file', 'create_folder', 'open_file', 'launch_program', 'launch_app', 'read_clipboard', 'write_clipboard', 'capture_screen_vision', 'take_screenshot', 'control_window', 'move_window', 'mouse_click', 'mouse_double_click', 'mouse_drag', 'type_text', 'press_keys', 'set_system_volume', 'set_wallpaper'].includes(tool)) return 'L2'
  return 'L1'
}
