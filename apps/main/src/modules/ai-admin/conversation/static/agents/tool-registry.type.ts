/** main 侧只需要描述工具面，避免 import runtime 的工具注册机 */
export interface ToolRegistry {
  describe(
    selectors: readonly unknown[],
  ): Array<{ key: string; title: string; description: string }>
}
