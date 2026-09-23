import { describe, expect, it } from 'vitest'
import type { AgentRunModel, AgentTimelineItemModel } from '@repo/shared'
import { toSubAgentDetail, toUIMessages } from '../src/app/ai/chat/history.ts'

/**
 * 时间线 → UIMessage 的映射（纯逻辑，node 环境）。
 *
 * 钉住三条会伤到用户的行为：
 * 1. 刷新后历史能重建（用户 + 助手两条消息）；
 * 2. 工具调用与结果**配对成一个 part**（否则工具卡片只有入参没有出参）；
 * 3. 子 agent 的明细**不进主对话**，但它的结论要合成成 `data-sub-agent` part
 *    （于是历史里的子助手面板与实时流看到的是同一种结构）。
 */

const CONVERSATION = 'conv_1'
const ROOT_RUN = 'run_1'
const CHILD_RUN = 'run_2'

const item = (
  partial: Partial<AgentTimelineItemModel> & { seq: number; kind: string },
): AgentTimelineItemModel =>
  ({
    id: `t${partial.seq}`,
    conversationId: CONVERSATION,
    runId: ROOT_RUN,
    messageId: 'msg_1',
    attempt: 1,
    role: 'assistant',
    state: null,
    toolKey: null,
    toolCallId: null,
    startedAt: '2026-09-23T10:00:00.000Z',
    finishedAt: '2026-09-23T10:00:01.000Z',
    durationMs: 1000,
    usage: null,
    payload: null,
    ...partial,
  }) as AgentTimelineItemModel

const run = (id: string, parentRunId: string | null): AgentRunModel =>
  ({
    id,
    conversationId: CONVERSATION,
    parentRunId,
    depth: parentRunId ? 1 : 0,
    toolCallId: parentRunId ? 'call_1' : null,
    agentKey: parentRunId ? 'sub:待办统计' : 'assistant',
    triggeredBy: 'user_1',
    requestId: null,
    status: 'succeeded',
    recoveryCount: 0,
    errorCode: null,
    errorStage: null,
    errorMessage: null,
    durationMs: 1000,
    firstTokenMs: 100,
    stepCount: 1,
    toolCallCount: 1,
    usage: null,
  }) as AgentRunModel

describe('toUIMessages', () => {
  it('重建用户与助手两条消息，且保持 parts 顺序', () => {
    const messages = toUIMessages(
      [
        item({ seq: 1, kind: 'text', role: 'user', payload: { text: '帮我看看待办' } }),
        item({ seq: 2, kind: 'reasoning', payload: { text: '先列出来' } }),
        item({ seq: 3, kind: 'text', payload: { text: '共 2 条待办。' } }),
      ],
      [run(ROOT_RUN, null)],
    )

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(messages[0].parts[0]).toMatchObject({ type: 'text', text: '帮我看看待办' })

    const parts = messages[1].parts
    expect(parts.map((part) => part.type)).toEqual(['reasoning', 'text'])
    expect(parts[1]).toMatchObject({ type: 'text', text: '共 2 条待办。' })
  })

  it('工具调用与结果按 tool_call_id 配对成一个 part（含完整出参）', () => {
    const messages = toUIMessages(
      [
        item({
          seq: 1,
          kind: 'tool-call',
          toolKey: 'list-todos',
          toolCallId: 'call_a',
          payload: { toolCallId: 'call_a', toolName: 'list-todos', input: { limit: 3 } },
        }),
        item({
          seq: 2,
          kind: 'tool-result',
          toolKey: 'list-todos',
          toolCallId: 'call_a',
          payload: { toolCallId: 'call_a', toolName: 'list-todos', output: { total: 2 }, isError: false },
        }),
      ],
      [run(ROOT_RUN, null)],
    )

    expect(messages[0].parts).toHaveLength(1)
    expect(messages[0].parts[0]).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'list-todos',
      toolCallId: 'call_a',
      state: 'output-available',
      input: { limit: 3 },
      output: { total: 2 },
    })
  })

  it('子 agent：明细不进主对话，但结论合成成 data-sub-agent part（与实时流同构）', () => {
    const messages = toUIMessages(
      [
        item({ seq: 1, kind: 'text', role: 'user', payload: { text: '统计一下' } }),
        item({
          seq: 2,
          kind: 'tool-call',
          toolKey: 'run-sub-agent',
          toolCallId: 'call_sub',
          payload: { toolCallId: 'call_sub', toolName: 'run-sub-agent', input: { name: '待办统计' } },
        }),
        item({
          seq: 3,
          kind: 'tool-result',
          toolKey: 'run-sub-agent',
          toolCallId: 'call_sub',
          payload: {
            toolCallId: 'call_sub',
            toolName: 'run-sub-agent',
            output: {
              subRunId: CHILD_RUN,
              name: '待办统计',
              status: 'succeeded',
              result: '共 2 条，1 条已完成',
              stepCount: 2,
              toolCallCount: 1,
              durationMs: 800,
              usage: { totalTokens: 152 },
            },
            isError: false,
          },
        }),
        // 子 run 自己的事件：属于审计资料，不该铺进主对话
        item({
          seq: 4,
          runId: CHILD_RUN,
          kind: 'text',
          payload: { text: '子助手结论：共 2 条待办' },
        }),
      ],
      [run(ROOT_RUN, null), run(CHILD_RUN, ROOT_RUN)],
    )

    const parts = messages[1].parts
    const subAgent = parts.find((part) => part.type === 'data-sub-agent')
    expect(subAgent).toBeDefined()
    expect(subAgent).toMatchObject({
      type: 'data-sub-agent',
      id: CHILD_RUN,
      data: { runId: CHILD_RUN, name: '待办统计', status: 'succeeded', result: '共 2 条，1 条已完成' },
    })
    // 子 run 的文本没有变成主对话里的 text part
    expect(parts.some((part) => part.type === 'text' && part.text.includes('子助手结论'))).toBe(false)
  })
})

describe('toSubAgentDetail', () => {
  it('按顺序汇总推理 / 文本 / 工具事件，跳过任务本身（user 行）', () => {
    const detail = toSubAgentDetail([
      item({ seq: 1, runId: CHILD_RUN, kind: 'text', role: 'user', payload: { text: '任务' } }),
      item({ seq: 2, runId: CHILD_RUN, kind: 'reasoning', payload: { text: '先取数' } }),
      item({ seq: 3, runId: CHILD_RUN, kind: 'tool-call', toolKey: 'list-todos', payload: { input: { limit: 3 } } }),
      item({ seq: 4, runId: CHILD_RUN, kind: 'tool-result', toolKey: 'list-todos', payload: { output: { total: 2 } } }),
      item({ seq: 5, runId: CHILD_RUN, kind: 'text', payload: { text: '共 2 条' } }),
    ])

    expect(detail.reasoning).toBe('先取数')
    expect(detail.text).toBe('共 2 条')
    expect(detail.events).toEqual([
      { kind: 'tool-call', toolKey: 'list-todos', input: { limit: 3 } },
      { kind: 'tool-result', toolKey: 'list-todos', output: { total: 2 }, isError: false },
    ])
  })
})
