import { describe, expect, it } from 'vitest'
import type { AgentRunModel } from '@repo/shared'
import type { UIMessage } from 'ai'
import {
  collectSubAgentLives,
  delegatedToolCallIds,
  subAgentBodyText,
  isSubAgentActive,
  liveSubAgentsOf,
  subAgentStatus,
  subAgentTabs,
} from '../src/app/(standalone)/main/ai/chat/sub-agent-live.ts'

/**
 * 子助手实时过程的收集（纯逻辑，node 环境）。
 *
 * 要钉住的是**运行中也能在右栏看到东西**这条口径 + 与库里 run 的合流规则：
 * 1. 状态块按 `id` 归并（后者覆盖）与增量块逐帧累积都要还原出来；
 * 2. 状态块把 `status: running` 覆盖成工具事件之后（真实流的形态），**仍然算"在跑"**
 *    —— 否则界面上会显示成"未知"，用户以为它挂了；
 * 3. 库里的 run 与实时数据**合流**成一个 tab 列表（谁先有就先用谁的），不漏 tab、不重 tab。
 */

const part = (value: { type: string; id?: string; data?: unknown }) => value

const liveMessage = (parts: unknown[]): UIMessage =>
  ({ id: 'm1', role: 'assistant', parts }) as unknown as UIMessage

const run = (overrides: Partial<AgentRunModel> & { id: string }): AgentRunModel =>
  ({
    conversationId: 'conv_1',
    parentRunId: 'run_root',
    depth: 1,
    toolCallId: 'call_1',
    agentKey: 'sub:北美欧洲线',
    triggeredBy: null,
    requestId: null,
    status: 'running',
    recoveryCount: 0,
    errorCode: null,
    errorStage: null,
    errorMessage: null,
    durationMs: null,
    firstTokenMs: null,
    stepCount: 3,
    toolCallCount: 5,
    usage: null,
    ...overrides,
  }) as unknown as AgentRunModel

describe('collectSubAgentLives', () => {
  it('状态块 + 增量块还原成一个子助手（名字 / 状态 / 结论 / 推理与正文增量）', () => {
    const lives = collectSubAgentLives([
      part({
        type: 'data-sub-agent',
        id: 'sub1',
        data: { runId: 'sub1', name: '北美欧洲线', status: 'running', task: '查北美市场' },
      }),
      part({
        type: 'data-sub-agent-delta',
        data: { runId: 'sub1', name: '北美欧洲线', kind: 'reasoning', text: '先查公开资料' },
      }),
      part({
        type: 'data-sub-agent-delta',
        data: { runId: 'sub1', kind: 'text', text: '结论一' },
      }),
      part({
        type: 'data-sub-agent',
        id: 'sub1',
        data: {
          runId: 'sub1',
          name: '北美欧洲线',
          status: 'succeeded',
          result: '结论一',
          stepCount: 3,
          toolCallCount: 5,
        },
      }),
    ])

    expect(lives).toHaveLength(1)
    expect(lives[0]).toMatchObject({
      runId: 'sub1',
      name: '北美欧洲线',
      status: 'succeeded',
      task: '查北美市场',
      result: '结论一',
      stepCount: 3,
      toolCallCount: 5,
    })
    expect(lives[0]!.deltas).toEqual([
      { kind: 'reasoning', text: '先查公开资料' },
      { kind: 'text', text: '结论一' },
    ])
  })

  it('状态块只带 `event`（真实流的形态）时仍然认得出它在跑，工具往返也留得下', () => {
    const lives = collectSubAgentLives([
      part({ type: 'data-sub-agent', id: 'sub1', data: { runId: 'sub1', name: '中国网文线', status: 'running' } }),
      part({
        type: 'data-sub-agent',
        id: 'sub1',
        data: {
          runId: 'sub1',
          name: '中国网文线',
          event: { kind: 'tool-call', toolCallId: 'c1', toolKey: 'run-command', input: { cmd: 'ls' } },
        },
      }),
    ])

    expect(lives[0]!.status).toBe('running')
    expect(lives[0]!.events).toEqual([
      { kind: 'tool-call', toolCallId: 'c1', toolKey: 'run-command', input: { cmd: 'ls' }, output: undefined, errorText: null, isError: false },
    ])
    expect(isSubAgentActive(lives[0]!)).toBe(true)
  })

  it('状态块连 id 都没有时退到 `data.runId`；只有增量块也能成卡（名字从增量里取）', () => {
    const lives = collectSubAgentLives([
      part({ type: 'data-sub-agent', data: { runId: 'sub2', name: '技术线', status: 'running' } }),
      part({ type: 'data-sub-agent-delta', data: { runId: 'sub3', name: '市场线', kind: 'text', text: '开始' } }),
      part({ type: 'data-sub-agent', data: { name: '没有 id' } }),
    ])

    expect(lives.map((live) => live.runId)).toEqual(['sub2', 'sub3'])
    expect(lives[1]).toMatchObject({ name: '市场线', deltas: [{ kind: 'text', text: '开始' }] })
  })

  it('没有最终状态的按"进行中"算；已经收尾的按库里那份展示', () => {
    const running = collectSubAgentLives([
      part({ type: 'data-sub-agent', id: 'sub1', data: { runId: 'sub1', name: 'A', event: { kind: 'tool-call' } } }),
    ])[0]!
    const done = collectSubAgentLives([
      part({ type: 'data-sub-agent', id: 'sub2', data: { runId: 'sub2', name: 'B', status: 'failed' } }),
    ])[0]!

    expect(subAgentStatus(running)).toBe('running')
    expect(isSubAgentActive(running)).toBe(true)
    expect(isSubAgentActive(done)).toBe(false)
    expect(subAgentStatus(done)).toBe('failed')
  })
})

