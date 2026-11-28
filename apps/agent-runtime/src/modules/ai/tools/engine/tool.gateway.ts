import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import type { AgentRuntimeEnvelope } from '../../foundation/envelope.js'
import { toCaller } from './tool.caller.js'
import { ToolConfigService } from './tool.config.service.js'
import { createToolEventEmitter } from './tool-event.js'
import { REMOTE_TOOL_INVOKER, TOOL_CLOCK, type RemoteToolInvoker } from './tool.ports.js'
import { ToolCallMetaStore } from './tool.meta.js'
import { ToolDiscoveryStore } from './tool-discovery.store.js'
import { ToolDeniedError } from './tools.types.js'
import type {
  Tool,
  ToolCallContext,
  ToolCallInput,
  ToolClock,
  ToolOutcome,
  ToolPlugin,
  ToolSpec,
} from './tools.types.js'

/** 插件链的注入 token（数组顺序 = 执行顺序，装配处一眼可见） */
export const AGENT_TOOL_PLUGINS = Symbol.for('AgentToolPlugins')

/**
 * 从**原始入参**里取这次调用的理由（设计 §5.18）。
 *
 * 为什么读原始入参而不是等 `ValidatePlugin` 写完：审计旁证与结构化日志要在**拒绝路径**上
 * 也能拿到它（缺 reason 被拒的那一次，理由字段本身可能是空串 / 非字符串）；
 * 校验通过后 `ValidatePlugin` 会用摘干净的值覆盖它（那时 `reason` 一定合法）。
 * 只接受字符串：别的类型不往 `ctx` 里塞，免得工具读到"半个"值。
 */
const rawCallReason = (rawInput: unknown): string | null => {
  if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) return null
  const value = (rawInput as Record<string, unknown>).reason
  return typeof value === 'string' ? value : null
}

/**
 * 收尾链只能加工内容的判据：结论快照（`ok`、失败 `reason`、`retryable`）。
 *
 * 为什么连 `retryable` 一起比：它不是展示字段，而是**重试语义** ——
 * 把 `false` 改成 `true`，模型就会把一个本不该重试的失败原地重放。
 */
type ConclusionSnapshot = { ok: true } | { ok: false; reason: string; retryable: boolean } | null

const conclusionOf = (outcome: ToolOutcome<unknown> | undefined): ConclusionSnapshot => {
  if (!outcome) return null
  if (outcome.ok) return { ok: true }
  return { ok: false, reason: outcome.reason, retryable: outcome.retryable === true }
}

const sameConclusion = (
  before: ConclusionSnapshot,
  after: ToolOutcome<unknown> | undefined,
): boolean => {
  if (before === null) return after === undefined
  if (after === undefined) return false
  if (before.ok !== after.ok) return false
  if (before.ok) return true
  if (!after.ok) {
    return before.reason === after.reason && before.retryable === (after.retryable === true)
  }
  return false
}

