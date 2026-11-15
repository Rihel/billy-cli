import { describe, expect, it } from 'vitest'
import { RunStatus, TimelineKind } from '@repo/shared'
import { RunSubAgentTool } from '../../src/modules/ai/tools/subagent.tool.js'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { buildToolStackDeps, makeToolContext, specByKey } from '../helpers/ai-tool-stack.js'

/**
 * `wait-sub-agent` / `sub-agent-list` 的口径回归。
 *
 * 两个真实踩过的坑（2026-11-15，session `t9ums0…`）：
 * 1. `wait` 不带 `sub_agent_ids` 时只把「未完成」的放进 targets，全跑完后返回 `agents: []`，
 *    父模型以为结果被消费，白等 88 秒后又调一次；
 * 2. `list` 的 `resultSummary` 硬截 500 字且不标注，模型把摘要当完整结论。
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
  agentKey: 'sub:剧情主线',
  status: RunStatus.Succeeded,
  errorMessage: null,
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
    { listChildren: async () => children } as never,
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

describe('wait-sub-agent（取子助手结论）', () => {
  it('不带 sub_agent_ids：已完成的子助手也返回完整结论（不再返回空数组）', async () => {
    const { deps, tool } = build([child()], { text: 'A'.repeat(1_000) })
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec({ timeout_ms: 1_000 }, ctx as never)) as {
      agents: Array<{ summary?: string; path?: string }>
      pending: string[]
      timedOut: boolean
    }

    expect(out.agents).toHaveLength(1)
    // 只回路径（无 files 注入时没有 bytes/lines）：正文让模型自己 read-file 读
    expect(out.agents[0]!.path).toBe('subagents/剧情主线-sub-run-1.md')
    expect(out.agents[0]!.summary).toBeUndefined()
    expect(out.pending).toEqual([])
    expect(out.timedOut).toBe(false)
  })

  it('消费队列项成功时补写「子助手完成」卡（wait 抢先消费，dispatcher 不再写）', async () => {
    const { deps, tool, appended, consumed } = build([child()])
    const spec = specByKey(tool, TOOL_KEYS.waitSubAgent)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await spec.exec({ timeout_ms: 1_000 }, ctx as never)

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
    await spec.exec({ timeout_ms: 1_000 }, ctx as never)

    expect(appended).toHaveLength(0)
  })
})

describe('sub-agent-list（看状态）', () => {
  it('摘要超过上限时明确标注 summaryTruncated，并给出取全文的方式', async () => {
    const { deps, tool } = build([child()], { text: 'B'.repeat(3_000) })
    const spec = specByKey(tool, TOOL_KEYS.subAgentList)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec({}, ctx as never)) as {
      agents: Array<{ resultSummary?: string; path?: string }>
    }

    expect(out.agents[0]!.path).toBe('subagents/剧情主线-sub-run-1.md')
    expect(out.agents[0]!.resultSummary).toBeUndefined()
  })

  it('摘要未超限时不带截断标记', async () => {
    const { deps, tool } = build([child()], { text: '短结论' })
    const spec = specByKey(tool, TOOL_KEYS.subAgentList)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const out = (await spec.exec({}, ctx as never)) as {
      agents: Array<{ resultSummary?: string; summaryTruncated?: boolean }>
    }

    expect(out.agents[0]!.path).toBe('subagents/剧情主线-sub-run-1.md')
  })
})
