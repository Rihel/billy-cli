import { describe, expect, it } from 'vitest'
import { RunStatus, TimelineKind } from '@repo/shared'
import { RunSubAgentTool } from '../../src/modules/ai/tools/builtin/subagent.tool.js'
import { TOOL_KEYS } from '../../src/modules/ai/tools/engine/tool-keys.js'
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
  options: { text?: string; consumed?: boolean; queuedKeys?: string[]; rowExists?: boolean } = {},
) => {
  const appended: Array<Record<string, unknown>> = []
  const consumed: string[] = []
  const markedConsumed: string[] = []
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
      // 队列里到底有没有这一行：默认「有」（已被 dispatcher 取走 / 已被消费）
      findByDedupe: async (id: string) =>
        (options.rowExists ?? true) ? { id: `q-${id}`, dedupeKey: id, status: 'started' } : null,
      // 本会话里还排着队、没被消费的完成项（不传 id 时收口要把它们也接进来）
      listQueuedSubAgentKeys: async () => options.queuedKeys ?? [],
      // 「结果已交付父」的事实标记：入队端 / 调度端据此不再唤醒
      markConsumed: async (id: string) => {
        markedConsumed.push(id)
      },
      isConsumed: async (id: string) => markedConsumed.includes(id),
    } as never,
  )
  return { deps, tool, appended, consumed, markedConsumed }
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

  it('path 的字节数 / 行数按子 run 正文算（不再 stat 宿主本地文件）', async () => {
    // 回归：工作区在容器时宿主本地没有这份文件，旧实现却 stat 出「存在 + 大小」，
    // 父 agent 按 path 去 read-file 必然 404（2026-11-22，会话 pyao4cssrwn3qf291wh8）。
    const text = '第一行\n第二行\n第三行'
    const { deps, tool } = build([child()], { text })
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec(
      { sub_agent_ids: ['sub-conv-1'], timeout_ms: 1_000 },
      ctx as never,
    )) as { agents: Array<Record<string, unknown>> }

    expect(out.agents[0]).toMatchObject({
      path: 'subagents/剧情主线-sub-run-1.md',
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: 3,
    })
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

  it('不传 id：已完成但通知还没被收口的子也归本次收口（并标记已交付）', async () => {
    const { deps, tool, consumed, markedConsumed, appended } = build([child()], {
      queuedKeys: ['sub-run-1'],
    })
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec({ timeout_ms: 1 }, ctx as never)) as {
      agents: Array<Record<string, unknown>>
      pending: string[]
      timedOut: boolean
    }

    // 回归：父收口时如果不接这一笔，父 run 结束后会补一轮「延迟唤醒」
    expect(out.agents).toHaveLength(1)
    expect(out.agents[0]!.path).toBe('subagents/剧情主线-sub-run-1.md')
    expect(out.pending).toEqual([])
    // 消费队列行 + 打「已交付」事实标记（晚到入队也能挡住）
    expect(consumed).toEqual(['sub-run-1'])
    expect(markedConsumed).toEqual(['sub-run-1'])
    expect(appended).toHaveLength(1)
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

  it('队列项已被 dispatcher 消费时不再重复写卡（但照样打「已交付」标记）', async () => {
    const { deps, tool, appended, markedConsumed } = build([child()], { consumed: false })
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await spec.exec({ sub_agent_ids: ['sub-conv-1'], timeout_ms: 1_000 }, ctx as never)

    expect(appended).toHaveLength(0)
    // 队列行被抢走时标记更重要：它挡的是「稍后才入队」的那一笔
    expect(markedConsumed).toEqual(['sub-run-1'])
  })

  it('队列行还没建出来（子 run 先翻终态、后入队）时，卡由 wait 补写', async () => {
    // 这一笔只有 wait 一个消费者：标记挡住晚到的入队 → dispatcher 不会跑 → 没有第二个人写卡
    const { deps, tool, appended, consumed, markedConsumed } = build([child()], {
      consumed: false,
      rowExists: false,
    })
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec(
      { sub_agent_ids: ['sub-conv-1'], timeout_ms: 1_000 },
      ctx as never,
    )) as { agents: Array<Record<string, unknown>> }

    expect(out.agents).toHaveLength(1)
    expect(consumed).toEqual(['sub-run-1']) // 尝试消费了（没命中：行还不存在）
    expect(markedConsumed).toEqual(['sub-run-1'])
    // 回归：卡不能丢 —— 时间线上它才是"这个子助手跑完了"的可见证据
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({
      kind: TimelineKind.Status,
      payload: { status: 'subagent_completed', subRunId: 'sub-run-1' },
    })
  })
})
