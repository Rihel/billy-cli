import { Container } from 'inversify'
import { DiParamTypesKey } from './di.js'
import type { LifeCycle } from './life-cycle.js'

type Ctor = new (...args: any[]) => any

export type LifeCycleState = 'idle' | 'starting' | 'started' | 'stopping' | 'stopped'

/**
 * 生命周期主机：负责生命周期组件的启动/停止调度。
 *
 * 顺序来源：组件构造器上的 @Inject 声明（我们自己的 DiParamTypesKey 元数据）。
 * 过滤出同为生命周期组件的依赖后做 Kahn 拓扑排序——
 * 调用方以任意顺序注册组件，宿主都保证「依赖先启动」。
 *
 * - start：先解析全部组件（构造），再按拓扑序执行 onAppStart；
 *          任一失败 → 逆序关闭已启动组件（best-effort）→ 抛原始错误
 * - stop：按拓扑逆序执行 onAppStop；幂等；单组件失败收集日志不中断
 */
export class LifeCycleHost {
  private readonly tokens: Ctor[] = []
  private state: LifeCycleState = 'idle'

  constructor(private readonly container: Container) {}

  register(token: Ctor): void {
    if (!this.tokens.includes(token)) this.tokens.push(token)
  }

  getState(): LifeCycleState {
    return this.state
  }

  /** 读取组件构造器注入依赖，过滤出同为生命周期组件的部分 */
  private lifecycleDepsOf(token: Ctor): Ctor[] {
    const deps: unknown[] = Reflect.getOwnMetadata(DiParamTypesKey, token) ?? []
    return deps.filter((dep): dep is Ctor =>
      typeof dep === 'function' && this.tokens.includes(dep as Ctor),
    )
  }

  /** Kahn 拓扑排序：返回依赖在前的启动序列；检测环 */
  private topoSort(): Ctor[] {
    const inDegree = new Map<Ctor, number>()
    const dependents = new Map<Ctor, Ctor[]>()
    for (const token of this.tokens) {
      inDegree.set(token, 0)
      dependents.set(token, [])
    }
    for (const token of this.tokens) {
      for (const dep of this.lifecycleDepsOf(token)) {
        inDegree.set(token, (inDegree.get(token) ?? 0) + 1)
        dependents.get(dep)!.push(token)
      }
    }
    const queue = this.tokens.filter((token) => inDegree.get(token) === 0)
    const order: Ctor[] = []
    while (queue.length > 0) {
      const token = queue.shift()!
      order.push(token)
      for (const dependent of dependents.get(token) ?? []) {
        const next = (inDegree.get(dependent) ?? 0) - 1
        inDegree.set(dependent, next)
        if (next === 0) queue.push(dependent)
      }
    }
    if (order.length !== this.tokens.length) {
      const cyclic = this.tokens.filter((token) => (inDegree.get(token) ?? 0) > 0)
      throw new Error(
        `Lifecycle 依赖存在环: ${cyclic.map((token) => token.name).join(' -> ')}`,
      )
    }
    return order
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return
    this.state = 'starting'
    const started: Ctor[] = []

    try {
      // 先解析全部组件（触发构造），保证后续取实例即用
      const instances = new Map(
        this.tokens.map((token) => [token, this.container.get(token)]),
      )
      const order = this.topoSort()
      for (const token of order) {
        await (instances.get(token) as LifeCycle).onAppStart?.()
        started.push(token)
      }
      this.state = 'started'
    } catch (error) {
      for (const token of [...started].reverse()) {
        try {
          await (this.container.get(token) as LifeCycle).onAppStop?.()
        } catch {
          // 回滚失败不阻断
        }
      }
      this.state = 'idle'
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.state !== 'started') return
    this.state = 'stopping'
    const order = this.topoSort()
    for (const token of [...order].reverse()) {
      try {
        await (this.container.get(token) as LifeCycle).onAppStop?.()
      } catch (error) {
        console.error(`lifecycle.stop failed: ${token.name}`, error)
      }
    }
    this.state = 'stopped'
  }
}
