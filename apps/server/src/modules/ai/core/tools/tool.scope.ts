import type { ToolCallerIdentity, ToolScopeValue } from './tools.types.js'

/**
 * 作用域判定（纯函数，设计见 `docs/design/ai-agent-tool-engine.md` §5.7）。
 *
 * 两处共用，判据只能有一份：
 * - **装配期**：`ToolRegistry.authorized()` 用它把工具面里"这次身份根本用不上"的工具去掉；
 * - **调用期**：`ScopePlugin` 用它兜第二层（装配漏了、或工具面被缓存复用）。
 *
 * 为什么装配期要先过滤：留一个"看得见、点就拒"的工具，模型会反复去试，
 * 提示词里也多一条噪音。**没授权的工具该根本不出现**，拒绝只当兜底。
 */
export const scopeAllows = (
  scope: ToolScopeValue,
  allowedAgents: readonly string[],
  caller: ToolCallerIdentity,
): boolean => {
  switch (scope) {
    case 'all':
      return true
    case 'admin':
      return caller.isAdmin
    case 'user':
      return !caller.isAdmin
    case 'agent':
      return allowedAgents.includes(caller.rootAgentKey)
  }
}
