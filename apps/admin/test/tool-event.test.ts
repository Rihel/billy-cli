import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { TOOL_EVENT_PART_TYPE } from '@repo/shared'
import type { ToolEventPart, ToolEventPartData } from '@repo/shared'
import {
  TOOL_EVENT_ANY,
  ToolEventCard,
  ToolEventsBody,
  eventTitleOf,
  flatPayloadEntries,
  groupToolEventParts,
  groupToolEventsByToolCall,
  payloadSummary,
  pickToolEventRenderer,
  registerToolEventRenderer,
  resetToolEventRenderers,
} from '../src/app/(standalone)/main/ai/chat/tool-event.tsx'

/**
 * 工具自定义事件：分桶（并进工具卡 / 无主独立成卡）+ 兜底渲染 + 渲染器优先级。
 *
 * 三条用户可见的行为要钉住：
 * 1. **认得出的事件不许丢**：`parseToolEventPart` 认不出才算"未知 part"，认得出的必须在场；
 * 2. **无主事件不许消失**：子 agent 内部工具发的 `toolCallId` 在父消息里没有对应卡，必须独立成卡；
 * 3. **没注册渲染器也要看得见**：兜底渲染给标题 + 事件名徽标 + 折叠 JSON。
 *
 * 注册表是模块级单例（注册发生在模块加载期，这是对的），所以每个用例前清空一次 ——
 * 否则"有没有注册过"会跨用例污染，用例就只能靠书写顺序保平安（一插就坏）。
 */
beforeEach(resetToolEventRenderers)

const baseData = (
  data: Partial<ToolEventPartData> & Pick<ToolEventPartData, 'event'>,
): ToolEventPartData => ({
  toolKey: 'list-todos',
  toolCallId: 'call_1',
  eventTitle: '事件标题',
  mode: 'state',
  seq: 0,
  payload: null,
  agentKey: null,
  ...data,
})

/** 线上形态的原始 part（喂给分桶函数） */
const rawEvent = (data: Partial<ToolEventPartData> & Pick<ToolEventPartData, 'event'>) => ({
  type: TOOL_EVENT_PART_TYPE,
  data: baseData(data),
})

/** 已解析的事件（喂给渲染组件） */
const eventPart = (data: Partial<ToolEventPartData> & Pick<ToolEventPartData, 'event'>) =>
  rawEvent(data) as ToolEventPart

/** 一张工具卡（分桶时用来占住 toolCallId） */
const toolCard = (toolCallId: string) => ({ type: 'dynamic-tool', toolCallId })

describe('groupToolEventsByToolCall', () => {
  it('toolCallId 命中工具卡：按调用归组，同一次调用的多个事件保持 parts 顺序', () => {
    const grouping = groupToolEventsByToolCall([
      toolCard('call_1'),
      rawEvent({ event: 'first', seq: 1 }),
      rawEvent({ event: 'second', seq: 2 }),
    ])

    expect(grouping.byToolCallId.get('call_1')?.map((event) => event.data.event)).toEqual([
      'first',
      'second',
    ])
    expect([...grouping.byIndex.keys()]).toEqual([1, 2])
  })

  it('toolCallId 为 null：不进任何桶（留给调用方独立成卡）', () => {
    const grouping = groupToolEventsByToolCall([
      toolCard('call_1'),
      rawEvent({ event: 'no-owner', toolCallId: null }),
    ])

    expect(grouping.byIndex.size).toBe(1)
    expect(grouping.byToolCallId.size).toBe(0)
    expect(grouping.byIndex.get(1)?.data.toolCallId).toBeNull()
  })

  it('toolCallId 指向不存在的工具卡（子 agent 内部工具发的）：同样不归组', () => {
    const grouping = groupToolEventsByToolCall([
      toolCard('call_1'),
      rawEvent({ event: 'inner', toolCallId: 'call_child' }),
    ])

    expect(grouping.byToolCallId.size).toBe(0)
    expect(grouping.byIndex.get(1)?.data.toolCallId).toBe('call_child')
  })

  it('事件 part 自带的 toolCallId 不会被当成"工具卡真的存在"', () => {
    const grouping = groupToolEventsByToolCall([
      rawEvent({ event: 'self', toolCallId: 'call_9' }),
    ])

    expect(grouping.byToolCallId.size).toBe(0)
  })

  it('未知事件名照样归组：分桶只认协议，不认识事件名是渲染器的事', () => {
    const grouping = groupToolEventsByToolCall([
      toolCard('call_1'),
      rawEvent({ event: '还没注册渲染器的事件' }),
    ])

    expect(grouping.byToolCallId.get('call_1')?.[0].data.event).toBe('还没注册渲染器的事件')
  })

  it('解析不出的同类 part 不进桶（调用方按"未知 part"露徽标）', () => {
    const grouping = groupToolEventsByToolCall([
      toolCard('call_1'),
      { type: TOOL_EVENT_PART_TYPE, data: { event: '缺字段' } },
      { type: TOOL_EVENT_PART_TYPE, data: null },
    ])

    expect(grouping.byIndex.size).toBe(0)
    expect(grouping.byToolCallId.size).toBe(0)
  })
})

