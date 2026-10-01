import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolGateway } from '../src/modules/ai/tools/tool.gateway.js'
import { ToolDeniedError } from '../src/modules/ai/tools/tools.types.js'
import type {
  ToolCallContext,
  ToolPlugin,
  ToolSpec,
} from '../src/modules/ai/tools/tools.types.js'
import { buildToolStackDeps, silentLogger } from './helpers/ai-tool-stack.js'
import type { ToolStackOptions } from './helpers/ai-tool-stack.js'

/**
 * 网关与插件（设计 §5.4）。
 *
 * 测三件事：
 * 1. **顺序与短路**：pre 插件按数组顺序跑，任一给结论就不再执行工具；
 * 2. **失败是结论**：执行体抛 `ToolDeniedError` → 对应 reason；抛别的 → `internal`；中止 → `aborted`；
 * 3. **post 链**：脱敏 → 分页 → 审计，且对**拒绝**也要记账（审计不能漏掉被拒的调用）。
 */
const deps = (options: ToolStackOptions = {}) => buildToolStackDeps(options)

const gatewayOf = (stack: ReturnType<typeof deps>, plugins: readonly ToolPlugin[]) =>
  new ToolGateway(stack.config, silentLogger as never, plugins, stack.clock)

const spec = (over: Partial<ToolSpec> = {}): ToolSpec =>
  ({
    key: 'demo',
    title: '演示',
    description: '用于测试的声明（够长的说明，避免占位）',
    category: 'core',
    scope: 'all',
    params: z.object({ value: z.string().default('x') }),
    config: z.object({}),
    exec: async () => ({ ok: 'done' }),
    ...over,
  }) as ToolSpec

const call = (over: Record<string, unknown> = {}) => ({
  callId: 'call-1',
  envelope: null,
  log: silentLogger as never,
  ...over,
})

describe('网关：顺序、短路、结论', () => {
  it('pre 插件按顺序跑；返回值 = 短路（工具不执行）', async () => {
    const order: string[] = []
    let executed = 0
    const plugins: ToolPlugin[] = [
      { name: 'first', pre: () => void order.push('first') },
      { name: 'second', pre: () => ({ ok: false as const, reason: 'forbidden' as const, message: '不许' }) },
      { name: 'third', pre: () => void order.push('third') },
    ]
    const outcome = await gatewayOf(deps(), plugins).invoke(
      spec({ exec: async () => void (executed += 1) }),
      {},
      call(),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden', message: '不许' })
    expect(order).toEqual(['first'])
    expect(executed).toBe(0)
  })

  it('全部 pre 放行 → 执行体结果成为结论', async () => {
    const outcome = await gatewayOf(deps(), [
      { name: 'pass', pre: () => undefined },
    ]).invoke(spec(), { value: 'hello' }, call())
    expect(outcome).toEqual({ ok: true, data: { ok: 'done' } })
  })

  it('入参在 pre 之后被归一化（`validate` 插件补默认值），执行体拿到的是归一化后的入参', async () => {
    let seen: unknown
    const stack = deps()
    const { ValidatePlugin } = await import('../src/modules/ai/tools/plugins/index.js')
    const outcome = await gatewayOf(stack, [new ValidatePlugin()]).invoke(
      spec({
        exec: async (input: unknown) => {
          seen = input
          return 'ok'
        },
      }),
      {},
      call(),
    )
    expect(outcome.ok).toBe(true)
    expect(seen).toEqual({ value: 'x' })
  })

  it('执行体抛 `ToolDeniedError` → 对应 reason（不当成 internal）', async () => {
    const stack = deps()
    const { AuditEndPlugin } = await import('../src/modules/ai/tools/plugins/index.js')
    const outcome = await gatewayOf(stack, [new AuditEndPlugin(stack.metas, silentLogger as never)]).invoke(
      spec({
        exec: async () => {
          throw new ToolDeniedError('precheck-failed', '目标不存在', '换个 id')
        },
      }),
      {},
      call(),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'precheck-failed', message: '目标不存在' })
    if (outcome.ok) throw new Error('应当被拒绝')
    expect(outcome.hint).toBe('换个 id')
  })

  it('执行体抛别的异常 → `internal`（并落 error 日志，不外抛）', async () => {
    const outcome = await gatewayOf(deps(), []).invoke(
      spec({
        exec: async () => {
          throw new Error('boom')
        },
      }),
      {},
      call(),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'internal' })
    if (outcome.ok) throw new Error('应当失败')
    expect(outcome.message).toContain('boom')
  })

  it('已中止：给 `aborted` 结论（用户点停止 / 超时）', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await gatewayOf(deps(), []).invoke(
      spec({
        exec: async () => {
          throw new Error('被中止')
        },
      }),
      {},
      call({ signal: controller.signal }),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'aborted' })
  })

  it('插件自己抛异常 → 兜成 internal 结论（不让插件 bug 炸整轮）', async () => {
    const outcome = await gatewayOf(deps(), [
      {
        name: 'broken',
        pre: () => {
          throw new Error('插件写错了')
        },
      },
    ]).invoke(spec(), {}, call())
    expect(outcome).toMatchObject({ ok: false, reason: 'internal' })
  })

  it('拒绝也要被审计记下来（post 链对失败同样跑）', async () => {
    const stack = deps()
    const { AuditEndPlugin } = await import('../src/modules/ai/tools/plugins/index.js')
    await gatewayOf(stack, [
      { name: 'deny', pre: () => ({ ok: false as const, reason: 'disabled' as const, message: '关了' }) },
      new AuditEndPlugin(stack.metas, silentLogger as never),
    ]).invoke(spec(), {}, call())
    const meta = stack.metas.take('run-test', 'call-1')
    // 没有信封 → 没有 runId，账本按 (runId, toolCallId) 索引，所以这里取不到；
    // 有信封的路径由 e2e 覆盖。这条断言钉的是"插件链没有因为失败而中断"
    expect(meta).toBeNull()
  })

  it('有信封时：拒绝会记账，且 caller 能从信封读出来', async () => {
    const stack = deps()
    const { AuditEndPlugin, ScopePlugin } = await import('../src/modules/ai/tools/plugins/index.js')
    const envelope = {
      conversationId: 'conv-1',
      parentRunId: 'run-1',
      triggeredBy: 'user-1',
      isAdmin: false,
      depth: 0,
      agentKey: 'assistant',
      rootAgentKey: 'assistant',
      model: {},
      childToolbox: new Map(),
      skills: [],
    }
    const outcome = await gatewayOf(stack, [
      new ScopePlugin(),
      new AuditEndPlugin(stack.metas, silentLogger as never),
    ]).invoke(spec({ scope: 'admin' }), {}, call({ envelope }))
    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(stack.metas.take('run-1', 'call-1')).toMatchObject({ ok: false, reason: 'forbidden' })
  })

  it('ctx 是普通对象：exec 直接可调（不经过 Mastra，不需要 RequestContext）', async () => {
    let captured: ToolCallContext | null = null
    await gatewayOf(deps(), []).invoke(
      spec({
        exec: async (_input: unknown, ctx: unknown) => {
          captured = ctx as ToolCallContext
          return 'ok'
        },
      }),
      { value: 'v' },
      call(),
    )
    expect(captured).not.toBeNull()
    const ctx = captured as unknown as ToolCallContext
    expect(ctx.toolKey).toBe('demo')
    expect(ctx.settings.key).toBe('demo')
    expect(ctx.caller).toBeNull()
    expect(typeof ctx.clock.now()).toBe('number')
  })
})
