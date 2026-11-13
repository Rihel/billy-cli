# 共享包（shared / kits / http-client / sdk）

> 本篇讲 `@repo/shared`、`@repo/kits`、`@repo/http-client` 与 `@repo/sdk`；组件库 `@repo/ui` 见 [frontend.md](./frontend.md)。

## @repo/shared — 前后端共享层

Zod schema 单一事实源，同时派生 TypeScript 类型（`*.schema.ts` 导出 `XxxModel` / `XxxDto`）：

- **数据结构命名（硬性）**：schema 常量一律 `XxxSchema` 结尾（值后缀）；入参类型 `XxxDto`、响应类型
  `XxxModel`（类型后缀），两者 `z.infer` 导出在**同一文件**、紧贴其 schema；`z.enum` 值域 schema
  （如 `AdminStatusSchema` / `AlertLevelSchema`）只导出 schema，不建类型别名；`base.schema.ts` 的
  `BaseModelSchema` / `BasePaginateSchema` / `BaseCursorPaginateSchema` 只作 `extend` / `intersection`
  基石，不导出类型。
- `schema/`（16 个 schema 文件 + `index.ts` 汇总导出）：auth / admin / user / session / stream（SSE 事件与订阅）/
  monitor（告警规则、日志、健康检查）/ object-storage / app-config / agent / ai-model / ai-tool /
  ai-tool-event / ai-connector / ai-skill（技能库）/ share（免授权文件分享）/ base（模型与分页、游标基类）
- `dicts/`（10 个字典 + `index.ts`）：`app-error-code.dict.ts`（错误码字典：`value` + `http` + `label`，业务抛错、
  server 映射、前端文案共用同一份定义）、`user-status.dict.ts`，以及 AI 相关字典（`ai` / `ai-model` / `ai-tool` /
  `ai-tool-event` / `ai-connector` / `ai-capability` / `ai-modality` / `ai-skill`）
- `app-response.ts`：`AppResponse<T>` / `AppPageQueryResponse<T>` / `AppCursorQueryResponse<T>` 与
  `ResponseUtils`（`success` / `error` / `isSuccess`）
- `logger.ts`：日志工厂 `createLogger(name, pretty, level, { redact, transport })`，
  开发环境 pretty 彩色、生产 JSON（**前后端共用**：后端 kits `LoggerModule` 也用它，见 [后端文档](./backend.md) 的「日志」一节）
- 子入口：`@repo/shared/browser`（浏览器端安全导出）、`@repo/shared/logger`（前端日志）
- `utils/`：nanoid / dayjs / md5 / tree / dict / file / zod 等通用工具；`file-kind.ts` 是**文件类型判定的唯一一份**
  （文本 / 图片 / 音视频 / PDF / Office 与 `previewKind`、`OfficeKind`），服务端据此下发、前端只 switch

## @repo/kits — 后端通用能力封装

纯能力集（**不持有任何业务实体**）。装配采用「**一个基础设施一个 NestJS module**」：
每个模块用 `XxxModule.forRoot(options)` 显式接收自己的配置分片，该配置对象即模块自己的注入 bean
（`DbConfig` / `RedisConfig` / `JwtConfig` / `PasswordConfig` / `StorageConfig` / `NotifyConfig` /
`LarkConfig` / `KafkaConfig` / `WorkspaceConfig`），不再由应用聚合成一个中央 kits 模块。所有模块均 `@Global()`，
装配进 `apps/server/src/root.module.ts` 的 `imports`（`src` 下 16 个能力目录 + `index.ts`）：

