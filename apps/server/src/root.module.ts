import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import {
  AppConfigModule,
  AuditSubscriber,
  CommandModule,
  DbModule,
  IdGenerationModule,
  JwtModule,
  KafkaModule,
  LarkModule,
  LoggerModule,
  NotificationModule,
  ObjectStorageModule,
  PasswordModule,
  RateLimitModule,
  RedisModule,
  SchedulerModule,
  SessionStoreModule,
  StreamHubModule,
  TelemetryModule,
} from '@repo/kits'
import {
  AppExceptionFilter,
  ERROR_ALERT_HOOK,
  type ErrorAlertHook,
  RequestContextModule,
  RequestLoggerModule,
  RequestMetricsModule,
  ResponseEnvelopeInterceptor,
  createZodValidationPipe,
} from './common/index.js'
import { AdminEntity } from './database/entities/admin-entity.js'
import { AiModelEntity } from './database/entities/ai-model-entity.js'
import { AiProviderEntity } from './database/entities/ai-provider-entity.js'
import { AlertLogEntity } from './database/entities/alert-log-entity.js'
import { AlertRuleEntity } from './database/entities/alert-rule-entity.js'
import { ConversationEntity } from './database/entities/conversation-entity.js'
import { RunEntity } from './database/entities/run-entity.js'
import { TimelineEntity } from './database/entities/timeline-entity.js'
import { TodoEntity } from './database/entities/todo-entity.js'
import { UserEntity } from './database/entities/user-entity.js'
import { AdminModule } from './modules/admin/index.js'
import { AiModelModule } from './modules/ai-model/index.js'
import { AiModule } from './modules/ai/index.js'
import { AuthModule } from './modules/auth/index.js'
import { AlertTrigger, MonitorModule } from './modules/monitor/index.js'
import { OpsModule } from './modules/ops/index.js'
import { SessionModule } from './modules/session/index.js'
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
    // 顺序铁律：RequestContextModule（写 ALS）必须排在 RequestLoggerModule / RequestMetricsModule 之前
    // —— 后两者要在请求结束时从 ALS 读 requestId / userId / adminId。三者均 @Global，
    // Nest 12 让全局模块的中间件排在最前、全局模块之间按本 imports 顺序稳定装配。
    RequestContextModule,
    RequestLoggerModule,
    RequestMetricsModule,
    // ---- 基础能力（无配置）----
    IdGenerationModule,
    TelemetryModule,
    SchedulerModule,
    CommandModule,
    // ---- 基础设施：配置由 ConfigService 惰性解析 ----
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('logger')!,
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
          ConversationEntity,
          RunEntity,
          TimelineEntity,
          // AI 模型模块（配置类：供应商 + 模型；表结构见 docs/design/ai-agent.md §4.8）
          AiProviderEntity,
          AiModelEntity,
        ],
        // 审计订阅者：给继承 AuditEntity 的实体自动写 created_by / updated_by / deleted_by
        // （操作人由 main.ts 的 setAuditUserProvider 提供）
        subscribers: [AuditSubscriber],
      }),
    }),
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('redis')!,
    }),
    RateLimitModule,
    StreamHubModule,
    JwtModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('jwt')!,
    }),
    SessionStoreModule,
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
    // ---- 运维探针（根路径 GET，全工程唯一的 GET 例外：k8s 探针只会发 GET）----
    OpsModule,
    // ---- 业务模块 ----
    AuthModule,
    AdminModule,
    UserModule,
    TodoModule,
    // AI 模型配置（供应商 / 模型两张表 + 明细同步 + 运行时模型解析；AiModule 依赖它的 AiModelService）
    AiModelModule,
    // AI Agent（Mastra）：模型未配置时模块照常装配，仅 /agent/* 返回 3301
    AiModule,
    StorageModule,
    StreamModule,
    SessionModule,
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
