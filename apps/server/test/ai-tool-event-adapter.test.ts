import { describe, expect, it } from 'vitest'
import { parseToolEventPart } from '@repo/shared'
import { toMastraTool } from '../src/modules/ai/mastra/tool.adapter.js'
import { buildToolSpecs } from '../src/modules/ai/core/tools/tool.class.js'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolEventDemoTool } from '../src/modules/ai/tools/tool-event-testkit.js'
import { buildToolStackDeps, silentLogger } from './helpers/ai-tool-stack.js'
import { waitFor } from './helpers/tool-events.js'

/**
 * 适配器这条边（设计 §5.17）：AI SDK 把 `writer` 放进工具执行上下文，由 `tool.adapter` 转成
 * `ToolCallInput.writer`（本次不改适配器，这里只是把"事件确实沿着适配器往上走"钉住）。
 *
 * 顺带把**共享契约**（`@repo/shared` 的 `parseToolEventPart`）当裁判：服务端发出去的 part
 * 必须能被前端那个宽容解析器原样解出来 —— 这是"两轨不漂移"的硬证据。
 * 另外验**没有 writer** 的真实路径（非流式调用 / 后台直接调工具）：事件一条都不写，工具照常出结果。
 */
const buildTool = () => {
  const deps = buildToolStackDeps()
  const gateway = new ToolGateway(deps.config, silentLogger as never, [], deps.clock)
  // 与注册机同一条路径：先由装饰器声明拍成 ToolSpec，再交给网关包成可调用工具
  const [spec] = buildToolSpecs(new ToolEventDemoTool())
  return toMastraTool(gateway.wrap(spec), silentLogger as never)
}

/** Mastra 工具的 `execute`（只取我们用到的那一项，避免把它的类型铺进来） */
type ExecutableTool = { execute: (input: unknown, context: unknown) => Promise<unknown> }

describe('适配器：writer 的有无', () => {
  it('有 writer（流式）：事件沿适配器写进父流，且能被共享契约解析出来', async () => {
    const chunks: unknown[] = []
    const tool = buildTool() as unknown as ExecutableTool
    const output = await tool.execute(
      // 引擎注入的必填 reason（设计 §5.18）：走适配器这条边就得带上它
      { keyword: '适配器里的一行', reason: '验证事件沿适配器写进父流' },
      {
        agent: { toolCallId: 'call-adapter' },
        writer: { write: (chunk: unknown) => void chunks.push(chunk) },
      },
    )
    expect(output).toEqual({ echoed: '适配器里的一行' })
    // `emit` 是同步的、写流是异步的（串行队列）：等队列跑完再断言
    await waitFor(() => chunks.length >= 3)

    // ① 共享契约是裁判：每一块都能被前端的宽容解析器解出来
    const parts = chunks.map((chunk) => parseToolEventPart(chunk))
    expect(parts.some((part) => part === null)).toBe(false)
    const parsed = parts.filter((part) => part !== null)
    expect(parsed.map((part) => part.data.event)).toEqual(['progress', 'progress', 'line'])
    expect(parsed.map((part) => part.data.seq)).toEqual([0, 1, 2])
    expect(parsed.every((part) => part.data.toolKey === 'test-event-tool')).toBe(true)

    // ② 状态块带同一个 id（归并成最新快照），流水块不带 id（逐条追加）
    expect(new Set(parsed.slice(0, 2).map((part) => part.id)).size).toBe(1)
    expect(parsed[2].id).toBeUndefined()
    expect(parsed[2].data.mode).toBe('stream')
  })

  it('没有 writer（非流式 / 后台调用）：emit 静默 no-op，出参照常返回', async () => {
    const tool = buildTool() as unknown as ExecutableTool
    const output = await tool.execute(
      { keyword: '没有父流', reason: '验证没有父流时 emit 是安全 no-op' },
      { agent: { toolCallId: 'call-x' } },
    )
    expect(output).toEqual({ echoed: '没有父流' })
  })
})
