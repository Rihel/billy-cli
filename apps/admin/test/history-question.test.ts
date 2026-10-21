import { TimelineKind, TimelineRole } from '@repo/shared'
import { describe, expect, it } from 'vitest'
import { toParts } from '../src/app/(standalone)/main/ai/chat/history'

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
      | { data: { resumed?: boolean } }
      | undefined
    expect(card?.data.resumed).toBe(true)
  })
})
