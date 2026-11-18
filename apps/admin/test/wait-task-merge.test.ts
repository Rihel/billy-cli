import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { ChatUnit } from '../src/app/(app)/(standalone)/main/ai/chat/chat-session.ts'
import { toMessageState } from '../src/app/(app)/(standalone)/main/ai/chat/chat-session.ts'

const waitTask = (toolCallId: string, taskId: string, index: number) =>
  ({
    type: 'dynamic-tool',
    toolName: 'wait-task',
    toolCallId,
    state: 'output-available',
    input: { taskId },
    output: { taskId, state: 'running', attempt: index },
  }) as const

const message = (parts: unknown[]): UIMessage =>
  ({ id: 'm-1', role: 'assistant', parts }) as unknown as UIMessage

const toolUnits = (units: ChatUnit[]) => units.filter((unit) => unit.kind === 'tool')

describe('wait-task 时间线合并（协议 §10.2）', () => {
  it('同一 taskId 的多次轮询只留一张卡，显示最后一次快照', () => {
    const state = toMessageState(
      message([
        waitTask('call-1', 'task-1', 1),
        waitTask('call-2', 'task-1', 2),
        waitTask('call-3', 'task-1', 3),
      ]),
    )
    const tools = toolUnits(state.units)
    expect(tools).toHaveLength(1)
    const unit = tools[0]!
    expect(unit.kind === 'tool' && unit.key).toBe('wait-task-task-1')
    expect(unit.kind === 'tool' && unit.part.toolCallId).toBe('call-3')
    expect(unit.kind === 'tool' && unit.part.output).toMatchObject({ attempt: 3 })
  })

  it('不同 taskId 各留一张卡（不误合并）', () => {
    const state = toMessageState(
      message([waitTask('call-1', 'task-1', 1), waitTask('call-2', 'task-2', 1)]),
    )
    expect(toolUnits(state.units)).toHaveLength(2)
  })

  it('其它工具不参与合并（保留原 key）', () => {
    const state = toMessageState(
      message([
        {
          type: 'dynamic-tool',
          toolName: 'bash',
          toolCallId: 'call-b',
          state: 'output-available',
          input: { command: 'ls' },
          output: { ok: true },
        },
      ]),
    )
    const tools = toolUnits(state.units)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.kind === 'tool' && tools[0]!.key).toBe('tool-call-b')
  })

  it('同一轮里先流式输入（无 taskId）再补上 taskId：占位卡被摘掉，只剩合并卡', () => {
    const state = toMessageState(
      message([
        {
          type: 'dynamic-tool',
          toolName: 'wait-task',
          toolCallId: 'call-1',
          state: 'input-streaming',
          input: undefined,
        },
        waitTask('call-1', 'task-1', 1),
      ]),
    )
    const tools = toolUnits(state.units)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.kind === 'tool' && tools[0]!.key).toBe('wait-task-task-1')
  })
})
