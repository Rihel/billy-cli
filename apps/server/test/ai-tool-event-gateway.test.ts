import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { normalizeToolEventDecls } from '../src/modules/ai/core/tools/tool-event.js'
import type { ToolSpec } from '../src/modules/ai/core/tools/tools.types.js'
import { buildToolStackDeps, silentLogger } from './helpers/ai-tool-stack.js'
import { capturingWriter, waitFor, warningLog } from './helpers/tool-events.js'

/**
 * 网关组装 `ctx.emit`（设计 §5.17）：**工具作者只写 `ctx.emit(...)`**。
 *
 * 这里验的是接线本身：网关把 writer / toolCallId / 调用方 agentKey / 声明里的 events
 * 一处组装好交给执行体，纪律（未声明丢弃、payload 校验、写入容错）都在 `tool-event.ts`。
 * 于是工具实现里不出现任何"怎么发、发给谁"的判断。
 */
const deps = () => buildToolStackDeps()

const specOf = (over: Partial<ToolSpec> = {}): ToolSpec =>
  ({
    key: 'emit-demo',
    title: '事件演示',
    description: '用于测试网关注入 emit 的工具声明',
    category: 'core',
    scope: 'all',
    params: z.object({ value: z.string().default('x') }),
    config: z.object({}),
    events: normalizeToolEventDecls(
      [{ name: 'progress', title: '进度', description: '状态快照' }],
      '工具 emit-demo',
    ),
    exec: async () => ({ ok: true }),
    ...over,
  }) as ToolSpec

const envelope = {
  conversationId: 'conv-1',
  parentRunId: 'run-1',
  triggeredBy: 'user-1',
  isAdmin: false,
  depth: 1,
  agentKey: 'sub:统计',
  rootAgentKey: 'assistant',
  model: {},
  childToolbox: new Map(),
  skills: [],
}

describe('网关：ctx.emit 的接线', () => {
  it('执行体可以 emit；part 里带上调用方 agentKey 与 toolCallId', async () => {
    const stack = deps()
    const writer = capturingWriter()
    const outcome = await new ToolGateway(stack.config, silentLogger as never, [], stack.clock).invoke(
      specOf({
        exec: async (_input: unknown, ctx: unknown) => {
          const emit = ctx as { emit: (name: string, payload?: unknown) => void }
          emit.emit('progress', { percent: 30 })
          return 'done'
        },
      }),
      {},
      { callId: 'call-9', envelope, log: silentLogger as never, writer },
    )

    expect(outcome).toEqual({ ok: true, data: 'done' })
    await waitFor(() => writer.chunks.length === 1)
    expect(writer.chunks[0]).toMatchObject({
      type: 'data-tool-event',
      id: 'call-9:progress',
      data: { toolKey: 'emit-demo', toolCallId: 'call-9', event: 'progress', agentKey: 'sub:统计' },
    })
  })

  it('未声明的事件在网关这条链路上同样被丢弃（不会被 writer 收到）', async () => {
    const stack = deps()
    const writer = capturingWriter()
    const log = warningLog()
    await new ToolGateway(stack.config, silentLogger as never, [], stack.clock).invoke(
      specOf({
        exec: async (_input: unknown, ctx: unknown) => {
          const emit = ctx as { emit: (name: string) => void }
          emit.emit('没声明过的名字')
          return 'done'
        },
      }),
      {},
      { callId: 'call-1', envelope: null, log: log as never, writer },
    )
    expect(writer.chunks).toHaveLength(0)
    expect(log.warnings[0]).toMatchObject({ message: 'ai.tool.event_undeclared' })
  })

  it('ctx 上永远有 emit（没声明事件 / 没 writer 都是安全 no-op，执行体不必判空）', async () => {
    const stack = deps()
    let emitType = ''
    await new ToolGateway(stack.config, silentLogger as never, [], stack.clock).invoke(
      specOf({
        events: [],
        exec: async (_input: unknown, ctx: unknown) => {
          emitType = typeof (ctx as { emit: unknown }).emit
          return 'done'
        },
      }),
      {},
      { callId: null, envelope: null, log: silentLogger as never },
    )
    expect(emitType).toBe('function')
  })
})
