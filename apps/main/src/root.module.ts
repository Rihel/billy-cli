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
  PubSubModule,
  RateLimitModule,
  RedisModule,
  SchedulerModule,
  SessionStoreModule,
  StreamHubModule,
  EventBusModule,
  TelemetryModule,
  WorkspaceModule,
  type DbModuleOptions,
  AppExceptionFilter,
  ERROR_ALERT_HOOK,
  type ErrorAlertHook,
  RequestContextModule,
  RequestLoggerModule,
  RequestMetricsModule,
  ResponseEnvelopeInterceptor,
  createZodValidationPipe,
} from '@repo/kits'
import { DB_ENTITIES } from '@repo/db'
import { AdminModule } from './modules/admin/index.js'
import { AiModelModule } from './modules/ai-model/index.js'
import { AuthModule } from './modules/auth/index.js'
import { AiAdminConversationModule } from './modules/ai-admin/conversation/index.js'
import { AiFileAdminModule } from './modules/ai-admin/file/index.js'
import { AiToolAdminModule } from './modules/ai-admin/tool/index.js'
import { CapabilityServiceAdminModule } from './modules/ai-admin/capability/index.js'
import { AiSkillAdminModule } from './modules/ai-admin/skill/index.js'
import { AgentSseBridge } from './agent/agent-sse.bridge.js'
import { AgentControlController } from './agent/agent-control.controller.js'
import { AgentRunQueueController } from './agent/agent-run-queue.controller.js'
import { AgentRunQueueService } from './agent/agent-run-queue.service.js'
import { AgentSseController } from './agent/agent-sse.controller.js'
import { MemoryController } from './modules/ai-admin/memory.controller.js'
import { MemoryRepository, MemoryService } from '@repo/ai-data'
import { MonitorEngine } from '@repo/monitor'
import { MonitorModule } from './modules/monitor/index.js'
import { OpsModule } from './modules/ops/index.js'
import { SessionModule } from './modules/session/index.js'
import { ShareModule } from './modules/share/index.js'
import { RuntimeConfigModule } from './modules/runtime-config/index.js'
import { StorageModule } from './modules/storage/index.js'
import { StreamModule } from './modules/stream/index.js'
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
  controllers: [
    AgentSseController,
    AgentControlController,
    AgentRunQueueController,
    MemoryController,
  ],
  imports: [
    // ---- 应用配置（全局 ConfigService + AppConfig bean）----
    AppConfigModule.forRoot(),
    // ---- 请求级横切中间件（自注册模块）----
    // 顺序规定：RequestContextModule（写 ALS）必须排在 RequestLoggerModule / RequestMetricsModule 之前
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
    // ---- 工作区运行时：执行环境（沙箱 / 非沙箱）的选择与探测 ----
    WorkspaceModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('workspace')!,
    }),
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
        // 显式给出分片类型，避免 ConfigService.get 的联合返回类型被当成 Promise 展开
        ...config.get<DbModuleOptions>('db'),
        // 实体是类引用，无法来自环境变量，由组合根注入
        entities: [...DB_ENTITIES],
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
    PubSubModule,
    StreamHubModule,
    EventBusModule,
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
    // AI 模型配置（供应商 / 模型两张表 + 明细同步 + 运行时模型解析；AiModule 依赖它的 AiModelService）
    AiModelModule,
    AiSkillAdminModule,
    CapabilityServiceAdminModule,
    AiToolAdminModule,
    AiAdminConversationModule,
    AiFileAdminModule,
    StorageModule,
    StreamModule,
    SessionModule,
    // 文件分享（免授权链接：列表页生成 / 分享页访问；见 docs/design/file-share.md）
    ShareModule,
    MonitorModule,
    RuntimeConfigModule,
  ],
  providers: [
    AgentRunQueueService,
    AgentSseBridge,
    MemoryRepository,
    MemoryService,
    // 技术错误告警钩子：把 MonitorEngine 适配为 common 层 token（避免 HTTP 边界层反向依赖业务模块）
    {
      provide: ERROR_ALERT_HOOK,
      useFactory:
        (engine: MonitorEngine): ErrorAlertHook =>
        (error, context) =>
          engine.ingestError(error, context),
      inject: [MonitorEngine],
    },
    // 全局 Zod 校验：读取路由参数上的 `@Body({ schema })` 元数据（NestJS 12 原生 Standard Schema）
    { provide: APP_PIPE, useFactory: createZodValidationPipe },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class RootModule {}
