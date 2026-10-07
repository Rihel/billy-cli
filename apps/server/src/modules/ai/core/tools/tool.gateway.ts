import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import type { AgentRuntimeEnvelope } from '../envelope.js'
import { toCaller } from './tool.caller.js'
import { ToolConfigService } from './tool.config.service.js'
import { createToolEventEmitter } from './tool-event.js'
import { TOOL_CLOCK } from './tool.ports.js'
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
 * **工具网关**（设计 §5.4）：所有工具调用的必经之路。
 *
 * 它只做编排，策略全在插件里：
 *
 * ```
 * ① 读生效配置（库里的值 + 代码默认值 + env 上限）
 * ② 依次跑 pre 插件；任一返回结论 → 短路，跳到 ④
 * ③ 跑 spec.exec（异常 / 中止在这里兜成结论，永不外抛）
 * ④ 依次跑 post 插件（脱敏 → 分页 → 审计）
 * ⑤ 返回 ToolOutcome
 * ```
 *
 * 三条纪律：
 * - **失败是结论**：插件与执行体都不抛业务异常；抛出去的那是我们自己写错了（装配错误），
 *   只记 `internal` 结论 + error 日志。工具错误在 Mastra 那边不会炸整轮（用例 ③ 实测过）；
 * - **顺序固定**：`AGENT_TOOL_PLUGINS` 的数组顺序就是执行顺序；
 * - **不 import @mastra**：网关是主体的一部分（`check:mastra` 守）。
 */
@Injectable()
export class ToolGateway {
  constructor(
    @Inject(ToolConfigService) private readonly config: ToolConfigService,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(AGENT_TOOL_PLUGINS) private readonly plugins: readonly ToolPlugin[],
    @Inject(TOOL_CLOCK) private readonly clock: ToolClock,
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
    const settings = await this.config.settings(spec)
    const envelope = (call.envelope ?? null) as AgentRuntimeEnvelope | null
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
      emit: createToolEventEmitter({
        ...(call.writer ? { writer: call.writer } : {}),
        toolKey: spec.key,
        toolCallId: call.callId,
        agentKey: envelope?.agentKey ?? null,
        events: spec.events,
        log,
      }),
    }

    // ② pre：任一插件给结论就短路（安全类插件只累积拒绝，不互相覆盖）
    for (const plugin of this.plugins) {
      if (!plugin.pre) continue
      const outcome = await this.safePre(plugin, ctx)
      if (outcome) {
        ctx.outcome = outcome
        break
      }
    }

    // ③ 执行
    if (!ctx.outcome) ctx.outcome = await this.execute(spec, ctx)

    // ④ post：脱敏 / 分页 / 审计（对拒绝也要跑 —— 拒绝必须被记下来）
    for (const plugin of this.plugins) {
      if (!plugin.post) continue
      try {
        await plugin.post(ctx)
      } catch (error) {
        this.logger.error('ai.tool.plugin_failed', {
          toolKey: spec.key,
          plugin: plugin.name,
          phase: 'post',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return ctx.outcome ?? { ok: false, reason: 'internal', message: '工具没有给出结论' }
  }

  /** 跑执行体：异常与中止兜成结论（执行体的业务拒绝由 `ToolDeniedError` 表达） */
  private async execute(spec: ToolSpec, ctx: ToolCallContext): Promise<ToolOutcome> {
    if (!ctx.startedAt) ctx.startedAt = this.clock.now()
    try {
      const data = await spec.exec(ctx.input as never, ctx as never)
      return { ok: true, data }
    } catch (error) {
      if (ctx.signal?.aborted) {
        return { ok: false, reason: 'aborted', message: '这次调用已被停止', retryable: false }
      }
      // 执行体主动拒绝（越权 / 缺前置条件）：翻成对应 reason 的结论，绝不记成 internal
      if (error instanceof ToolDeniedError) {
        return {
          ok: false,
          reason: error.reason,
          message: error.message,
          ...(error.hint ? { hint: error.hint } : {}),
          retryable: error.retryable,
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

  private async safePre(
    plugin: ToolPlugin,
    ctx: ToolCallContext,
  ): Promise<ToolOutcome<never> | null> {
    try {
      const outcome = await plugin.pre?.(ctx)
      return outcome ?? null
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('ai.tool.plugin_failed', {
        toolKey: ctx.toolKey,
        plugin: plugin.name,
        phase: 'pre',
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
