import { describe, expect, it } from 'vitest'
import type { EngineStreamEvent } from '../src/modules/ai/engine/run-execution.js'
import { RunEventSink } from '../src/modules/ai/engine/run-execution.js'

const collect = async (sink: RunEventSink): Promise<EngineStreamEvent[]> => {
  const events: EngineStreamEvent[] = []
  for await (const event of sink.events) events.push(event)
  return events
}

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

describe('RunEventSink', () => {
  it('把 SSE 帧收成事件流，忽略注释帧（心跳）与结束标记', async () => {
    const sink = new RunEventSink()
    const consuming = collect(sink)
    sink.writeHead(200, {})
    sink.write(': ping\n\n')
    sink.write(frame({ type: 'RUN_STARTED', threadId: 'conv_1', runId: 'run_1' }))
    sink.write(frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '你好' }))
    sink.write(frame({ type: '__run_end__' }))
    sink.end()

    const events = await consuming
    expect(events.map((event) => event.type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      '__run_end__',
    ])
    expect(sink.writableEnded).toBe(true)
  })

  it('一次 write 里多帧也能全部解析；坏帧不打断后面的帧', async () => {
    const sink = new RunEventSink()
    const consuming = collect(sink)
    const good = frame({ type: 'RUN_STARTED', threadId: 'c', runId: 'r' })
    sink.write(
      `${good}data: 不是 JSON\n\n${frame({ type: 'RUN_FINISHED', threadId: 'c', runId: 'r' })}`,
    )
    sink.end()

    const events = await consuming
    expect(events.map((event) => event.type)).toEqual(['RUN_STARTED', 'RUN_FINISHED'])
  })

  it('fail 会把错误传给消费者（建流前失败要走 HTTP，而不是挂住）', async () => {
    const sink = new RunEventSink()
    const consuming = collect(sink)
    const error = new Error('模型不可用')
    sink.fail(error)
    await expect(consuming).rejects.toThrow('模型不可用')
  })
})
