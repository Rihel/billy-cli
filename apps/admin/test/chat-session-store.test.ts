import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import {
  ChatSessionStore,
  toMessageState,
} from '../src/app/(app)/(standalone)/main/ai/chat/chat-session.ts'
import { markTransientChunks } from '../src/app/(app)/(standalone)/main/ai/chat/chat-transport.ts'
import type { ChatUnit } from '../src/app/(app)/(standalone)/main/ai/chat/chat-session.ts'

/**
 * 会话渲染状态：**按 part 的 type 增量归约**。
 *
 * 要钉住的就三条：
 * 1. 一条消息的渲染单元数只跟"可见块"有关，跟流有多长无关（子助手增量折叠进正文，不产生单元）；
 * 2. 归约是幂等的 —— 流式 part 原位更新时"从尾部重放一遍"不会重复追加内容；
 * 3. 委派 / 计划 / 问答这几个"同一件事只画一张卡"的去重规则仍然成立。
 */

const message = (parts: unknown[]): UIMessage =>
  ({ id: 'm1', role: 'assistant', parts }) as unknown as UIMessage

const unitsOf = (store: ChatSessionStore): ChatUnit[] =>
  store.getSnapshot().messages[0]?.units ?? []

const textOf = (store: ChatSessionStore): string =>
  unitsOf(store)
    .filter((unit) => unit.kind === 'text')
    .map((unit) => (unit as { text: string }).text)
    .join('')

