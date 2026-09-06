/**
 * 应用生命周期接口。
 *
 * 持有连接/外部资源的组件（如 Db、RedisStore、ObjectStorage）实现本接口，
 * 由 LifeCycleHost 统一调度：
 * - onAppStart：应用启动时初始化（建连、预热）
 * - onAppStop：应用优雅关闭时释放资源（逆序执行）
 *
 * 钩子均为可选：允许 start-only（如 ObjectStorage）与 stop-only 组件。
 */
export interface OnAppStart {
  onAppStart(): Promise<void>
}

export interface OnAppStop {
  onAppStop(): Promise<void>
}

/** 生命周期组件：两个钩子都可选 */
export interface LifeCycle {
  onAppStart?(): Promise<void>
  onAppStop?(): Promise<void>
}

/**
 * 判别类是否为生命周期组件：原型上声明了 onAppStart 或 onAppStop 方法。
 * 供 AppContext.autoRegister() 识别——实现生命周期钩子的 @Injectable 类
 * 自动以生命周期组件装配（等价 addLifeCycleService），无需手动登记。
 */
export const hasLifeCycleHooks = (target: any): boolean => {
  const proto = target?.prototype
  if (!proto) return false
  return (
    typeof proto.onAppStart === 'function' ||
    typeof proto.onAppStop === 'function'
  )
}