- `db/`：`create-db.ts`（PostgreSQL DataSource 工厂，实体由应用注入）、`db.ts`（`Db`：连接生命周期统一入口）、
  `db.service.ts`（`DbService`：**注入式数据操作统一入口**——四种分页 / 批量写入与删除 / 软删 /
  SQL 还原；只依赖 `Db`，不注入 logger，
  自动带默认 manager 与当前操作人。纯函数是内核，本类只是把它接进容器，
  见 [架构文档](./architecture.md) 的「数据操作统一入口」一节）、`db.config.ts`（`DbConfig`）、`database.module.ts`（`DbModule`）、
  `pagination.ts`（四种分页策略，见 [架构文档](./architecture.md) 的「分页」一节）、
  `batch.ts`（`batch` 分片 + 并发骨架 / `batchInsert` / `batchSave` / `batchUpsert`，
  事务内自动串行）、`safe-delete.ts`（`safeDelete`：先写 `deletedBy` 再软删）、
  `sql.ts`（`getFullSqlStatement`：占位符还原成完整 SQL，仅调试）、
  `base-entity.ts`（`BaseEntity`：`id` nanoid 主键 + `createdAt` / `updatedAt` /
  软删除 `deletedAt`）、`audit-entity.ts` + `audit-subscriber.ts`（**可选审计**：继承 `AuditEntity`
  并把 `AuditSubscriber` 放进 `db.subscribers`，自动记录 `createdBy` / `updatedBy` / `deletedBy`；
  操作人来源用 `setAuditUserProvider()` 挂载，`DbService.operatorId` 读同一个钩子）
- 各基础设施一个目录（有配置的是 `provider + <name>.config.ts + <name>.module.ts + index.ts`，
  无自有配置的（如 `pubsub/` / `events/` / `stream/`）只有 provider + module）：
  - `redis/`：`redis-store.ts`（KV / TTL / JSON / 基础锁）、`redis-lock.service.ts`（自旋等待 +
    看门狗续期）、`redis-lock.decorator.ts`（`@RedisLock`）、`redis-list-cache.ts`（Hash 列表缓存）、
    `redis.config.ts`（`RedisConfig`）、`redis.module.ts`（`RedisModule`）
  - `rate-limit/`：`rate-limiter.ts`（基于 rate-limiter-flexible，IP 白名单用 `ip-utils.ts`）+
    `rate-limit.module.ts`（`RateLimitModule`，复用 `RedisConfig`）
  - `pubsub/`：`pubsub.ts`（**底层 Pub/Sub 传输**：两条 ioredis 连接、懒建连、断线重订阅、
    自回环过滤、精确频道 + 模式订阅）+ `pubsub.module.ts`；上层 `stream/` 与 `events/` 都建在它上面
  - `stream/`：`stream-hub.ts` / `stream-connection.ts`（SSE 推流，`stream:*` 模式订阅）+ `stream-hub.module.ts`
  - `events/`：`event-bus.ts`（**事件总线**：进程内 API + PubSub 跨实例广播，`events:<topic>` 频道、
    发布方本地同步送达、处理函数隔离；at-most-once，只做失效通知 / 领域事件）+ `event-bus.module.ts`
  - `workspace/`：`workspace.runtime.ts`（`WorkspaceRuntimeService`：把命令放进「文件效果」边界里执行，
    模式 `read-only` / `workspace-write` / `danger-full-access`；默认 `enforce` —— 沙箱不可用即拒绝执行，
    fail closed）+ `workspace.sandbox.ts`（macOS seatbelt / Linux bubblewrap 的探测与包装）+
    `workspace.config.ts`（`WorkspaceConfig`）+ `workspace.module.ts`（`WorkspaceModule`）
  - `jwt/`：`token-signer.ts` + `jwt.config.ts`（`JwtConfig`）+ `jwt.module.ts`
  - `session/`：`session-store.ts`（会话存储：校验 / 撤销 / 登录设备列表 / 单设备下线）+ `session.module.ts`
  - `password/`：`password-hasher.ts` + `password.config.ts`（`PasswordConfig`）+ `password.module.ts`
  - `storage/`：`object-storage.ts` + `storage.config.ts`（`StorageConfig`）+
    `object-storage.module.ts` + `providers/{s3,cos}.ts`
  - `kafka/`：`kafka.service.ts` / `kafka-consumer.decorator.ts`（`@KafkaConsumer`）/
    `kafka-consumer-scanner.ts` + `kafka.config.ts`（`KafkaConfig`）+ `kafka.module.ts`
  - `lark/`：`lark.client.ts`（飞书官方 SDK 封装）+ `lark.config.ts`（`LarkConfig`）+ `lark.module.ts`
  - `notification/`：`notifier.ts`（通知编排）+ `notify.config.ts`（`NotifyConfig`）+
    `notification.module.ts` + `file/file.client.ts` / `email/email.client.ts` /
    `lark-notify/lark-notify.client.ts`
  - `telemetry/`：`telemetry.ts`（Counter / Gauge / Histogram）+ `telemetry.module.ts`
