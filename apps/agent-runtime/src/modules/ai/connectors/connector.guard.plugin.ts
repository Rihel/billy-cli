import type { ToolOutcome } from '../core/tools/tools.types.js'
import type { ToolCallContext, ToolPlugin } from '../core/tools/tools.types.js'
import type { ConnectorStateSource } from './connector.state.js'
import { hintOf } from '../../ai-model/secret-hint.js'

/**
 * **连接器总闸插件**（设计 `docs/design/ai-connector.md` §3.9）。
 *
 * 位置：`enabled` 之后、`scope` 之前。只对连接器产出的工具生效（`spec.connector` 存在）。
 *
 * 两件事：
 * - 实例被停用 → 结论 `disabled`（"这个能力现在不可用"，不是我们写错了）；
 * - 必填密钥缺失 → 结论 `precheck-failed`（让模型引导用户去补配置，而不是让它反复重试）。
 *
 * 为什么放在网关而不是同步里：**关掉连接器要立刻生效**。同步只管"有哪些工具"，
 * 总闸必须落在每次调用都必经的那条路上。
 */
export class ConnectorGuardPlugin implements ToolPlugin {
  readonly name = 'connector-guard'

  constructor(private readonly states: ConnectorStateSource) {}

  async pre(ctx: ToolCallContext): Promise<ToolOutcome<never> | void> {
    const connector = ctx.spec.connector
    if (!connector) return

    const state = await this.states.stateOf(connector.id)
    if (!state) {
      return {
        ok: false,
        reason: 'disabled',
        message: `连接器已不存在：${connector.key}`,
        hint: '让管理员在后台「AI → 连接器」检查这一条',
      }
    }
    if (!state.enabled) {
      return {
        ok: false,
        reason: 'disabled',
        message: `连接器「${state.name}」已停用`,
        hint: '需要使用时，请管理员在后台重新启用并同步',
      }
    }
    if (state.missingSecret) {
      return {
        ok: false,
        reason: 'precheck-failed',
        message: `连接器「${state.name}」缺少必填密钥`,
        hint: '请在后台「AI → 连接器」补全密钥',
      }
    }

    // 连接器的密钥在实例上，而 precheck / redact 认的是「本次调用的设置」：
    // 这里把实例密钥嫁接进去，于是「缺密钥」不再误报、出参也能按它脱敏。
    const secrets = state.secrets
    if (Object.keys(secrets).length > 0) {
      const originalSecret = ctx.settings.secret.bind(ctx.settings)
      const originalHint = ctx.settings.secretHint.bind(ctx.settings)
      ctx.settings.secret = (name: string): string | null => secrets[name] ?? originalSecret(name)
      ctx.settings.secretHint = (name: string): string | null => {
        const value = secrets[name]
        return value ? hintOf(value) : originalHint(name)
      }
    }
    return
  }
}
