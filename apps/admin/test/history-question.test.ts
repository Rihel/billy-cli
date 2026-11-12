import { TimelineKind, TimelineRole } from '@repo/shared'
import { describe, expect, it } from 'vitest'
import { toParts } from '../src/app/(app)/(standalone)/main/ai/chat/history'

describe('历史重建：问题卡', () => {
  const call = {
    seq: 1,
    role: TimelineRole.Assistant,
    kind: TimelineKind.ToolCall,
    toolKey: 'ask-user-questions',
    toolCallId: 'call_1',
    payload: { input: { questions: [] } },
  }

  it('挂起行还原成问题卡，且不铺原始工具卡', () => {
    const parts = toParts([
      call,
      {
        seq: 2,
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolSuspended,
        toolKey: 'ask-user-questions',
        toolCallId: 'call_1',
        payload: {
          runId: 'run_1',
          toolCallId: 'call_1',
          toolName: 'ask-user-questions',
          suspendPayload: {
            questions: [{ id: 'q1', type: 'text', title: '给谁看？' }],
          },
        },
      },
    ] as never)

    const card = parts.find((part) => part.type === 'data-tool-call-suspended') as
      | { data: { runId?: string; resumed?: boolean } }
      | undefined
    expect(card?.data.runId).toBe('run_1')
    expect(card?.data.resumed).toBe(false)
    expect(parts.some((part) => part.type === 'dynamic-tool')).toBe(false)
  })

  it('已有 tool-result 时标成 resumed，刷新后不再让用户重复回答', () => {
    const parts = toParts([
      call,
      {
        seq: 2,
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolSuspended,
        toolKey: 'ask-user-questions',
        toolCallId: 'call_1',
        payload: {
          runId: 'run_1',
          suspendPayload: { questions: [{ id: 'q1', type: 'text', title: '给谁看？' }] },
        },
      },
      {
        seq: 3,
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolResult,
        toolKey: 'ask-user-questions',
        toolCallId: 'call_1',
        payload: { output: { answers: [{ id: 'q1', value: '长辈' }] } },
      },
    ] as never)

    const card = parts.find((part) => part.type === 'data-tool-call-suspended') as
      | { data: { resumed?: boolean; answers?: { id: string; value: string | string[] }[] } }
      | undefined
    expect(card?.data.resumed).toBe(true)
    // 答案要跟着挂起行一起带出来：卡片留在原位置当只读的问答记录
    expect(card?.data.answers).toEqual([{ id: 'q1', value: '长辈' }])
  })

  it('用户取消整组回答：标成 resumed + cancelled，刷新后不再让用户回答', () => {
    const parts = toParts([
      call,
      {
        seq: 2,
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolSuspended,
        toolKey: 'ask-user-questions',
        toolCallId: 'call_1',
        payload: {
          runId: 'run_1',
          suspendPayload: { questions: [{ id: 'q1', type: 'text', title: '给谁看？' }] },
        },
      },
      {
        seq: 3,
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolResult,
        toolKey: 'ask-user-questions',
        toolCallId: 'call_1',
        payload: { output: { cancelled: true, answers: [] } },
      },
    ] as never)

    const card = parts.find((part) => part.type === 'data-tool-call-suspended') as
      | { data: { resumed?: boolean; cancelled?: boolean; answers?: unknown[] } }
      | undefined
    expect(card?.data.resumed).toBe(true)
    expect(card?.data.cancelled).toBe(true)
    expect(card?.data.answers).toEqual([])
  })

  it('老数据的整段文本答案也能按题切回来（结构化出参之前的时间线）', () => {
    const parts = toParts([
      call,
      {
        seq: 2,
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolSuspended,
        toolKey: 'ask-user-questions',
        toolCallId: 'call_1',
        payload: {
          runId: 'run_1',
          suspendPayload: {
            questions: [
              { id: 'direction', type: 'single', title: '先深挖哪条路线？' },
              { id: 'resource', type: 'text', title: '你手上更硬的资源是哪类？' },
            ],
          },
        },
      },
      {
        seq: 3,
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolResult,
        toolKey: 'ask-user-questions',
        toolCallId: 'call_1',
        payload: {
          output: '用户已回答：\n1. 先深挖哪条路线？\n   先不选，我要看完整底稿\n2. 你手上更硬的资源是哪类？\n   还在看机会，没团队',
        },
      },
    ] as never)

    const card = parts.find((part) => part.type === 'data-tool-call-suspended') as
      | { data: { answers?: { id: string; value: string | string[] }[] } }
      | undefined
    expect(card?.data.answers).toEqual([
      { id: 'direction', value: '先不选，我要看完整底稿' },
      { id: 'resource', value: '还在看机会，没团队' },
    ])
  })
  it('问答卡留在它自己的位置上（不被挪到结果行）', () => {
    const parts = toParts([
      {
        seq: 1,
        role: TimelineRole.Assistant,
        kind: TimelineKind.Text,
        payload: { text: '先确认两件事' },
      },
      call,
      {
        seq: 3,
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolSuspended,
        toolKey: 'ask-user-questions',
        toolCallId: 'call_1',
        payload: {
          runId: 'run_1',
          suspendPayload: { questions: [{ id: 'q1', type: 'text', title: '给谁看？' }] },
        },
      },
      {
        seq: 4,
        role: TimelineRole.Assistant,
        kind: TimelineKind.Text,
        payload: { text: '收到，继续' },
      },
      {
        seq: 5,
        role: TimelineRole.Assistant,
        kind: TimelineKind.ToolResult,
        toolKey: 'ask-user-questions',
        toolCallId: 'call_1',
        payload: { output: { answers: [{ id: 'q1', value: '长辈' }] } },
      },
    ] as never)

    const types = parts.map((part) => part.type)
    expect(types).toEqual(['text', 'data-tool-call-suspended', 'text'])
  })
})