- `foundation/`：`config/`（**配置模块**：可插拔 `ConfigLoader` 抽象 + 内置 `envConfigLoader` /
  `memoryConfigLoader` / `consulConfigLoader` + `AppConfigFacade` + `AppConfigModule`；Zod 4 默认值物化 +
  带字段路径的校验错误）、`command/`（跨平台命令执行：`CommandRunner` + `CommandModule`，底层 `execa` ——
  shell 按平台解析、超时按进程树杀、输出有上限、失败不抛异常）、`errors/`（AppError / InfrastructureError）、`id-generation/`（`IdGeneration` + `IdGenerationModule`）、
  `logger/`（`app-logger.ts` + `logger.config.ts` + `logger.options.ts` + `LoggerModule`）、`scheduler/`（croner + `SchedulerModule`）、
  `time-wheel/`（`TimeWheel` 进程内高频调度原语：秒级/毫秒级刻度 + 自适应补偿 + 落后任务防堆积。
  **普通类（不走 DI）的封装**——需构造参数且天然多实例，用 `new TimeWheel(tickDuration, wheelsCount)`
  自行 `start()` / `stop()`，故无 module）
- **模块清单**（均在 `packages/kits/src` 下，全部 `@Global()`）：

| Module | forRoot 选项 | 提供的 bean |
| --- | --- | --- |
| `AppConfigModule` | `forRoot()` 无选项（前置：bootstrap 先 `await AppConfigFacade.initial({ schema, loader })`） | AppConfig（整份已加载配置）+ 全局 `ConfigService` |
| `IdGenerationModule` / `SchedulerModule` / `TelemetryModule` / `CommandModule` | 无 | IdGeneration / Scheduler / Telemetry / CommandRunner |
| `WorkspaceModule` | `{ mode?, sandboxNetwork?, probeTimeoutMs? }` | WorkspaceConfig + WORKSPACE_PROBE + WorkspaceRuntimeService |
| `LoggerModule` | `{ prefix?, level?, pretty?, loki? }` | LoggerConfig + LOGGER_INSTANCE + AppLogger + NestLoggerAdapter |
| `DbModule` | `{ url?, sync?, entities?, subscribers? }` | DbConfig + Db + DbService |
| `RedisModule` | `{ url?, keyPrefix? }` | RedisConfig + RedisStore + RedisLockService |
| `RateLimitModule` | 无（复用 RedisConfig） | RateLimiter |
| `PubSubModule` | 无（复用 RedisConfig + IdGeneration） | PubSub |
| `StreamHubModule` | 无（依赖 PubSub） | StreamHub |
| `EventBusModule` | 无（依赖 PubSub） | EventBus |
| `JwtModule` | `{ secret?, expiresIn? }` | JwtConfig + TokenSigner |
| `SessionStoreModule` | 无（复用 JwtConfig + RedisStore） | SessionStore |
| `PasswordModule` | `{ passwordHashRounds? }` | PasswordConfig + PasswordHasher |
| `ObjectStorageModule` | StorageConfig 输入 | StorageConfig + ObjectStorage |
| `LarkModule` | LarkConfig 输入 | LarkConfig + LarkClient |
| `NotificationModule` | NotifyConfig 输入 | NotifyConfig + Notifier + FileClient + EmailClient + LarkNotifyClient |
| `KafkaModule` | KafkaConfig 输入 | KafkaConfig + KAFKA_CONNECTION + KafkaService + KafkaConsumerScanner |

  需要配置的模块都**同时提供 `forRoot(options)` 与 `forRootAsync(options)`**：同步版自己
  `Schema.parse(options)` 校验 + 补默认值；异步版接受统一的 `InfraModuleAsyncOptions`
  （`{ imports?, inject?, useFactory }`），由 `useFactory` 惰性返回该模块分片，模块内部再 `Schema.parse`；
  应用侧用 `forRootAsync` + `ConfigService.get('<命名空间>')` 从已加载的应用配置取值。

  **缺失某个模块就是「未装配」**，
  用方由 Nest 解析报错（可选依赖用 `@Optional()` 降级，如未装配 `LarkModule` 时
  `LarkNotifyClient` 的 `LarkClient` 注入为 undefined，通道自动降级为「未配置」；
  `KafkaModule` 额外 `imports DiscoveryModule` 以支持 `@KafkaConsumer` 扫描）
