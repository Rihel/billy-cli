import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolEventPartData } from '@repo/shared'
import {
  normalizeToolEventDecls,
  createToolEventEmitter,
} from '../src/modules/ai/core/tools/tool-event.js'
import type { ToolEventDecl } from '../src/modules/ai/core/tools/tools.types.js'
import { capturingWriter, waitFor, warningLog } from './helpers/tool-events.js'

/**
 * 事件发射（设计 §5.17）：形状、id 归并、序号、以及"事件失败不影响工具"。
 *
 * 归并策略是在这里钉住的：AI SDK v6 的 data part 是「同 `id` 后者覆盖前者」，
 * 所以 `state` 必须带**稳定 id**、`stream` 必须**不带 id** —— 这条判断在服务端做，
 * 前端才不必自己实现去重。
 */

/** 共享数据结构里的 part 形状（这里只声明断言要读的字段，避免把 shared 的联合类型铺进来） */
interface PartLike {
  type: string
  id?: string
  data: ToolEventPartData
}

const events: readonly ToolEventDecl[] = normalizeToolEventDecls(
  [
    { name: 'progress', title: '进度', description: '状态快照' },
    { name: 'log-line', title: '日志行', description: '流水一行', mode: 'stream' },
    {
      name: 'typed',
      title: '带定义的事件',
      description: 'payload 必须过校验',
      payload: z.object({ percent: z.number().min(0).max(100) }),
    },
  ],
  '工具 T',
)

/** 造一个发射器（默认带 writer；要测"无 writer"就显式传 undefined） */
const emitterOf = (options: {
  writer?: ReturnType<typeof capturingWriter> | undefined
  log?: ReturnType<typeof warningLog>
  toolCallId?: string | null
}) =>
  createToolEventEmitter({
    ...(options.writer ? { writer: options.writer } : {}),
    toolKey: 'test-event-tool',
    // `??` 会把显式传进来的 null 也换成默认值，这里按"有没有给"判断
    toolCallId: 'toolCallId' in options ? (options.toolCallId ?? null) : 'call-1',
    agentKey: 'assistant',
    events,
    log: options.log ?? warningLog(),
  })

describe('事件发射：形状与归并', () => {
  it('state 带稳定 id（`<toolCallId>:<事件名>`）：同一次调用的同一个事件后者覆盖前者', async () => {
    const writer = capturingWriter()
    const emit = emitterOf({ writer })
    emit('progress', { percent: 10 })
    emit('progress', { percent: 60 })
    await waitFor(() => writer.chunks.length === 2)

    const parts = writer.chunks as PartLike[]
    expect(parts[0].type).toBe('data-tool-event')
    expect(parts.every((part) => part.id === 'call-1:progress')).toBe(true)
    expect(parts[1].data.payload).toEqual({ percent: 60 })
  })

  it('stream 不带 id：一块一条，前端按顺序追加', async () => {
    const writer = capturingWriter()
    const emit = emitterOf({ writer })
    emit('log-line', '第一行')
    emit('log-line', '第二行')
    await waitFor(() => writer.chunks.length === 2)

    const parts = writer.chunks as PartLike[]
    expect(parts.every((part) => part.id === undefined)).toBe(true)
    expect(parts.map((part) => part.data.payload)).toEqual(['第一行', '第二行'])
    expect(parts.every((part) => part.data.mode === 'stream')).toBe(true)
  })

  it('seq 从 0 起递增（跨事件名共用一条序号，审计与测试靠它断顺序）', async () => {
    const writer = capturingWriter()
    const emit = emitterOf({ writer })
    emit('progress', { percent: 1 })
    emit('log-line', 'a')
    emit('log-line', 'b')
    await waitFor(() => writer.chunks.length === 3)
    expect((writer.chunks as PartLike[]).map((part) => part.data.seq)).toEqual([0, 1, 2])
  })

  it('part 自带描述字段（toolKey / eventTitle / mode / agentKey）：前端认不出事件也能兜底渲染', async () => {
    const writer = capturingWriter()
    emitterOf({ writer })('progress', { percent: 5 })
    await waitFor(() => writer.chunks.length === 1)
    expect((writer.chunks[0] as PartLike).data).toMatchObject({
      toolKey: 'test-event-tool',
      toolCallId: 'call-1',
      event: 'progress',
      eventTitle: '进度',
      mode: 'state',
      agentKey: 'assistant',
    })
  })

  it('toolCallId 缺失时 id 用工具 key 兜底（后台 / 单测里没有 callId 也不会塌）', async () => {
    const writer = capturingWriter()
    emitterOf({ writer, toolCallId: null })('progress', { percent: 1 })
    await waitFor(() => writer.chunks.length === 1)
    expect((writer.chunks[0] as PartLike).id).toBe('test-event-tool:progress')
  })

  it('没有 payload 的事件：payload 落成 null（定义里 payload 字段永远在）', async () => {
    const writer = capturingWriter()
    emitterOf({ writer })('progress')
    await waitFor(() => writer.chunks.length === 1)
    expect((writer.chunks[0] as PartLike).data.payload).toBeNull()
  })
})

