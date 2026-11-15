import { describe, expect, it } from 'vitest'
import { RunStatus, TimelineKind } from '@repo/shared'
import { RunSubAgentTool } from '../../src/modules/ai/tools/subagent.tool.js'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { buildToolStackDeps, makeToolContext, specByKey } from '../helpers/ai-tool-stack.js'

/**
 * `wait-sub-agent` / `sub-agent-list` 的口径回归。
 *
 * 语义（2026-11-15 定）：
 * - `list` 按**会话**列子助手（跨轮可见），只回状态与运行元数据 + `batchRunId`，不回结论；
 * - `wait` 传 id 就等这些（已完成的也返回 path）；不传 = 等本会话**所有未完成**的子（跨轮可见）。
 */
const envelope = {
  conversationId: 'conv-parent',
  parentRunId: 'run-parent',
  triggeredBy: 'user-1',
  isAdmin: false,
  depth: 0,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  model: {
    id: 'm',
    modelRef: 'mock/mock',
    modelKey: 'mock',
    displayName: 'mock',
    providerKind: 'openai-compatible',
    apiKey: 'k',
    contextWindow: null,
  },
  childToolbox: new Map(),
  skills: [],
}

const child = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub-run-1',
  conversationId: 'sub-conv-1',
  parentRunId: 'batch-1',
  agentKey: 'sub:剧情主线',
  status: RunStatus.Succeeded,
  errorMessage: null,
  stepCount: 16,
  toolCallCount: 24,
  durationMs: 95_700,
  usage: { totalTokens: 1_100_000 },
  startedAt: new Date('2026-11-15T10:25:01.191Z'),
  finishedAt: new Date('2026-11-15T10:26:36.900Z'),
  ...overrides,
})

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
  debug: () => undefined,
}

const build = (
  children: Array<Record<string, unknown>>,
  options: { text?: string; consumed?: boolean } = {},
) => {
  const appended: Array<Record<string, unknown>> = []
  const consumed: string[] = []
  const deps = buildToolStackDeps()
  const tool = new RunSubAgentTool(
    {} as never,
    silentLogger as never,
    { listSessionChildren: async () => children } as never,
    {
      lastTextOfRun: async () => options.text ?? '完整结论',
      append: async (row: Record<string, unknown>) => {
        appended.push(row)
      },
    } as never,
    {
      consumeByDedupe: async (id: string) => {
        consumed.push(id)
        return options.consumed ?? true
      },
    } as never,
  )
  return { deps, tool, appended, consumed }
}

describe('sub-agent-list（看状态）', () => {
  it('跨轮可见：不同批次的子助手一起列出，带 batchRunId 与运行元数据', async () => {
    const { deps, tool } = build([
      child(),
      child({
        id: 'sub-run-2',
        conversationId: 'sub-conv-2',
        parentRunId: 'batch-2',
        agentKey: 'sub:人物关系',
        status: RunStatus.Running,
        finishedAt: null,
        usage: null,
      }),
    ])
    const spec = specByKey(tool, TOOL_KEYS.subAgentList)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec({}, ctx as never)) as {
      agents: Array<Record<string, unknown>>
    }

    expect(out.agents).toHaveLength(2)
    expect(out.agents[0]).toMatchObject({
      batchRunId: 'batch-1',
      status: 'succeeded',
      stepCount: 16,
      toolCallCount: 24,
      durationMs: 95_700,
      tokens: 1_100_000,
    })
    expect(out.agents[1]).toMatchObject({ batchRunId: 'batch-2', status: 'running' })
    // 状态查询不该带结论位置
    expect(out.agents[0]!.path).toBeUndefined()
    expect(out.agents[0]!.bytes).toBeUndefined()
  })

  it('按 status 过滤', async () => {
    const { deps, tool } = build([
      child(),
      child({ id: 'sub-run-2', conversationId: 'sub-conv-2', status: RunStatus.Running }),
    ])
    const spec = specByKey(tool, TOOL_KEYS.subAgentList)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec({ status: RunStatus.Running }, ctx as never)) as {
      agents: Array<Record<string, unknown>>
    }
    expect(out.agents).toHaveLength(1)
    expect(out.agents[0]!.status).toBe('running')
  })
})

describe('wait-sub-agent（等结果）', () => {
  it('传 sub_agent_ids：已完成的也返回 path（不再返回摘要）', async () => {
    const { deps, tool } = build([child()], { text: 'A'.repeat(1_000) })
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec(
      { sub_agent_ids: ['sub-conv-1'], timeout_ms: 1_000 },
      ctx as never,
    )) as {
      agents: Array<{ path?: string; summary?: string }>
      pending: string[]
      timedOut: boolean
    }

    expect(out.agents).toHaveLength(1)
    expect(out.agents[0]!.path).toBe('subagents/剧情主线-sub-run-1.md')
    expect(out.agents[0]!.summary).toBeUndefined()
    expect(out.pending).toEqual([])
    expect(out.timedOut).toBe(false)
  })

  it('不传 id：只等本会话未完成的子（已完成的不会被等，返回空）', async () => {
    const { deps, tool } = build([child()])
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec({ timeout_ms: 1 }, ctx as never)) as {
      agents: Array<Record<string, unknown>>
      pending: string[]
      timedOut: boolean
    }

    expect(out.agents).toEqual([])
    expect(out.pending).toEqual([])
    expect(out.timedOut).toBe(false)
  })

  it('不传 id：等还在跑的那批，超时返回 pending', async () => {
    const { deps, tool } = build([
      child(),
      child({
        id: 'sub-run-2',
        conversationId: 'sub-conv-2',
        parentRunId: 'batch-1',
        agentKey: 'sub:人物关系',
        status: RunStatus.Running,
        finishedAt: null,
        usage: null,
      }),
    ])
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec({ timeout_ms: 1 }, ctx as never)) as {
      agents: Array<Record<string, unknown>>
      pending: string[]
      timedOut: boolean
    }

    expect(out.agents).toEqual([])
    expect(out.pending).toEqual(['sub-conv-2'])
    expect(out.timedOut).toBe(true)
  })

  it('消费队列项成功时补写「子助手完成」卡（wait 抢先消费，dispatcher 不再写）', async () => {
    const { deps, tool, appended, consumed } = build([child()])
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await spec.exec({ sub_agent_ids: ['sub-conv-1'], timeout_ms: 1_000 }, ctx as never)

    expect(consumed).toEqual(['sub-run-1'])
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({
      conversationId: 'conv-parent',
      runId: 'run-parent',
      kind: TimelineKind.Status,
      payload: { status: 'subagent_completed', subRunId: 'sub-run-1', name: '剧情主线' },
    })
  })

  it('队列项已被 dispatcher 消费时不再重复写卡', async () => {
    const { deps, tool, appended } = build([child()], { consumed: false })
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await spec.exec({ sub_agent_ids: ['sub-conv-1'], timeout_ms: 1_000 }, ctx as never)

    expect(appended).toHaveLength(0)
  })
})
