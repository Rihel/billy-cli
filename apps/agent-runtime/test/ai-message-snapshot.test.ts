import { describe, expect, it } from 'vitest'
import { TimelineKind, TimelineRole } from '@repo/shared'
import {
  buildMessageParts,
  snapshotPartsToChunks,
} from '../src/modules/ai/runtime/context/message-snapshot.js'

/**
 * 时间线 → 快照 parts（服务端版本）。
 *
 * 钉住的是**与前端 history.ts 同构**：文本 / 推理 / 工具卡 / 计划 / 子助手卡 / 完成通知，
 * 且工具结果必须补在**同一张卡**上（不能新开一张）。
 */

let seq = 0
const item = (partial: Record<string, unknown>) => {
  seq += 1
  return {
    id: `t${seq}`,
    seq,
    conversationId: 'conv-1',
    runId: 'run-1',
    messageId: 'msg-1',
    attempt: 1,
    role: TimelineRole.Assistant,
    kind: TimelineKind.Text,
    state: null,
    toolKey: null,
    toolCallId: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    usage: null,
    payload: {},
    ...partial,
  } as never
}

describe('buildMessageParts 的 part id', () => {
  it('文本 / 推理行带 id 时映射到 part.id，老行不带', () => {
    const parts = buildMessageParts([
      item({ kind: TimelineKind.Text, payload: { text: '正文', id: 'text-9' } }),
      item({ kind: TimelineKind.Reasoning, payload: { text: '想了想', id: 'reason-9' } }),
      item({ kind: TimelineKind.Text, payload: { text: '老行（没 id）' } }),
    ])

    expect(parts[0]).toEqual({ type: 'text', text: '正文', state: 'done', id: 'text-9' })
    expect(parts[1]).toMatchObject({ type: 'reasoning', text: '想了想', id: 'reason-9' })
    expect(parts[2]).toEqual({ type: 'text', text: '老行（没 id）', state: 'done' })
  })
})

describe('buildMessageParts', () => {
  it('文本 / 推理 / 工具结果补在同一张卡上', () => {
    const parts = buildMessageParts([
      item({ kind: TimelineKind.Text, payload: { text: '先看看' } }),
      item({
        kind: TimelineKind.Reasoning,
        payload: { text: '想一下' },
        durationMs: 1_200,
      }),
      item({
        kind: TimelineKind.ToolCall,
        toolKey: 'bash',
        toolCallId: 'c1',
        payload: { toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } },
      }),
      item({
        kind: TimelineKind.ToolResult,
        toolKey: 'bash',
        toolCallId: 'c1',
        state: 'output-available',
        payload: { output: { ok: true }, isError: false },
      }),
    ])

    expect(parts).toEqual([
      { type: 'text', text: '先看看', state: 'done' },
      { type: 'reasoning', text: '想一下', state: 'done', durationMs: 1_200 },
      {
        type: 'dynamic-tool',
        toolName: 'bash',
        toolCallId: 'c1',
        state: 'output-available',
        input: { command: 'ls' },
        output: { ok: true },
      },
    ])
  })

  it('run-sub-agent 结果 → 子助手卡；计划追加在末尾', () => {
    const parts = buildMessageParts([
      item({
        kind: TimelineKind.ToolCall,
        toolKey: 'run-sub-agent',
        toolCallId: 'c2',
        payload: { input: { name: '调研' } },
      }),
      item({
        kind: TimelineKind.ToolResult,
        toolKey: 'run-sub-agent',
        toolCallId: 'c2',
        state: 'output-available',
        payload: {
          output: { subRunId: 'sub-1', name: '调研', status: 'succeeded', result: '结论' },
        },
      }),
      item({
        kind: TimelineKind.Plan,
        payload: { goal: '目标', tasks: [{ id: 't', title: '一步', status: 'pending' }] },
      }),
    ])

    expect(parts[0]).toMatchObject({ type: 'dynamic-tool', toolName: 'run-sub-agent' })
    expect(parts[1]).toMatchObject({
      type: 'data-sub-agent',
      id: 'sub-1',
      data: { runId: 'sub-1', status: 'succeeded' },
    })
    expect(parts.at(-1)).toMatchObject({ type: 'data-plan', id: expect.stringMatching(/^plan-/) })
  })

  it('挂起卡：同一 toolCallId 有结果时标成 resumed（只读回看）', () => {
    const parts = buildMessageParts([
      item({
        kind: TimelineKind.ToolSuspended,
        toolKey: 'ask-user-questions',
        toolCallId: 'q1',
        payload: { toolCallId: 'q1', suspendPayload: { questions: [] } },
      }),
      item({
        kind: TimelineKind.ToolResult,
        toolKey: 'ask-user-questions',
        toolCallId: 'q1',
        payload: { output: { answers: [{ id: 'a', value: '是' }] } },
      }),
    ])

    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      type: 'data-tool-call-suspended',
      id: 'q1',
      data: { resumed: true, answers: [{ id: 'a', value: '是' }] },
    })
  })
})

describe('snapshotPartsToChunks', () => {
  it('parts → 可重放的 chunk（文本 / 工具 / data-*）', () => {
    const chunks = snapshotPartsToChunks([
      { type: 'text', text: '正文' },
      {
        type: 'dynamic-tool',
        toolName: 'bash',
        toolCallId: 'c1',
        state: 'output-available',
        input: { command: 'ls' },
        output: { ok: true },
      },
      { type: 'data-sub-agent', id: 'sub-1', data: { name: '调研' } },
    ])

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-available',
      'tool-output-available',
      'data-sub-agent',
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'data-sub-agent', id: 'sub-1' })
  })
})
