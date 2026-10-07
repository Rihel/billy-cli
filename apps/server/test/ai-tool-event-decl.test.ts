import { describe, expect, it } from 'vitest'
import { buildToolSpecs } from '../src/modules/ai/core/tools/tool.class.js'
import { normalizeToolEventDecls } from '../src/modules/ai/core/tools/tool-event.js'
import { specByKey } from './helpers/ai-tool-stack.js'
import {
  DuplicateEventTool,
  EventDeclTool,
  NoEventTool,
  ProgressPayload,
} from '../src/modules/ai/tools/tool-event-testkit.js'
import type { ToolEventDeclMeta } from '../src/modules/ai/core/tools/tools.types.js'

/**
 * 事件声明（设计 §5.17）：**启动期**校验 + payload 定义 → JSON Schema 镜像。
 *
 * 这一份测的是"声明写错就起不来"：事件名组内唯一、标题 / 说明非空、mode 合法、
 * payload 定义能转出 JSON Schema（管理页只读展示用）。
 */
describe('事件声明：normalizeToolEventDecls', () => {
  it('mode 省略 = state；给了 stream 就用 stream', () => {
    const decls = normalizeToolEventDecls(
      [
        { name: 'a', title: 'A', description: '省略 mode' },
        { name: 'b', title: 'B', description: '显式 stream', mode: 'stream' },
      ],
      '测试工具',
    )
    expect(decls.map((decl) => decl.mode)).toEqual(['state', 'stream'])
  })

  it('payload 定义生成 JSON Schema；没写 payload 时为 null', () => {
    const [withPayload, without] = normalizeToolEventDecls(
      [
        { name: 'a', title: 'A', description: '带定义', payload: ProgressPayload },
        { name: 'b', title: 'B', description: '不带定义' },
      ],
      '测试工具',
    )
    expect(withPayload.payloadSchema).toMatchObject({
      type: 'object',
      required: ['percent'],
      properties: { percent: { type: 'number', minimum: 0, maximum: 100 } },
    })
    expect(without.payloadSchema).toBeNull()
    // 运行时校验用的仍是 zod 本体（不走 JSON Schema）
    expect(withPayload.payload?.safeParse({ percent: 50 }).success).toBe(true)
  })

  it('没声明事件 = 空数组（不是 undefined）', () => {
    expect(normalizeToolEventDecls(undefined, '测试工具')).toEqual([])
    expect(normalizeToolEventDecls([], '测试工具')).toEqual([])
  })

  it('事件名重复 → 启动失败，文案能定位到工具与事件名', () => {
    expect(() =>
      normalizeToolEventDecls(
        [
          { name: 'dup', title: 'A', description: '第一次' },
          { name: 'dup', title: 'B', description: '第二次' },
        ],
        '工具组 EventDeclTool.run（test-event-decl）',
      ),
    ).toThrowError(/test-event-decl.*事件名重复：dup/)
  })

  it('空 title / 空 description → 启动失败', () => {
    expect(() =>
      normalizeToolEventDecls([{ name: 'a', title: '   ', description: 'x' }], '工具 T'),
    ).toThrowError(/事件 a 缺少标题 title/)
    expect(() =>
      normalizeToolEventDecls([{ name: 'a', title: 'A', description: '' }], '工具 T'),
    ).toThrowError(/事件 a 缺少说明 description/)
  })

  it('缺少事件名 → 启动失败（文案指到第几条声明）', () => {
    const bad = [{ title: 'A', description: 'x' }] as unknown as ToolEventDeclMeta[]
    expect(() => normalizeToolEventDecls(bad, '工具 T')).toThrowError(/第 1 个事件声明 缺少事件名 name/)
  })

  it('事件名超过 64 字符 → 启动失败', () => {
    expect(() =>
      normalizeToolEventDecls([{ name: 'x'.repeat(65), title: 'A', description: 'x' }], '工具 T'),
    ).toThrowError(/事件名过长（最长 64）/)
  })

  it('mode 不合法 → 启动失败', () => {
    const bad = [{ name: 'a', title: 'A', description: 'x', mode: 'delta' }] as unknown as ToolEventDeclMeta[]
    expect(() => normalizeToolEventDecls(bad, '工具 T')).toThrowError(/mode 不合法：delta/)
  })
})

describe('事件声明：经 buildToolSpecs 落到 ToolSpec', () => {
  it('组里的工具带上归一化后的 events（含 JSON Schema 镜像）', () => {
    const spec = specByKey(new EventDeclTool(), 'test-event-decl')
    expect(spec.events.map((decl) => [decl.name, decl.mode])).toEqual([
      ['progress', 'state'],
      ['log-line', 'stream'],
      ['stage', 'state'],
    ])
    expect(spec.events[0].payloadSchema).toMatchObject({ type: 'object' })
    expect(spec.events[1].payloadSchema).toBeNull()
  })

  it('没声明事件的工具：events 是空数组（数据结构字段永远在，读侧不必判 undefined）', () => {
    expect(buildToolSpecs(new NoEventTool())[0].events).toEqual([])
  })

  it('事件声明违规 = 工具组构建失败（启动期报错，不是运行时静默失效）', () => {
    expect(() => buildToolSpecs(new DuplicateEventTool())).toThrowError(/test-bad-event.*事件名重复：dup/)
  })
})
