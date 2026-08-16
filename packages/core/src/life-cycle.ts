/**
 * 应用生命周期接口。
 *
 * 持有连接/外部资源的组件（如 Db、RedisStore、ObjectStorage）
 * 实现本接口，由 runtime 的 startCore / stopCore 统一调度：
 * - onAppStart：应用启动时初始化（建连、预热）
 * - onAppStop：应用优雅关闭时释放资源（逆序执行）
 */
export interface OnAppStart {
  onAppStart(): Promise<void>
}

export interface OnAppStop {
  onAppStop(): Promise<void>
}
