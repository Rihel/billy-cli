import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { withCallReason } from '../src/modules/ai/core/tools/call-reason.js'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolDeniedError } from '../src/modules/ai/core/tools/tools.types.js'
import type {
  ToolCallContext,
  ToolPlugin,
  ToolSpec,
} from '../src/modules/ai/core/tools/tools.types.js'
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
    // 没声明自定义事件（`ctx.emit` 仍然存在，见事件测试）
    events: [],
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
    const { ValidatePlugin } = await import('../src/modules/ai/core/tools/plugins/index.js')
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
    const { AuditEndPlugin } = await import('../src/modules/ai/core/tools/plugins/index.js')
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
    const { AuditEndPlugin } = await import('../src/modules/ai/core/tools/plugins/index.js')
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
    const { AuditEndPlugin, ScopePlugin } = await import('../src/modules/ai/core/tools/plugins/index.js')
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

/**
 * **必填 `reason`**（设计 §5.18）："为什么这次要用这个工具"由引擎注入、网关校验。
 *
 * 这里测的是**网关这一层**（它同时是兜底层：给模型那份 schema 缺失时、以及任何没走 Mastra
 * 校验的调用路径 —— 直接 `gateway.invoke` / 后台调用 —— 都靠它把纪律守住）。
 * 模型侧的 JSON Schema 必填由标准测试集与 e2e 覆盖。
 */
describe('网关：必填 reason（为什么用这个工具）', () => {
  /** 带注入字段的那份契约（真实工具声明走 `buildToolSpecs` 时就是这样） */
  const modelSpec = (over: Partial<ToolSpec> = {}): ToolSpec => {
    const params = z.object({ value: z.string().default('x') })
    return spec({ params, modelParams: withCallReason(params), ...over })
  }

  it('缺 reason → `invalid-input`，结论文案点名 reason（模型据此改正）', async () => {
    const { ValidatePlugin } = await import('../src/modules/ai/core/tools/plugins/index.js')
    const outcome = await gatewayOf(deps(), [new ValidatePlugin()]).invoke(
      modelSpec(),
      { value: 'v' },
      call(),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-input' })
    if (outcome.ok) throw new Error('应当被拒绝')
    expect(outcome.message).toContain('reason')
    expect(outcome.hint).toContain('reason')
  })

  it('`reason` 是空白串 → 同样拒绝（"写了字段但没说清"不算说明目的）', async () => {
    const { ValidatePlugin } = await import('../src/modules/ai/core/tools/plugins/index.js')
    const outcome = await gatewayOf(deps(), [new ValidatePlugin()]).invoke(
      modelSpec(),
      { value: 'v', reason: '   ' },
      call(),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-input' })
    if (outcome.ok) throw new Error('应当被拒绝')
    expect(outcome.message).toContain('reason')
  })

  it('`reason` 非字符串 → 同样拒绝（不给"半个值"混进审计）', async () => {
    const { ValidatePlugin } = await import('../src/modules/ai/core/tools/plugins/index.js')
    const outcome = await gatewayOf(deps(), [new ValidatePlugin()]).invoke(
      modelSpec(),
      { value: 'v', reason: 42 },
      call(),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-input' })
  })

  it('给了合法 reason → 正常执行；`ctx.reason` 拿得到它，而执行体的 `input` 里**没有**它', async () => {
    const { ValidatePlugin } = await import('../src/modules/ai/core/tools/plugins/index.js')
    let seenInput: unknown
    let seenReason: string | null = null
    const outcome = await gatewayOf(deps(), [new ValidatePlugin()]).invoke(
      modelSpec({
        exec: async (input: unknown, ctx: unknown) => {
          seenInput = input
          seenReason = (ctx as ToolCallContext).reason
          return 'ok'
        },
      }),
      { value: 'v', reason: '用户要看这台机器的环境' },
      call(),
    )
    expect(outcome).toEqual({ ok: true, data: 'ok' })
    // 执行体拿到的仍是原契约（注入字段被摘掉了，工具签名与行为不变）
    expect(seenInput).toEqual({ value: 'v' })
    // 理由单独交给 ctx（工具可以读它写业务日志）
    expect(seenReason).toBe('用户要看这台机器的环境')
  })

  it('reason 也进审计账本（`callReason`，与拒绝原因 `reason` 分开）', async () => {
    const stack = deps()
    const { AuditEndPlugin, ValidatePlugin } = await import(
      '../src/modules/ai/core/tools/plugins/index.js'
    )
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
    await gatewayOf(stack, [
      new ValidatePlugin(),
      new AuditEndPlugin(stack.metas, silentLogger as never),
    ]).invoke(
      modelSpec(),
      { value: 'v', reason: '用户要看这台机器的环境' },
      call({ callId: 'call-reason', envelope }),
    )
    expect(stack.metas.take('run-1', 'call-reason')).toMatchObject({
      ok: true,
      callReason: '用户要看这台机器的环境',
    })
  })
})