describe('groupToolEventParts（视觉分组：stream = 一条流水线，state = 一个时间点）', () => {
  /** 只取分组形状，断言更可读（`parts` 原文另在"顺序"用例里钉） */
  const shape = (parts: ToolEventPart[]) =>
    groupToolEventParts(parts).map((group) => ({
      events: group.events,
      mode: group.mode,
      count: group.parts.length,
    }))

  it('连续同名流水合成一组（三行 stdout = 一块，不是三块）', () => {
    const parts = ['第一行', '第二行', '第三行'].map((text, seq) =>
      eventPart({ event: 'stdout', mode: 'stream', seq, payload: { text } }),
    )

    expect(shape(parts)).toEqual([{ events: ['stdout'], mode: 'stream', count: 3 }])
  })

  it('事件名不同也合并：stdout,stderr,stdout = 一组（真实命令天然交错，不能交错几行就几个盒子）', () => {
    const parts = [
      eventPart({ event: 'stdout', mode: 'stream', seq: 0 }),
      eventPart({ event: 'stderr', mode: 'stream', seq: 1 }),
      eventPart({ event: 'stdout', mode: 'stream', seq: 2 }),
    ]

    expect(shape(parts)).toEqual([
      { events: ['stdout', 'stderr'], mode: 'stream', count: 3 },
    ])
  })

  it('events 按首次出现顺序去重：stdout,stderr,stdout,stderr 仍只有两个事件名', () => {
    const parts = [
      eventPart({ event: 'stdout', mode: 'stream', seq: 0 }),
      eventPart({ event: 'stderr', mode: 'stream', seq: 1 }),
      eventPart({ event: 'stdout', mode: 'stream', seq: 2 }),
      eventPart({ event: 'stderr', mode: 'stream', seq: 3 }),
    ]

    expect(groupToolEventParts(parts)[0]?.events).toEqual(['stdout', 'stderr'])
  })

  it('state 块把流水切开（快照要出现在它到达的位置上）', () => {
    const parts = [
      eventPart({ event: 'stdout', mode: 'stream', seq: 0 }),
      eventPart({ event: 'stderr', mode: 'stream', seq: 1 }),
      eventPart({ event: 'exit', mode: 'state', seq: 2 }),
      eventPart({ event: 'stdout', mode: 'stream', seq: 3 }),
    ]

    expect(shape(parts)).toEqual([
      { events: ['stdout', 'stderr'], mode: 'stream', count: 2 },
      { events: ['exit'], mode: 'state', count: 1 },
      { events: ['stdout'], mode: 'stream', count: 1 },
    ])
  })

  it('state 单块自成一组，不参与任何合并（相邻同名也不并）', () => {
    const parts = [
      eventPart({ event: 'exit', mode: 'state', seq: 0 }),
      eventPart({ event: 'exit', mode: 'state', seq: 1 }),
    ]

    expect(shape(parts)).toEqual([
      { events: ['exit'], mode: 'state', count: 1 },
      { events: ['exit'], mode: 'state', count: 1 },
    ])
  })

  it('单块流水也是一组（组 = 一段可连续阅读的输出，不按块数区分形态）', () => {
    expect(shape([eventPart({ event: 'stdout', mode: 'stream', seq: 0 })])).toEqual([
      { events: ['stdout'], mode: 'stream', count: 1 },
    ])
  })

  it('绝不重排：把各组摊平回来仍是入参原顺序', () => {
    const parts = [
      eventPart({ event: 'stdout', mode: 'stream', seq: 0 }),
      eventPart({ event: 'stderr', mode: 'stream', seq: 1 }),
      eventPart({ event: 'exit', mode: 'state', seq: 2 }),
      eventPart({ event: 'stdout', mode: 'stream', seq: 3 }),
      eventPart({ event: 'stdout', mode: 'stream', seq: 4 }),
    ]

    expect(groupToolEventParts(parts).flatMap((group) => group.parts)).toEqual(parts)
  })

  it('空输入给空分组', () => {
    expect(groupToolEventParts([])).toEqual([])
  })
})

