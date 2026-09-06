import { Container, type ServiceIdentifier } from 'inversify'
import { LifeCycleHost, type LifeCycleState } from './life-cycle-host.js'
import { getInjectableRegistry } from './di.js'
import { hasLifeCycleHooks } from './life-cycle.js'

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
  /** 组合根声明「手动管理」的类（条件装配基建）：autoRegister 跳过 */
  private readonly manualTokens = new Set<any>()
  private started = false

  constructor() {
    this.container = new Container({})
    this.lifeCycleHost = new LifeCycleHost(this.container)
  }

  /**
   * 声明这些类由组合根显式管理（addService / addLifeCycleService 手动装配），
   * autoRegister() 自动跳过。用于 kits 基建等「按配置分片条件装配」的组件
   * ——它们需保持显式注册语义（缺配置不注册、@Optional 优雅降级）。
   */
  markManual(...tokens: any[]): this {
    tokens.forEach((token) => this.manualTokens.add(token))
    return this
  }

  /**
   * 自动装配：把全局注册表中「已 @Injectable 登记、未被手动管理、未显式注册」的类
   * 批量绑定为单例；实现 OnAppStart/OnAppStop 钩子的类自动按生命周期组件装配。
   *
   * 业务类只需写 @Injectable() 即自动成为 bean，组合根无需逐个 addService。
   * 注意：模块必须被 import（装饰器才执行登记），组合根通常先 import 模块副作用入口。
   */
  autoRegister(): this {
    for (const token of getInjectableRegistry()) {
      if (this.manualTokens.has(token)) continue
      if (this.services.has(token) || this.transientServices.has(token)) continue
      if (hasLifeCycleHooks(token)) this.addLifeCycleService(token)
      else this.addService(token)
    }
    return this
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
