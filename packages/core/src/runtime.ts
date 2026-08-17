import { Container } from 'inversify'
import type { OnAppStart, OnAppStop } from './life-cycle.js'
import { AuthService } from './modules/auth/auth.service.js'
import { TodoRepository } from './modules/todo/todo.repository.js'
import { TodoService } from './modules/todo/todo.service.js'
import { UserRepository } from './modules/user/user.repository.js'
import { UserService } from './modules/user/user.service.js'
import { Db } from './shared/database.js'
import { IdGeneration } from './shared/id-generation.js'
import { configureLogger } from './shared/logger.decorator.js'
import { ObjectStorage } from './shared/object-storage/object-storage.js'
import { PasswordHasher } from './shared/password-hasher.js'
import { RedisStore } from './shared/redis-store.js'
import {
  AppConfig,
  createAppConfig,
  type AppConfigInput,
} from './shared/app-config.js'
import { TokenSigner } from './shared/token-signer.js'

/**
 * 应用组合根：唯一装配点。
 * 应用层（apps/server）通过 appCore 获取业务服务，不感知内部依赖图。
 */
export const appCore = new Container()

/** 已注册的生命周期组件（实现 OnAppStart / OnAppStop 的资源类组件） */
const appStartComponents: OnAppStart[] = []
const appStopComponents: OnAppStop[] = []

const registerLifecycle = (component: unknown): void => {
  if (component && typeof (component as OnAppStart).onAppStart === 'function') {
    appStartComponents.push(component as OnAppStart)
  }
  if (component && typeof (component as OnAppStop).onAppStop === 'function') {
    appStopComponents.push(component as OnAppStop)
  }
}

/** 应用启动：按注册顺序执行各组件的 onAppStart（初始化连接等）。 */
export const startCore = async (): Promise<void> => {
  for (const component of appStartComponents) {
    await component.onAppStart()
  }
}

/** 应用停止：逆序执行各组件的 onAppStop（释放连接等），单个失败不阻断其余。 */
export const stopCore = async (): Promise<void> => {
  for (const component of appStopComponents.reverse()) {
    await component.onAppStop().catch(() => undefined)
  }
}

let initialized = false

/** 注入配置并注册全部服务。幂等：重复调用不会重复注册。 */
export const initCore = (overrides: AppConfigInput = {}): Container => {
  if (initialized) return appCore
  initialized = true

  const config = createAppConfig(process.env, overrides)
  appCore.bind(AppConfig).toConstantValue(config)
  configureLogger(config.logger.pretty)

  // 基础设施
  appCore.bind(Db).toSelf().inSingletonScope()
  appCore.bind(RedisStore).toSelf().inSingletonScope()
  appCore.bind(IdGeneration).toSelf().inSingletonScope()
  appCore.bind(PasswordHasher).toSelf().inSingletonScope()
  appCore.bind(TokenSigner).toSelf().inSingletonScope()
  appCore.bind(ObjectStorage).toSelf().inSingletonScope()

  // 仓储
  appCore.bind(UserRepository).toSelf().inSingletonScope()
  appCore.bind(TodoRepository).toSelf().inSingletonScope()

  // 业务服务
  appCore.bind(AuthService).toSelf().inSingletonScope()
  appCore.bind(UserService).toSelf().inSingletonScope()
  appCore.bind(TodoService).toSelf().inSingletonScope()

  // 注册生命周期组件（解析实例并登记 onAppStart / onAppStop）
  registerLifecycle(appCore.get(Db))
  registerLifecycle(appCore.get(RedisStore))
  registerLifecycle(appCore.get(ObjectStorage))

  return appCore
}