- 业务仓储 / 服务由各业务模块 `providers` 注册；实体是类引用、无法来自环境变量，
  由应用在 `DbModule.forRootAsync` 的 `useFactory` 里补 `entities: [...]`
- 继续 re-export `typeorm-transactional`（业务模块 `@Transactional()` 直接来自 `@repo/kits`）

## @repo/http-client — 通用 HTTP + 鉴权管线

业务无关的客户端基础设施，被 `@repo/sdk` 的 `ServerClient` 继承使用（依赖方向：`sdk → http-client → shared`）。

`HttpClient`（基于原生 fetch）的请求管线：

```
skipAuth 检查
  → CredentialResolver.resolve()（凭证校验 / acquire / refresh，并发去重）
  → AuthInjector.inject()（按 AuthStrategy 注入 headers / query / body）
  → cancelPrevious（相同在途请求去重，latest wins）
  → fetch() 发送请求
  → 错误处理：401 + 可刷新 → forceRefresh 重试一次；其余统一抛 ApiError
```

- `ServerClient extends HttpClient`（`@repo/sdk`）：按业务分组的全类型化方法
  —— `config` / `auth` / `admin` / `user` / `share`（分享创建 / 列表 / 撤销 / 公开 meta）/ `storage` /
  `monitor` / `agent`（`chat` / `conversation` / `file` / `run` / `timeline` / `models` / `usage*`，含
  `file.workspace` / `file.adminList` / `file.adminStats` / `file.adminPreview`、`conversation.setFileAccess`）/
  `aiModel` / `aiTool` / `aiSkill`（技能库增删改查 + 文件读写 + 链接导入）/ `aiConnector` / `session`；
  `createStream()` 建 SSE 长连接，`chatStreamUrl()` / `resumeStreamUrl()` / `currentRunStreamUrl()` 给 AI SDK
  transport 用；请求 / 响应类型全部来自 `@repo/shared`
- `createAppClients()`（`packages/sdk/src/app-clients.ts`）：前端装配浏览器单例 / 服务端无状态客户端 / 凭证读写，
  应用只注入 `tokenKey`、两端地址与 401 善后
- 认证策略：`BearerToken` / `ApiKey` / `OAuth2` / `HMAC`
- 凭证管理器：`localStorage` / `memory` / `cookie` / `env`
- 凭证供应器：`empty-check` / `expires-at`（配合 OAuth2 自动续期）
- 错误：统一 `ApiError`（可 JSON 序列化），区分网络异常与业务异常

```typescript
import { ServerClient } from '@repo/sdk'
import { LocalStorageCredentialsManager } from '@repo/http-client'
import type { BearerTokenCredentials } from '@repo/http-client'

const client = new ServerClient({
  baseUrl: 'http://localhost:9989',
  credentialsManager: new LocalStorageCredentialsManager<BearerTokenCredentials>('access-token'),
  callbacks: {
    onUnauthorized: () => window.location.replace('/auth/login'),
  },
})

// 公开接口（无需 token）
const { token, user } = await client.auth.login({ email, password })
await client.credentialsManager.setCredentials({ token })

// 需鉴权接口
const me = await client.auth.getMe()
const users = await client.user.pageQuery({ page: 1, size: 20 })
```
