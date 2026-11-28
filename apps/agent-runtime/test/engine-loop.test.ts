import { describe, expect, it } from 'vitest'
import { MastraAgentLoop } from '../src/modules/ai/engine/adapters/loop.adapter.js'
import type { ModelClient, ModelEvent } from '../src/modules/ai/engine/model-client.js'
import type { Toolbox } from '../src/modules/ai/tools/engine/tools.types.js'
import type { EngineEvent } from '../src/modules/ai/engine/protocol.js'

const collect = async (events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> => {
  const list: EngineEvent[] = []
  for await (const event of events) list.push(event)
  return list
}

const textOf = (events: EngineEvent[]): string =>
  events
    .filter((event) => event.type === 'TEXT_MESSAGE_CONTENT')
    .map((event) => String((event as { delta?: unknown }).delta ?? ''))
    .join('')

const makeModel = (rounds: ModelEvent[][]): ModelClient => {
  let index = 0
  return {
    ref: 'test/model',
    contextWindow: 32_000,
    stream: async function* (): AsyncIterable<ModelEvent> {
      const round = rounds[index] ?? []
      index += 1
      for (const event of round) yield event
    },
  }
}

const makeTools = (): Toolbox =>
  new Map([
    [
      'read-file',
      {
        key: 'read-file',
        spec: { key: 'read-file', description: '读文件' },
        run: async () => ({ ok: true as const, data: { content: '文件内容' } }),
      } as never,
    ],
  ])

const baseInput = () => ({
  conversationId: 'conv_1',
  runId: 'run_1',
  taskId: 'task_1',
  messages: [{ role: 'user' as const, content: '读一下 a.txt' }],
  limits: { maxSteps: 4 },
  signal: new AbortController().signal,
})

describe('薄 AgentLoop（MastraAgentLoop）', () => {
  it('调模型 → 执行工具 → 再调模型，产出 AG-UI 事件并收敛正文', async () => {
    const model = makeModel([
      [
        { type: 'text', delta: '先读文件' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'read-file',
          input: { path: 'a.txt' },
        },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [
        { type: 'text', delta: '，读到了。' },
        { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
        { type: 'finish', reason: 'stop' },
      ],
    ])
    const loop = new MastraAgentLoop()
    const run = await loop.start({ ...baseInput(), model, tools: makeTools() })

    const events = await collect(run.events)
    const types = events.map((event) => event.type)
    expect(types).toContain('RUN_STARTED')
    expect(types).toContain('TOOL_CALL_START')
    expect(types).toContain('TOOL_CALL_RESULT')
    expect(types.at(-1)).toBe('RUN_FINISHED')
    expect(textOf(events)).toBe('先读文件，读到了。')

    const result = await run.result
    expect(result.status).toBe('succeeded')
    expect(result.stopReason).toBe('done')
    expect(result.text).toBe('先读文件，读到了。')
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    expect(result.steps).toHaveLength(2)
    expect(result.steps.map((step) => step.finishReason)).toEqual(['tool-calls', 'stop'])
  })

  it('未知工具作为工具失败结果回给模型，不炸整轮', async () => {
    const model = makeModel([
      [
        { type: 'tool-call', toolCallId: 'call_x', toolName: 'not-exist', input: {} },
        { type: 'finish', reason: 'tool-calls' },
      ],
      [
        { type: 'text', delta: '换了个办法' },
        { type: 'finish', reason: 'stop' },
      ],
    ])
    const loop = new MastraAgentLoop()
    const run = await loop.start({ ...baseInput(), model, tools: makeTools() })
    const events = await collect(run.events)
    const toolError = events.find((event) => event.type === 'TOOL_CALL_RESULT')
    expect(JSON.stringify(toolError)).toContain('未知工具')
    expect((await run.result).status).toBe('succeeded')
  })

  it('达到步数上限时停止原因是 max_steps（不无限循环）', async () => {
    // 每轮都要求调工具，才会进入下一轮；maxSteps=1 时第二轮被上限拦下
    const round = [
      { type: 'tool-call' as const, toolCallId: 'call_1', toolName: 'read-file', input: {} },
      { type: 'finish' as const, reason: 'tool-calls' },
    ]
    const model = makeModel([round, round, round])
    const loop = new MastraAgentLoop()
    const run = await loop.start({
      ...baseInput(),
      model,
      tools: makeTools(),
      limits: { maxSteps: 1 },
    })
    await collect(run.events)
    const result = await run.result
    expect(result.stopReason).toBe('max_steps')
  })

  it('resume 不做假续跑：薄 loop 没有 durable 快照，直接报不可恢复', async () => {
    const loop = new MastraAgentLoop()
    await expect(loop.resume({ ...baseInput(), model: makeModel([]) })).rejects.toMatchObject({
      code: 'run_not_resumable',
    })
  })
})