describe('ChatSessionStore：按 type 归约', () => {
  it('流式文本在原位更新时覆盖同一个单元，不会每帧多出一个块', () => {
    const store = new ChatSessionStore()
    store.sync([message([{ type: 'text', text: '你', state: 'streaming' }])])
    expect(unitsOf(store)).toHaveLength(1)

    store.sync([message([{ type: 'text', text: '你好呀', state: 'streaming' }])])
    expect(unitsOf(store)).toHaveLength(1)
    expect(textOf(store)).toBe('你好呀')
  })

  it('子助手增量折叠进聚合正文：一万块增量仍然只有一个单元', () => {
    const store = new ChatSessionStore()
    const parts: unknown[] = [
      {
        type: 'data-sub-agent',
        id: 'sub1',
        data: { runId: 'sub1', name: '调研', status: 'running' },
      },
    ]
    for (let index = 0; index < 500; index += 1) {
      parts.push({
        type: 'data-sub-agent-delta',
        data: { runId: 'sub1', kind: 'text', text: '字' },
      })
    }
    store.sync([message(parts)])

    const units = unitsOf(store)
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ kind: 'sub-agent', runId: 'sub1' })
    expect((units[0] as { snapshot: { text: string } }).snapshot.text).toHaveLength(500)
  })

  it('尾部重放幂等：同样的 parts 再同步一遍，文本与子助手正文都不会翻倍', () => {
    const store = new ChatSessionStore()
    const parts = [
      { type: 'text', text: '答案', state: 'done' },
      { type: 'data-sub-agent', id: 'sub1', data: { runId: 'sub1', name: '调研' } },
      { type: 'data-sub-agent-delta', data: { runId: 'sub1', kind: 'text', text: '正文' } },
    ]
    store.sync([message(parts)])
    store.sync([message(parts)])

    expect(textOf(store)).toBe('答案')
    const subAgent = unitsOf(store).find((unit) => unit.kind === 'sub-agent')
    expect((subAgent as { snapshot: { text: string } }).snapshot.text).toBe('正文')
  })

  it('委派类工具卡被标记 delegated（同一件事只画一张卡），工具事件仍留在卡上', () => {
    const store = new ChatSessionStore()
    store.sync([
      message([
        {
          type: 'dynamic-tool',
          toolName: 'run-sub-agent',
          toolCallId: 'call_1',
          state: 'output-available',
          input: { task: '调研' },
        },
        {
          type: 'data-sub-agent',
          id: 'sub1',
          data: { runId: 'sub1', toolCallId: 'call_1', name: '调研' },
        },
      ]),
    ])

    const tool = unitsOf(store).find((unit) => unit.kind === 'tool')
    expect(tool).toMatchObject({ kind: 'tool', delegated: true })
    expect(unitsOf(store).some((unit) => unit.kind === 'sub-agent')).toBe(true)
  })

  it('问题工具默认隐藏；报错时露出原始卡', () => {
    const store = new ChatSessionStore()
    store.sync([
      message([
        {
          type: 'dynamic-tool',
          toolName: 'ask-user-questions',
          toolCallId: 'q1',
          state: 'input-available',
        },
      ]),
    ])
    expect(unitsOf(store).find((unit) => unit.kind === 'tool')).toMatchObject({ hidden: true })

    const failed = new ChatSessionStore()
    failed.sync([
      message([
        {
          type: 'dynamic-tool',
          toolName: 'ask-user-questions',
          toolCallId: 'q2',
          state: 'output-error',
          errorText: '炸了',
        },
      ]),
    ])
    expect(unitsOf(failed).find((unit) => unit.kind === 'tool')).toMatchObject({ hidden: false })
  })

  it('工具事件：能对上工具卡的并进卡里，对不上的独立成卡', () => {
    const store = new ChatSessionStore()
    store.sync([
      message([
        {
          type: 'dynamic-tool',
          toolName: 'web-search',
          toolCallId: 'c1',
          state: 'input-available',
        },
        {
          type: 'data-tool-event',
          data: {
            toolKey: 'web-search',
            toolCallId: 'c1',
            event: 'progress',
            eventTitle: '进度',
            mode: 'stream',
            seq: 0,
            payload: { step: 0 },
            agentKey: null,
          },
        },
        {
          type: 'data-tool-event',
          data: {
            toolKey: 'web-search',
            toolCallId: 'c-missing',
            event: 'progress',
            eventTitle: '进度',
            mode: 'stream',
            seq: 1,
            payload: { step: 1 },
            agentKey: null,
          },
        },
      ]),
    ])

    const units = unitsOf(store)
    expect(units.find((unit) => unit.kind === 'tool')).toMatchObject({
      kind: 'tool',
      events: [{ data: { toolCallId: 'c1', event: 'progress', seq: 0 } }],
    })
    expect(units.filter((unit) => unit.kind === 'event')).toHaveLength(1)
  })

  it('问题卡与用量各自成一个单元 / 字段', () => {
    const store = new ChatSessionStore()
    store.sync([
      message([
        {
          type: 'data-tool-call-suspended',
          data: {
            toolCallId: 'q1',
            toolName: 'ask-user-questions',
            suspendPayload: { questions: [] },
          },
        },
        { type: 'data-run-usage', data: { runId: 'r1', usage: { inputTokens: 1 }, stepCount: 2 } },
      ]),
    ])

    expect(unitsOf(store).find((unit) => unit.kind === 'question')).toBeTruthy()
    expect(store.getSnapshot().messages[0]?.usage).toMatchObject({ inputTokens: 1 })
  })

  it('续传重放（parts 变短）时整条重建，不残留旧内容', () => {
    const store = new ChatSessionStore()
    store.sync([
      message([
        { type: 'text', text: '旧内容' },
        { type: 'text', text: '旧尾' },
      ]),
    ])
    store.sync([message([{ type: 'text', text: '重放的第一段' }])])

    expect(textOf(store)).toBe('重放的第一段')
  })

  it('内容没变时同步不换状态对象（行级 memo 才不会每帧失效）', () => {
    const store = new ChatSessionStore()
    const parts = [{ type: 'text', text: '答案', state: 'done' }]
    store.sync([message(parts)])
    const first = store.getSnapshot().messages[0]!
    // 新的 messages 数组 / 新的消息对象，但 parts 内容没变
    store.sync([message(parts)])
    expect(store.getSnapshot().messages[0]).toBe(first)
  })

  it('toMessageState 与 store 归约出同一份单元（右栏历史视图复用同一套映射）', () => {
    const state = toMessageState(message([{ type: 'text', text: '历史正文', state: 'done' }]))
    expect(state.units).toHaveLength(1)
    expect(state.units[0]).toMatchObject({ kind: 'text', text: '历史正文' })
  })
})

