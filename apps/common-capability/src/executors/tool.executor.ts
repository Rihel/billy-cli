import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'

/**
 * worker 执行体契约：**一个工具 key 一个执行器**。
 *
 * 授权 / 限流 / 审计不在这里（gateway 的职责）；执行器只做：
 * 校验入参 → 在隔离环境里执行 → 返回统一结论。
 */
export interface ToolExecutor {
  readonly key: string
  execute(request: ToolInvokeRequest): Promise<ToolOutcome>
}
