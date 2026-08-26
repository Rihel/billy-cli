import { AppContext } from '@repo/di'
import { configureLogger } from './foundation/logger.js'
import { AdminRepository } from './modules/admin/admin.repository.js'
import { AdminService } from './modules/admin/admin.service.js'
import { AuthService } from './modules/auth/auth.service.js'
import { TodoRepository } from './modules/todo/todo.repository.js'
import { TodoService } from './modules/todo/todo.service.js'
import { UserRepository } from './modules/user/user.repository.js'
import { UserService } from './modules/user/user.service.js'
import {
  AppConfig,
  createAppConfig,
  type AppConfigInput,
} from './foundation/app-config.js'
import { Db } from './infrastructure/database.js'
import { IdGeneration } from './foundation/id-generation.js'
import { ObjectStorage } from './infrastructure/object-storage/object-storage.js'
import { PasswordHasher } from './infrastructure/password-hasher.js'
import { QueueManager } from './infrastructure/queue.js'
import { RedisStore } from './infrastructure/redis-store.js'
import { Scheduler } from './foundation/scheduler.js'
import { SessionStore } from './infrastructure/session-store.js'
import { TokenSigner } from './infrastructure/token-signer.js'

/**
 * 应用组合根工厂：创建 AppContext（Container + LifeCycleHost）并装配全部 core bean。
 *
 * 应用层（apps/server / scripts）只面对返回的 AppContext：
 *   const ctx = createAppContext({ db: { sync: true } })
 *   await ctx.start()
 *   const service = ctx.get(Service)
 *   await ctx.stop()
 *
 * 生命周期组件（Db / RedisStore / ObjectStorage）的启动顺序
 * 由组件构造器上的 @Inject 声明自动推导，与注册顺序无关。
 */
export const createAppContext = (overrides: AppConfigInput = {}): AppContext => {
  const config = createAppConfig(process.env, overrides)
  configureLogger(config.logger.pretty)

  return new AppContext()
    .addConstant(AppConfig, config)
    // 基础设施（生命周期组件）
    .addLifeCycleService(Db)
    .addLifeCycleService(RedisStore)
    .addLifeCycleService(ObjectStorage)
    .addLifeCycleService(QueueManager)
    // 基础能力
    .addService(IdGeneration)
    .addService(PasswordHasher)
    .addService(TokenSigner)
    .addService(SessionStore)
    .addLifeCycleService(Scheduler)
    // 仓储
    .addService(UserRepository)
    .addService(TodoRepository)
    .addService(AdminRepository)
    // 业务服务
    .addService(AuthService)
    .addService(UserService)
    .addService(TodoService)
    .addService(AdminService)
}
// DI 能力（AppContext / @Injectable / @Inject / 生命周期）统一来自独立包 @repo/di，core 不再对外导出
