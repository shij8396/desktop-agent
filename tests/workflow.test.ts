import { describe, expect, it } from 'vitest'
import { completePlanStep, createTaskPlan, finishPlan, selectExecutionMode, startPlanStep } from '../src/agent/workflow.js'

describe('LangGraph task activity projection', () => {
  it('starts without invented tool steps', () => {
    const plan = createTaskPlan('查询今天的天气', 'task-1')
    expect(plan).toMatchObject({ plan_id: 'task-1', status: 'executing', steps: [] })
  })

  it('routes only explicitly complex work to Deep Agents', () => {
    expect(selectExecutionMode('普通问题')).toBe('standard')
    expect(selectExecutionMode('请做一次多来源深度调研并生成报告')).toBe('deep')
    expect(selectExecutionMode('请做一次多来源深度调研并生成报告', false)).toBe('standard')
  })

  it('records only tools that actually ran and uses the full outcome', () => {
    const plan = createTaskPlan('查询今天的天气')
    const step = startPlanStep(plan, 'get_weather')
    expect(step).toMatchObject({ tool: 'get_weather', status: 'executing', risk_level: 'L1' })
    completePlanStep(step, '{"ok":true,"result":', { ok: false, error: 'TOOL_FAILED', message: '连接失败' })
    finishPlan(plan, '天气查询失败')
    expect(plan).toMatchObject({ status: 'failed', steps: [{ status: 'failed', error: '连接失败' }] })
  })

  it('completes a text-only conversation without claiming uncalled tools', () => {
    const plan = createTaskPlan('你叫什么')
    finishPlan(plan, '我是小伴。')
    expect(plan).toMatchObject({ status: 'completed', steps: [] })
  })

  it('records multiple real calls to the same tool separately', () => {
    const plan = createTaskPlan('查询天气')
    completePlanStep(startPlanStep(plan, 'get_weather'), '{"ok":true}')
    completePlanStep(startPlanStep(plan, 'get_weather'), '{"ok":true}')
    expect(plan.steps.map(step => step.tool)).toEqual(['get_weather', 'get_weather'])
  })

  it('does not mark a started tool as successful without its observation', () => {
    const plan = createTaskPlan('创建文件')
    startPlanStep(plan, 'write_file')
    finishPlan(plan, '文件已创建')
    expect(plan.status).toBe('failed')
    expect(plan.steps[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('无法确认') })
  })

  it('keeps a failed web fetch visible but accepts a later successful source', () => {
    const plan = createTaskPlan('搜索资料')
    completePlanStep(startPlanStep(plan, 'fetch_webpage'), '{"ok":false,"error":"HTTP_FORBIDDEN"}')
    completePlanStep(startPlanStep(plan, 'web_search'), '{"ok":true,"results":[{"url":"https://example.com"}]}')
    finishPlan(plan, '已找到其它来源')
    expect(plan.status).toBe('completed')
    expect(plan.steps.map(step => step.status)).toEqual(['skipped', 'completed'])
    expect(plan.steps[0].error).toContain('其它工具已提供替代结果')
  })

  it('can continue broad research from an earlier search when a page blocks fetching', () => {
    const plan = createTaskPlan('制定开封旅游攻略')
    completePlanStep(startPlanStep(plan, 'web_search'), '{"ok":true,"results":[{"url":"https://example.com"}]}')
    completePlanStep(startPlanStep(plan, 'fetch_webpage'), '{"ok":false,"error":"HTTP_FORBIDDEN"}')
    finishPlan(plan, '根据搜索结果给出有限建议')
    expect(plan).toMatchObject({ status: 'completed', steps: [{ status: 'completed' }, { status: 'skipped' }] })
  })

  it('does not substitute search snippets for a user-requested exact page', () => {
    const plan = createTaskPlan('提取这个网页的正文 https://example.com')
    completePlanStep(startPlanStep(plan, 'web_search'), '{"ok":true,"results":[{"url":"https://example.com"}]}')
    completePlanStep(startPlanStep(plan, 'fetch_webpage'), '{"ok":false,"error":"HTTP_FORBIDDEN"}')
    finishPlan(plan, '正文未读取')
    expect(plan.status).toBe('failed')
  })
})
