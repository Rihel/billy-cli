import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'

/**
 * 绑定后的执行体：**一个工具一个执行器**。
 *
 * 执行器不再手写这个接口 —— 注册机从执行器的 `@CapabilityDecl` 扫描出来，把方法与声明绑成
 * 这样一条记录（`key` 就是声明里的工具名）。授权 / 限流 / 审计不在这里（gateway 的职责）；
 * 执行体只做：校验入参 → 在隔离环境里执行 → 返回统一结论。
 */
export interface ToolExecutor {
  readonly key: string
  execute(request: ToolInvokeRequest): Promise<ToolOutcome>
}
