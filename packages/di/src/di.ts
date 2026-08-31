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

/** 包装 inversify 的 @injectable：透传原装饰器（原地写元数据，类不变） */
export function Injectable(): ClassDecorator {
  return (target) => originInjectable()(target)
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