describe('liveSubAgentsOf', () => {
  it('取**最后一条含子助手块**的消息（流刚收尾、末条已翻页时也拿得到）', () => {
    const withSubAgents = liveMessage([
      part({ type: 'data-sub-agent', id: 'sub1', data: { runId: 'sub1', name: '北美欧洲线', status: 'succeeded' } }),
    ])
    const later = liveMessage([{ type: 'text', text: '汇总完成' }])

    expect(liveSubAgentsOf([withSubAgents, later])[0]!.runId).toBe('sub1')
    expect(liveSubAgentsOf([later])).toEqual([])
  })
})

describe('subAgentTabs', () => {
  it('库里的 run 与实时数据合流：顺序稳定、不重不漏、活动态取"两边有一个在跑"', () => {
    const tabs = subAgentTabs(
      [run({ id: 'run_1', status: 'succeeded' }), run({ id: 'run_2', status: 'running', agentKey: 'sub:中国网文线' })],
      [
        {
          runId: 'run_2',
          name: '中国网文线',
          status: 'succeeded',
          deltas: [],
          events: [],
        },
        { runId: 'run_3', name: '新起的子助手', deltas: [], events: [] },
      ],
    )

    expect(tabs.map((tab) => tab.runId)).toEqual(['run_1', 'run_2', 'run_3'])
    expect(tabs.map((tab) => tab.name)).toEqual(['北美欧洲线', '中国网文线', '新起的子助手'])
    // run_2：实时块说跑完了，但库里的 run 还是 running —— 只要有一边在跑就算活动
    expect(tabs.map((tab) => tab.active)).toEqual([false, true, true])
  })

  it('刷新后（没有实时数据）全部由库里的 run 构成', () => {
    const tabs = subAgentTabs([run({ id: 'run_1', status: 'succeeded' })], [])

    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ runId: 'run_1', name: '北美欧洲线', active: false })
    expect(tabs[0]!.live).toBeUndefined()
  })

  it('**没有任何子助手活动**时：没有实时数据、也没有 tab（主 agent 自己干完了）', () => {
    expect(
      liveSubAgentsOf([liveMessage([{ type: 'text', text: '主 agent 自己答完了' }])]),
    ).toEqual([])
    expect(subAgentTabs([], [])).toEqual([])
  })

  it('子助手活动结束后不再算活动（库里也没有还在跑的 run）', () => {
    const finished = collectSubAgentLives([
      part({
        type: 'data-sub-agent',
        id: 'sub1',
        data: { runId: 'sub1', name: '北美欧洲线', status: 'succeeded' },
      }),
    ])
    const tabs = subAgentTabs([run({ id: 'sub1', status: 'succeeded' })], finished)

    expect(tabs.map((tab) => tab.active)).toEqual([false])
  })
})

describe('delegatedToolCallIds（把 run-sub-agent 工具卡去重掉）', () => {
  it('收下状态块里的 toolCallId（服务端在子 run 状态块里带上发起它的工具调用 id）', () => {
    const lives = collectSubAgentLives([
      {
        type: 'data-sub-agent',
        id: 'run-1',
        data: { runId: 'run-1', name: '微博热榜', toolCallId: 'call_a', status: 'running' },
      },
      {
        type: 'data-sub-agent',
        id: 'run-2',
        data: { runId: 'run-2', name: '抖音热榜', toolCallId: 'call_b', status: 'succeeded' },
      },
    ])

    expect(lives.map((live) => live.toolCallId)).toEqual(['call_a', 'call_b'])
    expect([...delegatedToolCallIds(lives)].sort()).toEqual(['call_a', 'call_b'])
  })

  it('老数据 / 非流式没有 toolCallId：不误吞任何工具卡（集合里不出现空值）', () => {
    const lives = collectSubAgentLives([
      { type: 'data-sub-agent', id: 'run-1', data: { runId: 'run-1', name: '子助手' } },
      { type: 'data-sub-agent-delta', data: { runId: 'run-1', kind: 'text', text: 'hi' } },
    ])

    expect(delegatedToolCallIds(lives).size).toBe(0)
  })
})

describe('subAgentBodyText（紧凑卡展开后的正文）', () => {
  const live = (over: Partial<import('../src/app/(standalone)/main/ai/chat/sub-agent-live.ts').SubAgentLive>) => ({
    runId: 'run-1',
    name: '子助手',
    deltas: [],
    events: [],
    ...over,
  })

  it('跑完优先给最终结论（result）', () => {
    expect(
      subAgentBodyText(live({ result: '两榜都抓到了。', deltas: [{ kind: 'text', text: '中间的碎碎念' }] })),
    ).toBe('两榜都抓到了。')
  })

  it('运行中还没有结论时，给已经产出的正文（所以展开是"边跑边长"）', () => {
    expect(
      subAgentBodyText(
        live({
          deltas: [
            { kind: 'reasoning', text: '想一下' },
            { kind: 'text', text: '先取时间戳。' },
            { kind: 'text', text: '再抓榜单。' },
          ],
        }),
      ),
    ).toBe('先取时间戳。再抓榜单。')
  })

  it('啥都没有 → null（卡片给诚实提示，不显示空白）', () => {
    expect(subAgentBodyText(live({ deltas: [{ kind: 'reasoning', text: '只有推理' }] }))).toBeNull()
    expect(subAgentBodyText(live({ result: '   ' }))).toBeNull()
  })
})
