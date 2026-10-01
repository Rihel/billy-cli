import { describe, expect, it } from 'vitest'
import { RunSubAgentTool } from '../../src/modules/ai/tools/subagent.tool.js'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { ToolDeniedError } from '../../src/modules/ai/core/tools/tools.types.js'
import { buildToolStackDeps, makeToolContext, specByKey } from '../helpers/ai-tool-stack.js'

/**
 * `run-sub-agent` 的单测：**执行体在端口后面**（`AgentRunner`），测试给一个假 runner，
 * 于是"跑一个完整 agent"这件事不需要模型、数据库、流（设计 §5.9）。
 */
const envelope = {
  conversationId: 'conv-1',
  parentRunId: 'run-1',
  triggeredBy: 'user-1',
  isAdmin: false,
  depth: 0,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  model: { id: 'm', modelRef: 'mock/mock', modelKey: 'mock', displayName: 'mock', providerKind: 'openai-compatible', apiKey: 'k', contextWindow: null },
  childToolbox: new Map(),
  skills: [],
}

const build = (runnerResult: unknown = { status: 'succeeded', result: 'done' }) => {
  const deps = buildToolStackDeps()
  const calls: unknown[] = []
  const runner = {
    runSubAgent: async (request: unknown) => {
      calls.push(request)
      return runnerResult
    },
  }
  const spec = specByKey(
    new RunSubAgentTool(runner as never, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      log: () => undefined,
      debug: () => undefined,
    } as never),
    TOOL_KEYS.runSubAgent,
  )
  return { deps, spec, calls, runner }
}

describe('run-sub-agent（创建子助手）', () => {
  it('把提示词 / 任务 / 调用 id / 信封与**四个旋钮**一起交给执行器', async () => {
    const { deps, spec, calls } = build()
    deps.source.set(TOOL_KEYS.runSubAgent, { config: { maxPerRun: 2, maxDepth: 1, maxSteps: 8, timeoutMs: 30_000 } })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope, toolCallId: 'call-9' })
    await spec.exec({ name: '统计', system_prompt: '你是统计助手', task: '统计一下' }, ctx as never)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      name: '统计',
      systemPrompt: '你是统计助手',
      task: '统计一下',
      toolCallId: 'call-9',
      quotas: { maxPerRun: 2, maxDepth: 1, maxSteps: 8, timeoutMs: 30_000 },
    })
  })

  it('没有信封 → 拒绝（配置错误，结论要能读懂）', async () => {
    const { deps, spec } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope: null, caller: null })
    await expect(
      spec.exec({ name: 'x', system_prompt: 'y', task: 'z' }, ctx as never),
    ).rejects.toBeInstanceOf(ToolDeniedError)
  })

  it('它是委派类工具，且明确不给子 agent（深度因此天然封顶）', () => {
    const { spec } = build()
    expect(spec.key).toBe(TOOL_KEYS.runSubAgent)
    expect(spec.delegation).toBe(true)
    expect(spec.child).toBe('deny')
  })

  it('四个旋钮默认都是 0（= 沿用部署默认，库里没配也能跑）', async () => {
    const { deps, spec } = build()
    const settings = await deps.config.settings(spec)
    expect(settings.config).toEqual({ maxPerRun: 0, maxDepth: 0, maxSteps: 0, timeoutMs: 0 })
  })

  it('执行器的结论原样交回主 agent（工具不加工结论）', async () => {
    const { deps, spec } = build({ status: 'rejected', result: '', reason: '配额已满' })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const outcome = await spec.exec({ name: 'x', system_prompt: 'y', task: 'z' }, ctx as never)
    expect(outcome).toMatchObject({ status: 'rejected', reason: '配额已满' })
  })
})