describe('兜底渲染的取值', () => {
  it('eventTitleOf：优先服务端自带的标题，缺失时退回事件名', () => {
    expect(eventTitleOf(eventPart({ event: 'progress', eventTitle: '进度更新' }))).toBe('进度更新')
    expect(eventTitleOf(eventPart({ event: 'progress', eventTitle: '' }))).toBe('progress')
  })

  it('flatPayloadEntries：平面对象出键值对，嵌套 / 数组 / 标量 / 空对象一律 null', () => {
    expect(flatPayloadEntries({ done: 3, total: 5, label: '取数' })).toEqual([
      ['done', '3'],
      ['total', '5'],
      ['label', '取数'],
    ])
    expect(flatPayloadEntries({ nested: { a: 1 } })).toBeNull()
    expect(flatPayloadEntries([1, 2])).toBeNull()
    expect(flatPayloadEntries('文本')).toBeNull()
    expect(flatPayloadEntries({})).toBeNull()
  })

  it('payloadSummary：标量给文本，结构化退成 JSON，undefined 给"无负载"', () => {
    expect(payloadSummary('一行日志')).toBe('一行日志')
    expect(payloadSummary(7)).toBe('7')
    expect(payloadSummary(undefined)).toBe('（无负载）')
    expect(payloadSummary({ a: 1 })).toBe('{"a":1}')
  })
})

describe('内置兜底渲染（一个渲染器都没注册）', () => {
  it('state：标题 + 事件名徽标 + mode + 快照键值，且 JSON 随手可查', () => {
    const html = renderToStaticMarkup(
      createElement(ToolEventCard, {
        part: eventPart({
          event: 'fetch-progress',
          eventTitle: '取数进度',
          payload: { done: 3, total: 5 },
        }),
      }),
    )

    expect(html).toContain('取数进度')
    expect(html).toContain('fetch-progress')
    expect(html).toContain('状态快照')
    expect(html).toContain('done')
    expect(html).toContain('3')
    expect(html).toContain('展开 JSON')
  })

  it('stream：一行一条，带真实 seq（不伪造时间）+ 折叠 JSON', () => {
    const html = renderToStaticMarkup(
      createElement(ToolEventCard, {
        part: eventPart({
          event: 'log',
          eventTitle: '日志行',
          mode: 'stream',
          seq: 4,
          payload: { line: 'hello' },
        }),
      }),
    )

    expect(html).toContain('#4')
    expect(html).toContain('流水追加')
    expect(html).toContain('展开 JSON')
  })

  it('ToolEventsBody：并进工具卡的事件按顺序铺开；没有事件时什么都不画', () => {
    const html = renderToStaticMarkup(
      createElement(ToolEventsBody, {
        toolKey: 'list-todos',
        parts: [
          eventPart({ event: 'p1', eventTitle: '第一步', seq: 0, payload: { done: 1 } }),
          eventPart({ event: 'p2', eventTitle: '第二步', seq: 1, payload: { done: 2 } }),
        ],
      }),
    )

    expect(html).toContain('第一步')
    expect(html).toContain('第二步')
    expect(html.indexOf('第一步')).toBeLessThan(html.indexOf('第二步'))
    expect(renderToStaticMarkup(createElement(ToolEventsBody, { toolKey: 'x', parts: [] }))).toBe('')
  })
})

