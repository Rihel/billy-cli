import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TOOL_EVENT_PART_TYPE } from '@repo/shared'
import type { ToolEventPart } from '@repo/shared'
import type { ToolPart } from '@repo/ui/components/ai-elements/tool.tsx'
import { ToolCard, shouldAutoOpen, toolCallReason } from '../src/app/(standalone)/main/ai/chat/tool-card.tsx'

/**
 * 工具卡「要不要自动展开」的判据（纯逻辑，node 环境）+ 受控折叠的接线冒烟。
 *
 * 为什么要单独钉这条规则：事件是**过程**，非受控的 `defaultOpen` 只在挂载那一刻生效，
 * 事件晚到就永远看不见；但自动展开又不能跟用户的手打架 —— 用户自己开合过就必须让位。
 *
 * 点击交互（`onOpenChange` → 自动展开）需要 DOM 渲染测试基建，项目没有、也不为此加依赖，
 * 所以这里钉两件能钉的事：**判据本身**，以及 **`open` 真的接管了折叠**（SSR 下初值即结果）。
 */
describe('shouldAutoOpen', () => {
  it('有事件、用户没动过手 → 自动展开', () => {
    expect(shouldAutoOpen(true, false)).toBe(true)
  })

  it('没有事件 → 不展开（没有过程可看，既有折叠行为不变）', () => {
    expect(shouldAutoOpen(false, false)).toBe(false)
  })

  it('用户自己开合过就彻底让位（事件还在流也不抢）', () => {
    expect(shouldAutoOpen(true, true)).toBe(false)
    expect(shouldAutoOpen(false, true)).toBe(false)
  })
})

/** 一张跑完的工具卡（`open` 决定它的正文在不在 HTML 里） */
const toolPart = {
  type: 'dynamic-tool',
  toolName: 'run-command',
  toolCallId: 'call_1',
  state: 'output-available',
  input: { cmd: 'ls' },
  output: { ok: true },
} as unknown as ToolPart

const eventPart = {
  type: TOOL_EVENT_PART_TYPE,
  data: {
    toolKey: 'run-command',
    toolCallId: 'call_1',
    event: 'phase',
    eventTitle: '当前阶段',
    mode: 'state',
    seq: 0,
    payload: { phase: 'copy' },
    agentKey: null,
  },
} as ToolEventPart

describe('ToolCard 受控折叠', () => {
  it('`open` 初值接管正文：defaultOpen=false 时事件不出现，true 时出现', () => {
    const closed = renderToStaticMarkup(
      createElement(ToolCard, {
        part: toolPart,
        events: [eventPart],
        defaultOpen: false,
        streaming: true,
      }),
    )
    // 收起态连事件正文都不进 DOM —— 这正是"必须受控"的原因：靠 defaultOpen 的话事件到了也开不了
    expect(closed).not.toContain('当前阶段')

    const opened = renderToStaticMarkup(
      createElement(ToolCard, {
        part: toolPart,
        events: [eventPart],
        defaultOpen: true,
        streaming: true,
      }),
    )
    expect(opened).toContain('当前阶段')
    expect(opened).toContain('phase')
    expect(opened).toContain('run-command')
  })
})

/**
 * 卡片上的「为什么」那一行（设计 §5.18）。
 *
 * 判据本身是纯函数，先钉住它的四种边界；再冒烟一遍渲染 —— 入参缺失 / 结构异常时
 * **不能抛**（工具卡是过程视图，缺一行比整页白屏好）。
 */
describe('toolCallReason（为什么用这个工具）', () => {
  it('正常入参：取出并去掉首尾空白', () => {
    expect(toolCallReason({ reason: '  用户要看这台机器的环境  ' })).toBe('用户要看这台机器的环境')
  })

  it('入参还没到 / 结构异常 / 没有 reason → null（调用方不渲染）', () => {
    expect(toolCallReason(undefined)).toBeNull()
    expect(toolCallReason(null)).toBeNull()
    expect(toolCallReason('not-an-object')).toBeNull()
    expect(toolCallReason(['reason'])).toBeNull()
    expect(toolCallReason({ cmd: 'ls' })).toBeNull()
  })

  it('reason 不是字符串 / 空白串 → null（不把半个值画出来）', () => {
    expect(toolCallReason({ reason: 42 })).toBeNull()
    expect(toolCallReason({ reason: '   ' })).toBeNull()
    expect(toolCallReason({ reason: '' })).toBeNull()
  })

  it('渲染：展开时有一行"为什么"，没有 reason 时这一行不出现且不抛', () => {
    const withReason = renderToStaticMarkup(
      createElement(ToolCard, {
        part: { ...toolPart, input: { cmd: 'ls', reason: '用户要看这台机器的环境' } } as ToolPart,
        events: [],
        defaultOpen: true,
        streaming: false,
      }),
    )
    expect(withReason).toContain('为什么：')
    expect(withReason).toContain('用户要看这台机器的环境')

    const withoutReason = renderToStaticMarkup(
      createElement(ToolCard, {
        part: { ...toolPart, input: { cmd: 'ls' } } as ToolPart,
        events: [],
        defaultOpen: true,
        streaming: false,
      }),
    )
    expect(withoutReason).not.toContain('为什么：')
  })
})

describe('工具条上的耗时（用户要求）', () => {
  it('给了历史耗时（服务端审计量的）→ 显示在标题行', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        part: { ...toolPart, state: 'output-available' } as ToolPart,
        events: [],
        defaultOpen: false,
        streaming: false,
        durationMs: 1234,
      }),
    )

    expect(html).toContain('1.2s')
  })

  it('没有耗时（实时流的收尾那一刻 / 老数据）→ 不显示假数字', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        part: { ...toolPart, state: 'output-available' } as ToolPart,
        events: [],
        defaultOpen: false,
        streaming: false,
      }),
    )

    // 不可知时不硬编一个数字出来（按"数字 + 单位"精确判，别拿子串 `ms` 误判 —— HTML 里到处是它）
    expect(html).not.toMatch(/\d+(\.\d+)?(ms|s)</)
  })
})
