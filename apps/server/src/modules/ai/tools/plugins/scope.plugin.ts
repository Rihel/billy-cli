import { Injectable } from '@nestjs/common'
import type { ToolCallContext, ToolOutcome, ToolPlugin } from '../tools.types.js'

/**
 * 作用域：按**根 agent + 触发身份**判（子 agent 沿用父的判定，设计 §5.7）。
 *
 * 四条判据与配置表一一对应：`all` / `admin` / `user` / `agent`。
 */
@Injectable()
export class ScopePlugin implements ToolPlugin {
  readonly name = 'scope'

  pre(ctx: ToolCallContext): ToolOutcome<never> | void {
    const { scope, allowedAgents } = ctx.settings
    if (scope === 'all') return
    const caller = ctx.caller
    if (!caller) {
      // 没有信封 = 调用没走编排层（装配 / 配置错误）。**不伪造放行**：宁可拒绝
      return {
        ok: false,
        reason: 'forbidden',
        message: '这次调用缺少运行时身份（编排层未注入信封），无法判断权限',
        hint: '请重新发起这一轮；若仍如此请把这条结论告诉用户',
        retryable: false,
      }
    }
    if (scope === 'admin' && !caller.isAdmin) {
      return {
        ok: false,
        reason: 'forbidden',
        message: '这个工具只允许管理员触发',
        hint: '换用其它工具，或请用户在后台操作',
        retryable: false,
      }
    }
    if (scope === 'user' && caller.isAdmin) {
      return {
        ok: false,
        reason: 'forbidden',
        message: '这个工具只允许前台用户触发',
        hint: '换用其它工具',
        retryable: false,
      }
    }
    if (scope === 'agent' && !allowedAgents.includes(caller.rootAgentKey)) {
      return {
        ok: false,
        reason: 'forbidden',
        message: `这个工具未授权给 agent「${caller.rootAgentKey}」`,
        hint: '换用其它工具，或把原因告诉用户',
        retryable: false,
      }
    }
  }
}