/** 从 `tool-search` 的出参里取命中的工具 key（结构见网关 `runToolSearch`） */
const searchedKeysOf = (data: unknown): string[] => {
  if (!data || typeof data !== 'object') return []
  const items = (data as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  return items
    .map((item) => (item && typeof item === 'object' ? (item as { key?: unknown }).key : undefined))
    .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
}

/**
 * **工具网关**（设计 §5.4）：所有工具调用的必经之路。
 *
 * 它只做编排，策略全在插件里：
 *
 * ```
 * ① 读生效配置（库里的值 + 代码默认值 + env 上限）
 * ② 依次跑 before 钩子；任一返回结论 → 短路
 * ③ 跑 spec.exec（异常 / 中止在这里兜成结论，永不外抛）
 * ④ 收尾：失败走 denied 链，成功走 after 链（互斥）
 * ⑤ 返回 ToolOutcome
 * ```
 *
 * 三条纪律：
 * - **失败是结论**：插件与执行体都不抛业务异常；抛出去的那是我们自己写错了（装配错误），
 *   只记 `internal` 结论 + error 日志。工具错误在 Mastra 那边不会炸整轮（用例 ③ 实测过）；
 * - **顺序固定**：`AGENT_TOOL_PLUGINS` 的数组顺序就是执行顺序；
 * - **不 import @mastra**：网关是主体的一部分（`check:mastra` 守）。
 *
 * 生命周期三阶段（`ToolLifecyclePhase`）：`before` 短路 → `denied`；执行失败 → `denied`；
 * 执行成功 → `after`。拒绝不再是「post 里看一眼 outcome」而是独立的一条收尾链。
 */
@Injectable()
export class ToolGateway {
  constructor(
    @Inject(ToolConfigService) private readonly config: ToolConfigService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(AGENT_TOOL_PLUGINS) private readonly plugins: readonly ToolPlugin[],
    @Inject(TOOL_CLOCK) private readonly clock: ToolClock,
    /** 可选：allowlist 内的工具走远程 capability-gateway；未配置时完全走进程内执行 */
    @Optional() @Inject(REMOTE_TOOL_INVOKER) private readonly remote?: RemoteToolInvoker | null,
    /** 可选：`tool-search` 的结果记进会话，下一轮据此注入外部工具 */
    @Optional() @Inject(ToolDiscoveryStore) private readonly discovery?: ToolDiscoveryStore | null,
    /** 可选：目录能力不经插件链，远程调用要自己写审计旁证 */
    @Optional() @Inject(ToolCallMetaStore) private readonly metas?: ToolCallMetaStore | null,
  ) {}

  /** 把一份声明包成可调用的工具（注册机对外的只有这种） */
  wrap(spec: ToolSpec): Tool {
    return {
      key: spec.key,
      spec,
      run: (rawInput, call) => this.invoke(spec, rawInput, call),
    }
  }

  /** 一次调用（测试可以直接调它，不需要 Mastra） */
  async invoke(spec: ToolSpec, rawInput: unknown, call: ToolCallInput): Promise<ToolOutcome> {
    const envelope = (call.envelope ?? null) as AgentRuntimeEnvelope | null
    const caller = toCaller(envelope)

    /**
     * 远程执行：**策略已经搬到 capability-gateway**，这里不再跑本地插件链。
     * 只在 `TOOL_GATEWAY_URL` + allowlist 命中时走；否则保持原有进程内路径。
     */
    if (this.remote?.supports(spec.key)) {
      if (!caller) {
        return {
          ok: false,
          reason: 'forbidden',
          message: '缺少调用方身份，不能执行远程工具',
          retryable: false,
        }
      }
      const startedAt = this.clock.now()
      const input =
        rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {}
      // `reason` 是工具面的协议字段，不属于能力入参：远程校验前剥掉，
      // 否则网关按能力声明的 JSON Schema 校验会判 `Unrecognized key: "reason"`。
      const { reason: rawReason, ...capabilityInput } = input
      const callReason = typeof rawReason === 'string' ? rawReason : undefined
      let outcome: ToolOutcome
      try {
        outcome = await this.remote.invoke({
          toolKey: spec.key,
          toolCallId: call.callId,
          input: capabilityInput,
          caller,
          ...(envelope?.workspaceConversationId
            ? { workspaceConversationId: envelope.workspaceConversationId }
            : {}),
          ...(envelope?.workspaceId ? { workspaceId: envelope.workspaceId } : {}),
          // 暂无按工具派生的 deadline：5 分钟命令 + 10 秒传输余量
          deadlineMs: 310_000,
          ...(envelope?.fileAccess ? { fileAccess: envelope.fileAccess } : {}),
        })
      } catch (error) {
        // 远程客户端内部已兜传输异常；这里再兜一层，保证「成功 / 失败 / 异常」三路都有旁证
        outcome = {
          ok: false,
          reason: 'internal',
          message: `能力网关调用异常：${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        }
      }
      /**
       * 目录能力**不经本进程插件链**，没人写 `ToolCallMeta`：
       * 时间线的 tool-result 就会丢掉拒绝原因（issue 11）。旁证在这里补写。
       */
      this.metas?.put(caller.runId, call.callId, {
        ok: outcome.ok,
        ...(outcome.ok ? {} : { reason: outcome.reason }),
        ...(callReason ? { callReason } : {}),
        // 目录能力的配置在网关 / 后台侧，本进程拿不到版本：用固定标记表示"远端决定"
        configVersion: 'gateway',
        durationMs: Math.max(0, this.clock.now() - startedAt),
        outputBytes:
          outcome.ok === true ? Buffer.byteLength(JSON.stringify(outcome.data ?? ''), 'utf8') : 0,
      })
      // 检索出参里带命中的 key：记进会话，下一轮 resolveTools 据此注入外部工具
      if (spec.key === 'tool-search' && outcome.ok) {
        const keys = searchedKeysOf(outcome.data)
        if (keys.length > 0) await this.discovery?.remember(caller.conversationId, keys)
      }
      return outcome
    }

    const settings = await this.config.settings(spec)
    const log = call.log ?? this.logger
    const ctx: ToolCallContext = {
      spec,
      toolKey: spec.key,
      toolCallId: call.callId,
      caller: toCaller(envelope),
      settings,
      envelope,
      ...(call.signal ? { signal: call.signal } : {}),
      ...(call.writer ? { writer: call.writer } : {}),
      log,
      clock: this.clock,
      rawInput,
      input: rawInput,
      // 模型必填的"为什么用它"（设计 §5.18）：校验通过后由 `ValidatePlugin` 覆盖成摘干净的值
      reason: rawCallReason(rawInput),
      configVersion: settings.version,
      // 自定义事件出口（设计 §5.17）：按**声明**过滤 + payload 校验 + 失败只记 warn，
      // 组装在这里而不是执行体里 —— 工具作者只写 `ctx.emit(...)`，纪律只有一份实现
      /**
       * 收尾链唯一允许的改写：替换成功结果的内容。
       * 结论（`ok` / `reason`）不在这里改 —— 那是网关的判定结果。
       */
      setOutcomeData: (data: unknown) => {
        if (ctx.outcome?.ok) ctx.outcome = { ...ctx.outcome, data }
      },
      emit: createToolEventEmitter({
        ...(call.writer ? { writer: call.writer } : {}),
        toolKey: spec.key,
        toolCallId: call.callId,
        agentKey: envelope?.agentKey ?? null,
        events: spec.events,
        log,
      }),
    }

    // ② before：任一插件给结论就短路（安全类插件只累积拒绝，不互相覆盖）
    for (const plugin of this.plugins) {
      if (!plugin.before) continue
      const outcome = await this.runBefore(plugin, ctx)
      if (outcome) {
        ctx.outcome = outcome
        break
      }
    }

    // ③ 执行
    if (!ctx.outcome) ctx.outcome = await this.execute(spec, ctx)

    // ④ 收尾：失败 → denied，成功 → after（互斥；拒绝也必须被审计记下来）
    await this.finish(spec, ctx, ctx.outcome?.ok === false ? 'denied' : 'after')

    return ctx.outcome ?? { ok: false, reason: 'internal', message: '工具没有给出结论' }
  }

  /** 跑执行体：异常与中止兜成结论（执行体的业务拒绝由 `ToolDeniedError` 表达） */
  private async execute(spec: ToolSpec, ctx: ToolCallContext): Promise<ToolOutcome> {
    if (!ctx.startedAt) ctx.startedAt = this.clock.now()

    // 防御：远程 allowlist 命中的工具绝不允许静默回退到本地执行体。
    // 正常路径在 invoke() 里已经短路到 gateway；能走到这里说明装配/分支出错，宁可显式失败。
    if (this.remote?.supports(spec.key)) {
      return {
        ok: false,
        reason: 'internal',
        message: `工具 ${spec.key} 已配置远程执行，禁止回退到本地执行体`,
        retryable: false,
      }
    }

    try {
      const data = await spec.exec(ctx.input as never, ctx as never)
      return { ok: true, data }
    } catch (error) {
      if (ctx.signal?.aborted) {
        return { ok: false, reason: 'aborted', message: '这次调用已被停止', retryable: false }
      }
      // 执行体主动拒绝（越权 / 缺前置条件）：翻成对应 reason 的结论，绝不记成 internal。
      // 共享包（如 @repo/web-runtime 的 WebToolError）不能依赖本工程的 ToolDeniedError，
      // 按同一形状（reason / hint / retryable）识别。
      const denial = error as {
        reason?: unknown
        hint?: unknown
        retryable?: unknown
        message?: unknown
      }
      if (
        error instanceof ToolDeniedError ||
        (typeof denial.reason === 'string' && typeof denial.retryable === 'boolean')
      ) {
        return {
          ok: false,
          reason: denial.reason as never,
          message: typeof denial.message === 'string' ? denial.message : String(error),
          ...(typeof denial.hint === 'string' ? { hint: denial.hint } : {}),
          retryable: denial.retryable as boolean,
        }
      }
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('ai.tool.exec_failed', { toolKey: spec.key, reason })
      return {
        ok: false,
        reason: 'internal',
        message: `工具执行失败：${reason}`,
        hint: '换一种入参或稍后重试；重复失败请把这个原因如实告诉用户',
        retryable: true,
      }
    }
  }

  /**
   * 跑一条收尾链（denied / after）：插件抛错只记日志，不覆盖已经定下的结论。
   *
   * 还会兜一条运行期约束：收尾链**不得改写业务结论**（`ok` / `reason`）。类型上把
   * `outcome` 收成了只读（`ToolPhaseContext`），这里再防一手运行期改写（`as any` /
   * 非 TS 代码 / 未来的实现）—— 真被改写就把这次调用按 `internal` 失败处理，
   * 否则「跑了哪条收尾链」和「最终结论」会对不上。
   */
  private async finish(
    spec: ToolSpec,
    ctx: ToolCallContext,
    phase: 'denied' | 'after',
  ): Promise<void> {
    const conclusion = conclusionOf(ctx.outcome)
    for (const plugin of this.plugins) {
      const hook = plugin[phase]
      if (!hook) continue
      try {
        await hook.call(plugin, ctx)
      } catch (error) {
        this.logger.error('ai.tool.plugin_failed', {
          toolKey: spec.key,
          plugin: plugin.name,
          phase,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      if (!sameConclusion(conclusion, ctx.outcome)) {
        this.logger.error('ai.tool.plugin_outcome_mutation', {
          toolKey: spec.key,
          plugin: plugin.name,
          phase,
          before: conclusion?.ok === true ? 'ok' : 'failed',
          after: ctx.outcome?.ok === true ? 'ok' : 'failed',
        })
        ctx.outcome = {
          ok: false,
          reason: 'internal',
          message: `收尾插件（${plugin.name}）改写了调用结论，本次调用按失败处理`,
          retryable: false,
        }
        return
      }
    }
  }

  private async runBefore(
    plugin: ToolPlugin,
    ctx: ToolCallContext,
  ): Promise<ToolOutcome<never> | null> {
    try {
      const outcome = await plugin.before?.(ctx)
      return outcome ?? null
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('ai.tool.plugin_failed', {
        toolKey: ctx.toolKey,
        plugin: plugin.name,
        phase: 'before',
        reason,
      })
      return {
        ok: false,
        reason: 'internal',
        message: `前置校验失败（${plugin.name}）：${reason}`,
        retryable: false,
      }
    }
  }
}