describe('ChatSessionStore：实时数据（onData）', () => {
  it('状态块与增量块聚合成一份当前值；新一轮开始时清空', () => {
    vi.useFakeTimers()
    const store = new ChatSessionStore()
    store.applyChunk({
      type: 'data-sub-agent',
      data: { runId: 's1', name: '调研线', status: 'running' },
    })
    store.applyChunk({
      type: 'data-sub-agent-delta',
      data: { runId: 's1', kind: 'reasoning', text: '想' },
    })
    store.applyChunk({
      type: 'data-sub-agent-delta',
      data: { runId: 's1', kind: 'text', text: '正文' },
    })
    vi.advanceTimersByTime(150)

    const live = store.getSnapshot().live[0]!
    expect(live).toMatchObject({
      runId: 's1',
      name: '调研线',
      status: 'running',
      text: '正文',
      reasoning: '想',
    })
    expect(store.hasActiveSubAgent()).toBe(true)

    store.applyChunk({ type: 'data-run', data: { runId: 'r2' } })
    vi.advanceTimersByTime(150)
    expect(store.getSnapshot().live).toHaveLength(0)
    expect(store.hasActiveSubAgent()).toBe(false)
    vi.useRealTimers()
  })
})

describe('消息中间的 part 被改写（答案提交 / 问题卡转只读）', () => {
  it('从第一个引用变了的 part 起重放：中间的挂起块改动同步得到', () => {
    const store = new ChatSessionStore()
    const suspended = {
      type: 'data-tool-call-suspended',
      data: {
        toolCallId: 'call_1',
        runId: 'run_1',
        resumed: false,
        suspendPayload: { questions: [{ id: 'q1', type: 'single', title: '多久了' }] },
      },
    }
    store.sync([
      message([
        { type: 'text', text: '先问几个问题' },
        suspended,
        { type: 'text', text: '然后继续' },
      ]),
    ])
    expect(unitsOf(store).map((unit) => unit.kind)).toEqual(['text', 'question', 'text'])

    // 提交答案：同一位置换成 resumed: true（part 引用变了、parts 长度不变）
    store.sync([
      message([
        { type: 'text', text: '先问几个问题' },
        {
          ...suspended,
          data: { ...suspended.data, resumed: true, answers: [{ id: 'q1', value: '一周内' }] },
        },
        { type: 'text', text: '然后继续' },
      ]),
    ])

    const question = unitsOf(store).find((unit) => unit.kind === 'question') as {
      data: { resumed?: boolean; answers?: unknown }
    }
    expect(question.data.resumed).toBe(true)
    expect(question.data.answers).toEqual([{ id: 'q1', value: '一周内' }])
    // 相邻的两个文本单元不受影响
    expect(textOf(store)).toBe('先问几个问题然后继续')
  })

  it('parts 没变的重复同步不换状态对象（行级 memo 的前提）', () => {
    const store = new ChatSessionStore()
    const parts = [{ type: 'text', text: '答案' }]
    store.sync([message(parts)])
    const before = store.getSnapshot().messages[0]
    store.sync([message(parts)])
    expect(store.getSnapshot().messages[0]).toBe(before)
  })
})

describe('markTransientChunks（逐帧增量不落 part）', () => {
  const collect = async (chunks: unknown[]): Promise<unknown[]> => {
    const input = new ReadableStream<unknown>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    const output = markTransientChunks(input as never)
    const result: unknown[] = []
    const reader = output.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      result.push(value)
    }
    return result
  }

  it('只给子助手增量块打 transient，其余块原样通过', async () => {
    const out = await collect([
      { type: 'data-sub-agent-delta', data: { runId: 's1', text: '字' } },
      { type: 'data-sub-agent', id: 's1', data: { runId: 's1' } },
      { type: 'text-delta', id: 't1', delta: '正文' },
    ])

    expect(out[0]).toMatchObject({ type: 'data-sub-agent-delta', transient: true })
    expect((out[1] as { transient?: boolean }).transient).toBeUndefined()
    expect((out[2] as { transient?: boolean }).transient).toBeUndefined()
  })
})