describe('事件发射：丢弃与容错（事件失败不影响工具结果）', () => {
  it('未声明的事件 → 丢弃 + warn（文案含工具 key 与事件名）', () => {
    const writer = capturingWriter()
    const log = warningLog()
    emitterOf({ writer, log })('nope', { anything: true })
    expect(writer.chunks).toHaveLength(0)
    expect(log.warnings).toHaveLength(1)
    expect(log.warnings[0].message).toBe('ai.tool.event_undeclared')
    expect(log.warnings[0].data).toMatchObject({ toolKey: 'test-event-tool', event: 'nope' })
  })

  it('payload 不符合定义 → 丢弃 + warn（列出具体哪个字段错了）', () => {
    const writer = capturingWriter()
    const log = warningLog()
    emitterOf({ writer, log })('typed', { percent: 200 })
    expect(writer.chunks).toHaveLength(0)
    expect(log.warnings[0].message).toBe('ai.tool.event_payload_invalid')
    expect(JSON.stringify(log.warnings[0].data)).toContain('percent')
  })

  it('payload 符合定义 → 发出（安全边界内的取值不被误杀）', async () => {
    const writer = capturingWriter()
    emitterOf({ writer })('typed', { percent: 100 })
    await waitFor(() => writer.chunks.length === 1)
    expect((writer.chunks[0] as PartLike).data.payload).toEqual({ percent: 100 })
  })

  it('写流抛错 / reject → 吞掉 + warn，emit 本身不抛（工具照常返回出参）', async () => {
    const writer = capturingWriter({ failFirst: true })
    const log = warningLog()
    const emit = emitterOf({ writer, log })
    expect(() => emit('log-line', '会失败的一行')).not.toThrow()
    await waitFor(() => log.warnings.length === 1)
    expect(log.warnings[0].message).toBe('ai.tool.event_write_failed')
    expect(writer.chunks).toHaveLength(0)
  })

  it('没有 writer（非流式 / 后台调用）→ 安全 no-op：不写、不 warn', () => {
    const log = warningLog()
    const emit = emitterOf({ writer: undefined, log })
    expect(() => emit('progress', { percent: 1 })).not.toThrow()
    expect(() => emit('undeclared-anyway', {})).not.toThrow()
    expect(log.warnings).toHaveLength(0)
  })

  it('先 emit 的先进流：写流是异步的也不会乱序', async () => {
    const order: number[] = []
    const slowWriter = {
      write: async (chunk: unknown): Promise<unknown> => {
        const data = (chunk as PartLike).data
        await new Promise((resolve) => setTimeout(resolve, data.seq === 0 ? 20 : 1))
        order.push(data.seq)
        return undefined
      },
    }
    const emit = createToolEventEmitter({
      writer: slowWriter,
      toolKey: 'test-event-tool',
      toolCallId: 'call-1',
      agentKey: null,
      events,
      log: warningLog(),
    })
    emit('log-line', 'a')
    emit('log-line', 'b')
    emit('log-line', 'c')
    await waitFor(() => order.length === 3)
    expect(order).toEqual([0, 1, 2])
  })
})
