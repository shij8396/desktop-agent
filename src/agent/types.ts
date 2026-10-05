export type TaskStatus = 'planning' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type StepStatus = 'pending' | 'awaiting_confirm' | 'executing' | 'completed' | 'failed' | 'skipped'
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3'
export type AgentState = 'idle' | 'thinking' | 'acting' | 'observing' | 'answering' | 'error' | 'awaiting_confirmation'

export interface TaskStep {
  step_id: string
  description: string
  tool: string
  params: Record<string, unknown>
  depends_on: string[]
  risk_level: RiskLevel
  status: StepStatus
  result?: unknown
  error?: string
  started_at?: string
  completed_at?: string
}

export interface TaskPlan {
  plan_id: string
  user_request: string
  created_at: string
  steps: TaskStep[]
  status: TaskStatus
}

export interface AgentEvent {
  type: 'thought' | 'action' | 'observation' | 'answer' | 'plan' | 'error' | 'confirmation_required' | 'step_update' | 'desktop_request'
  content: string
  step_id?: string
  plan?: TaskPlan
  timestamp: string
  /** desktop_request：需要前端桥接执行的 Tauri 工具 */
  toolId?: string
  /** Correlates one tool invocation with its observation when tools run concurrently. */
  invocationId?: string
  tool?: string
  toolInput?: Record<string, unknown>
  action?: Record<string, unknown>
  toolOutcome?: { ok: boolean; error?: string; message?: string }
}

export interface AgentContext {
  sessionId: string
  question: string
  plan?: TaskPlan
  currentStep?: number
  forceWeb: boolean
  screenshot?: string
}

// Callback for streaming events to the client
export type AgentEventCallback = (event: AgentEvent) => void | Promise<void>
