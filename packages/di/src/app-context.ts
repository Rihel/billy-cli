import { Container, type ServiceIdentifier } from 'inversify'
import { LifeCycleHost, type LifeCycleState } from './life-cycle-host.js'

/**
 * 应用组合根：Container（依赖解析）+ LifeCycleHost（生命周期调度）。
 *
 * 用法：
 *   const ctx = new AppContext()
 *     .addConstant(MyConfigToken, config)
 *     .addLifeCycleService(Db)
 *     .addService(AuthService)
 *   await ctx.start()
 *   const service = ctx.get(AuthService)
 *   await ctx.stop()
 */
export class AppContext {
  private readonly container: Container
  private readonly lifeCycleHost: LifeCycleHost
  private readonly constants = new Map<any, any>()
  private readonly services = new Set<any>()
  private readonly transientServices = new Set<any>()
  private started = false

  constructor() {
    this.container = new Container({})
    this.lifeCycleHost = new LifeCycleHost(this.container)
  }

  /** 绑定常量值（token → value），如配置对象 */
  addConstant(token: any, value: any): this {
    this.constants.set(token, value)
    return this
  }

  /** 绑定单例服务 */
  addService(service: any): this {
    this.services.add(service)
    return this
  }

  /** 绑定瞬时服务 */
  addTransient(service: any): this {
    this.transientServices.add(service)
    return this
  }

  /** 绑定生命周期组件（单例）：同时注册进 LifeCycleHost，启动顺序由 @Inject 声明自动推导 */
  addLifeCycleService(service: any): this {
    this.lifeCycleHost.register(service)
    this.services.add(service)
    return this
  }

  get<T>(token: ServiceIdentifier<T>): T {
    // 首次访问即绑定（惰性），保证 start() 之前也能取服务
    this.ensureBeansAppended()
    return this.container.get<T>(token)
  }

  getState(): LifeCycleState {
    return this.lifeCycleHost.getState()
  }

  private beansAppended = false

  private ensureBeansAppended(): void {
    if (this.beansAppended) return
    this.beansAppended = true
    for (const [token, value] of this.constants) {
      this.container.bind(token).toConstantValue(value)
    }
    for (const service of this.services) {
      this.container.bind(service).toSelf().inSingletonScope()
    }
    for (const transient of this.transientServices) {
      this.container.bind(transient).toSelf().inTransientScope()
    }
  }

  /** 绑定全部 bean 并启动生命周期组件。幂等：重复调用 no-op */
  async start(): Promise<void> {
    if (this.started) return
    this.ensureBeansAppended()
    await this.lifeCycleHost.start()
    this.started = true
  }

  /** 停止生命周期组件。幂等：可重复调用 */
  async stop(): Promise<void> {
    await this.lifeCycleHost.stop()
    this.started = false
  }
}
