import { AppContext } from '@repo/di'
import type { z } from 'zod'
import {
  AuthConfig,
  AuthConfigSchema,
  DbConfig,
  DbConfigSchema,
  JwtConfig,
  JwtConfigSchema,
  LoggerConfig,
  LoggerConfigSchema,
  RedisConfig,
  RedisConfigSchema,
  StorageConfig,
  StorageConfigSchema,
} from './foundation/config/index.js'
import { IdGeneration } from './foundation/id-generation.js'
import { configureLogger } from './foundation/logger.js'
import { Scheduler } from './foundation/scheduler.js'
import { Db } from './infrastructure/database.js'
import { ObjectStorage } from './infrastructure/object-storage/object-storage.js'
import { PasswordHasher } from './infrastructure/password-hasher.js'
import { QueueManager } from './infrastructure/queue.js'
import { RedisStore } from './infrastructure/redis-store.js'
import { StreamHub } from './infrastructure/stream/stream-hub.js'
import { SessionStore } from './infrastructure/session-store.js'
import { TokenSigner } from './infrastructure/token-signer.js'

/** 服务组合根入参：各能力分片的原始配置（schema 校验 + 默认值补全在装配时进行）。 */
export interface ServiceContextConfig {
  db?: z.input<typeof DbConfigSchema>
  redis?: z.input<typeof RedisConfigSchema>
  jwt?: z.input<typeof JwtConfigSchema>
  storage?: z.input<typeof StorageConfigSchema>
  auth?: z.input<typeof AuthConfigSchema>
  logger?: z.input<typeof LoggerConfigSchema>
}

/**
 * 服务组合根工厂：按「配置分片存在与否」装配对应基础设施与基础能力。
 * 不含任何业务模块（repository/service 由应用层自行 addService 注册）。
 *
 * 应用层（apps/server / scripts / worker）用法：
 *   const ctx = createServiceContext({ db: { entities: [...], sync: true } })
 *   ctx.addService(UserRepository).addService(UserService)...
 *   await ctx.start()
 *   const service = ctx.get(Service)
 *   await ctx.stop()
 *
 * 规则：
 * - 每个能力分片是独立配置 bean（schema 校验 + 通用默认值），缺失分片不注册；
 * - 组件只按「所需配置存在」注册：传了 db 才装配 Db，传了 redis 才装配 Redis/队列；
 *   用了某组件却没提供其配置 → DI 解析报错（"缺失配置 di 报错"），而非全量启动校验；
 * - 生命周期组件（Db / RedisStore / ObjectStorage / QueueManager / Scheduler）的
 *   启动顺序由组件构造器上的 @Inject 声明自动推导，与注册顺序无关。
 */
export const createServiceContext = (config: ServiceContextConfig = {}): AppContext => {
  const loggerConfig = LoggerConfigSchema.parse(config.logger ?? {})
  configureLogger(loggerConfig.pretty)

  const ctx = new AppContext()
  // 配置 bean（按需注册 + zod 校验）
  if (config.db !== undefined) ctx.addConstant(DbConfig, DbConfigSchema.parse(config.db))
  if (config.redis !== undefined) ctx.addConstant(RedisConfig, RedisConfigSchema.parse(config.redis))
  if (config.jwt !== undefined) ctx.addConstant(JwtConfig, JwtConfigSchema.parse(config.jwt))
  if (config.storage !== undefined) ctx.addConstant(StorageConfig, StorageConfigSchema.parse(config.storage))
  if (config.auth !== undefined) ctx.addConstant(AuthConfig, AuthConfigSchema.parse(config.auth))
  if (config.logger !== undefined) ctx.addConstant(LoggerConfig, loggerConfig)

  // 基础设施（按所需配置存在注册；缺失分片 → 组件不装配，用了即 DI 报错）
  if (config.db !== undefined) ctx.addLifeCycleService(Db)
  if (config.redis !== undefined) {
    ctx.addLifeCycleService(RedisStore)
    ctx.addLifeCycleService(QueueManager)
    ctx.addLifeCycleService(StreamHub)
  }
  if (config.redis !== undefined && config.jwt !== undefined) ctx.addLifeCycleService(SessionStore)
  if (config.redis !== undefined && config.storage !== undefined) ctx.addLifeCycleService(ObjectStorage)
  if (config.jwt !== undefined) ctx.addService(TokenSigner)
  if (config.auth !== undefined) ctx.addService(PasswordHasher)
  // 基础能力（无配置依赖）
  ctx.addService(IdGeneration)
  ctx.addLifeCycleService(Scheduler)

  return ctx
}
