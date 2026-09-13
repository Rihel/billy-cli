import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import {
  AppConfigModule,
  DbModule,
  IdGenerationModule,
  JwtModule,
  KafkaModule,
  LarkModule,
  LoggerModule,
  NotificationModule,
  ObjectStorageModule,
  PasswordModule,
  QueueModule,
  RateLimitModule,
  RedisModule,
  SchedulerModule,
  SessionModule,
  StreamHubModule,
  TelemetryModule,
} from '@repo/kits'
import {
  AppExceptionFilter,
  ERROR_ALERT_HOOK,
  type ErrorAlertHook,
  RequestContextModule,
  RequestMetricsModule,
  ResponseEnvelopeInterceptor,
  createZodValidationPipe,
  requestContext,
} from './common/index.js'
import { AdminEntity } from './database/entities/admin-entity.js'
import { AlertLogEntity } from './database/entities/alert-log-entity.js'
import { AlertRuleEntity } from './database/entities/alert-rule-entity.js'
import { TodoEntity } from './database/entities/todo-entity.js'
import { UserEntity } from './database/entities/user-entity.js'
import { AdminModule } from './modules/admin/index.js'
import { AuthModule } from './modules/auth/index.js'
import { AlertTrigger, MonitorModule } from './modules/monitor/index.js'
import { RuntimeConfigModule } from './modules/runtime-config/index.js'
import { StorageModule } from './modules/storage/index.js'
import { StreamModule } from './modules/stream/index.js'
import { TodoModule } from './modules/todo/index.js'
import { UserModule } from './modules/user/index.js'

/**
 * 应用组合根（NestJS 唯一装配点，故文件/类名均以 root 命名）。
 *
 * 配置链路（对齐 rihel-base）：
 * 1. bootstrap 先 `await loadServerAppConfig()` —— 用 zod schema 从 env / .env 加载 + 校验 + 补默认值；
 * 2. `AppConfigModule.forRoot()` 把已加载配置接进 Nest（全局 `ConfigService` + `AppConfig` bean）；
 * 3. 各基础设施用 `forRootAsync({ inject: [ConfigService] })` **惰性**取自己的配置分片
 *    （惰性很关键：模块装饰器求值发生在配置加载之前）；应用级业务配置同理，
 *    各处注入 `ConfigService` 后用 `resolveServerConfig()` 取 `server` 分片，不再单设配置 bean。
 *
 * 可选模块（Lark / Kafka）由 env 是否存在决定是否装配（模块集合在 bootstrap 期静态确定），
 * 但其配置值同样经过应用配置校验。
 */
@Module({
  imports: [
    // ---- 应用配置（全局 ConfigService + AppConfig bean）----
    AppConfigModule.forRoot(),
    // ---- 请求级横切中间件（自注册模块）----
    // 顺序铁律：RequestContextModule 必须在 LoggerModule 之前（Nest 按模块注册顺序挂载中间件），
    // 否则 pino-http 取不到 X-Request-Id / ALS 里的登录身份
    RequestContextModule,
    RequestMetricsModule,
    // ---- 基础能力（无配置）----
    IdGenerationModule,
    TelemetryModule,
    SchedulerModule,
    // ---- 基础设施：配置由 ConfigService 惰性解析 ----
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...config.get('logger'),
        // pino-http 每条请求日志附加上下文：当前登录身份（来自请求上下文 ALS）
        customProps: () => ({
          userId: requestContext.get('userId') ?? null,
          adminId: requestContext.get('adminId') ?? null,
        }),
      }),
    }),
    DbModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...config.get('db'),
        // 实体是类引用，无法来自环境变量，由组合根注入
        entities: [
          UserEntity,
          TodoEntity,
          AdminEntity,
          AlertRuleEntity,
          AlertLogEntity,
        ],
      }),
    }),
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('redis')!,
    }),
    RateLimitModule,
    QueueModule,
    StreamHubModule,
    JwtModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('jwt')!,
    }),
    SessionModule,
    PasswordModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('password')!,
    }),
    ObjectStorageModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('storage')!,
    }),
    NotificationModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('notify')!,
    }),
    // ---- 可选模块：env 存在才装配 ----
    ...(process.env.LARK_APP_ID && process.env.LARK_APP_SECRET
      ? [
          LarkModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => config.get('lark')!,
          }),
        ]
      : []),
    ...(process.env.KAFKA_BROKERS
      ? [
          KafkaModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => config.get('kafka')!,
          }),
        ]
      : []),
    // ---- 业务模块 ----
    AuthModule,
    AdminModule,
    UserModule,
    TodoModule,
    StorageModule,
    StreamModule,
    MonitorModule,
    RuntimeConfigModule,
  ],
  providers: [
    // 技术错误告警钩子：把 AlertTrigger 适配为 common 层 token（避免 HTTP 边界层反向依赖业务模块）
    {
      provide: ERROR_ALERT_HOOK,
      useFactory: (alertTrigger: AlertTrigger): ErrorAlertHook =>
        (error, context) => alertTrigger.notifyError(error, context),
      inject: [AlertTrigger],
    },
    // 全局 Zod 校验：读取路由参数上的 `@Body({ schema })` 元数据（NestJS 12 原生 Standard Schema）
    { provide: APP_PIPE, useFactory: createZodValidationPipe },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class RootModule {}