describe('ToolEventsBody 按视觉块渲染（连续流水合成一块容器）', () => {
  const countOf = (text: string, needle: string): number => text.split(needle).length - 1

  const streamPart = (line: string, seq: number) =>
    eventPart({ event: 'log', eventTitle: '日志行', mode: 'stream', seq, payload: { line } })

  it('三条连续同名流水：组头与行数只出现一次，三行按序在同一容器里（兜底渲染器也适用）', () => {
    const html = renderToStaticMarkup(
      createElement(ToolEventsBody, {
        toolKey: 'list-todos',
        parts: [streamPart('alpha', 0), streamPart('beta', 1), streamPart('gamma', 2)],
      }),
    )

    expect(countOf(html, '日志行')).toBe(1)
    expect(countOf(html, '3 行')).toBe(1)
    expect(countOf(html, 'rounded-md bg-muted/40')).toBe(1)
    expect(html.indexOf('alpha')).toBeLessThan(html.indexOf('beta'))
    expect(html.indexOf('beta')).toBeLessThan(html.indexOf('gamma'))
    // 兜底渲染的每行仍带真实 seq（不伪造时间）
    expect(html).toContain('#0')
    expect(html).toContain('#2')
  })

  it('相邻的不同事件名也合并成一块，头部把事件名逐个列全', () => {
    const html = renderToStaticMarkup(
      createElement(ToolEventsBody, {
        toolKey: 'list-todos',
        parts: [
          streamPart('alpha', 0),
          eventPart({ event: 'warn', eventTitle: '警示行', mode: 'stream', seq: 1, payload: { line: 'beta' } }),
        ],
      }),
    )

    expect(countOf(html, 'rounded-md bg-muted/40')).toBe(1)
    expect(countOf(html, '2 行')).toBe(1)
    // 两个事件名徽标都在，且不重复
    expect(countOf(html, 'log')).toBe(1)
    expect(countOf(html, 'warn')).toBe(1)
    // 标题取首块（`日志行`），第二块自己的标题不再重复出现
    expect(countOf(html, '日志行')).toBe(1)
    expect(countOf(html, '警示行')).toBe(0)
  })

  it('状态块自成容器：流水与快照不会挤在同一块里', () => {
    const html = renderToStaticMarkup(
      createElement(ToolEventsBody, {
        toolKey: 'list-todos',
        parts: [
          streamPart('alpha', 0),
          eventPart({ event: 'exit', eventTitle: '结论', mode: 'state', seq: 1, payload: { done: 1 } }),
        ],
      }),
    )

    expect(countOf(html, 'rounded-md bg-muted/40')).toBe(2)
    expect(html.indexOf('alpha')).toBeLessThan(html.indexOf('结论'))
  })
})

describe('pickToolEventRenderer 优先级（精确 > 工具通配 > 全局精确 > 全局通配）', () => {
  it('四级依次命中；一级都没命中才交给内置兜底', () => {
    expect(pickToolEventRenderer('从未注册的工具', '从未注册的事件')).toBeUndefined()

    const exact = () => createElement('span', null, '精确')
    const toolAny = () => createElement('span', null, '工具通配')
    const globalExact = () => createElement('span', null, '全局精确')
    const globalAny = () => createElement('span', null, '全局通配')
    registerToolEventRenderer('t1', 'e1', exact)
    registerToolEventRenderer('t1', TOOL_EVENT_ANY, toolAny)
    registerToolEventRenderer(TOOL_EVENT_ANY, 'e1', globalExact)
    registerToolEventRenderer(TOOL_EVENT_ANY, TOOL_EVENT_ANY, globalAny)

    expect(pickToolEventRenderer('t1', 'e1')).toBe(exact)
    expect(pickToolEventRenderer('t1', 'e2')).toBe(toolAny)
    expect(pickToolEventRenderer('t2', 'e1')).toBe(globalExact)
    expect(pickToolEventRenderer('t2', 'e2')).toBe(globalAny)
  })
})

describe('注册的自定义渲染器', () => {
  it('精确注册的渲染器接管正文，头部仍是统一的标题 + 事件名 + mode', () => {
    registerToolEventRenderer('list-todos', 'custom', ({ payload }) =>
      createElement('span', null, `自定义正文 ${(payload as { value?: string }).value ?? ''}`),
    )

    const html = renderToStaticMarkup(
      createElement(ToolEventsBody, {
        toolKey: 'list-todos',
        parts: [
          eventPart({ event: 'custom', eventTitle: '自定义事件', payload: { value: '来了' } }),
        ],
      }),
    )

    expect(html).toContain('自定义正文 来了')
    expect(html).toContain('自定义事件')
    expect(html).toContain('custom')
  })

  it('事件自带的 toolKey 优先于卡片传入的 toolKey（渲染器按发事件的工具匹配）', () => {
    registerToolEventRenderer('list-todos', 'progress', () => createElement('span', null, '按事件的工具匹配'))

    const html = renderToStaticMarkup(
      createElement(ToolEventsBody, {
        toolKey: '别的工具',
        parts: [eventPart({ event: 'progress', toolKey: 'list-todos' })],
      }),
    )

    expect(html).toContain('按事件的工具匹配')
  })
})
