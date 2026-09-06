import {
  inject as originInject,
  injectable as originInjectable,
  optional as originOptional,
} from 'inversify'

/**
 * 我们自己的依赖元数据 key：记录每个类构造器参数位置的注入 token。
 * 与 inversify 的内部元数据完全无关——LifeCycleHost 依据它推导启动顺序，
 * 换 DI 库时只需改本文件。
 */
export const DiParamTypesKey = 'billy:di:paramtypes'

/**
 * 包装 inversify 的 @inject：
 * - 把注入 token 按参数位写入我们自己的元数据（DiParamTypesKey）
 * - 透传原装饰器：容器照常读到它自己的 key，依赖解析行为不变
 */
export function Inject(serviceIdentifier: any): ParameterDecorator {
  return (target: any, propertyKey: string | symbol | undefined, parameterIndex: number): void => {
    // 构造器参数装饰器的 target 即类本身；方法/属性参数才是原型
    const ctor = typeof target === 'function' ? target : target.constructor
    const existing: any[] = Reflect.getOwnMetadata(DiParamTypesKey, ctor) ?? []
    existing[parameterIndex] = serviceIdentifier
    Reflect.defineMetadata(DiParamTypesKey, existing, ctor)
    originInject(serviceIdentifier)(target, propertyKey, parameterIndex)
  }
}

type Ctor = new (...args: any[]) => any

/**
 * 全局注册表：记录所有被执行过 @Injectable() 的类（模块被 import 时装饰器执行登记）。
 * AppContext.autoRegister() 依据它批量装配；业务类只需写 @Injectable() 即自动成为 bean。
 * 注意：仅登记「类已加载」的事实，不持有实例、不影响 inversify 绑定行为。
 */
const injectableRegistry = new Set<Ctor>()

/** 读取注册表快照（供 autoRegister 装配；不导出可变引用） */
export const getInjectableRegistry = (): ReadonlySet<Ctor> => injectableRegistry

/**
 * 包装 inversify 的 @injectable：
 * - 把类登记进全局注册表（autoRegister 的装配依据）
 * - 透传原装饰器（原地写元数据，类不变）
 *
 * kits 基建等「按配置条件装配」的组件由组合根 markManual 声明为手动管理，
 * autoRegister 会跳过，不破坏条件装配 / @Optional 语义。
 */
export function Injectable(): ClassDecorator {
  return (target) => {
    injectableRegistry.add(target as unknown as Ctor)
    originInjectable()(target)
  }
}

/**
 * 可选注入：配合 @Inject 使用（同一参数位），依赖未绑定（条件装配的组件缺失）时注入 undefined。
 *
 * @example
 * constructor(
 *   @Inject(LarkNotifyClient) @Optional() private readonly larkNotify?: LarkNotifyClient,
 * ) {}
 *
 * 用于「按配置存在装配」的组件（如通知客户端）：缺配置时不注册，可选注入方不受影响。
 */
export function Optional(): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    originOptional()(target, propertyKey, parameterIndex)
  }
}
