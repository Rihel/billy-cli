# 共享包（12 个）

> `packages/*` 共 12 个包：共享数据层 `@repo/shared` / `@repo/db` / `@repo/ai-data`，底层契约与运行时
> `@repo/contracts` / `@repo/web-runtime`，后端能力 `@repo/kits` / `@repo/monitor` / `@repo/capability`，
> 客户端与 SDK `@repo/http-client` / `@repo/sdk` / `@repo/internal-sdk`，前端组件库 `@repo/ui`
> （组件库用法见 [frontend.md](./frontend.md)）。
>
> 依赖方向**单向**：`shared` / `contracts` / `web-runtime` 是底层；`kits → shared`；`db → kits,shared`；
> `ai-data → db,kits,shared`；`monitor → db,kits,shared`；`http-client → shared`；`sdk → http-client,shared`；
> `internal-sdk → contracts,shared,http-client`；`capability → contracts`；`ui → shared`。

## @repo/shared — 前后端共享层

Zod schema 单一事实源，同时派生 TypeScript 类型（`*.schema.ts` 导出 `XxxModel` / `XxxDto`）：

- **数据结构命名（硬性）**：schema 常量一律 `XxxSchema` 结尾（值后缀）；入参类型 `XxxDto`、响应类型
  `XxxModel`（类型后缀），两者 `z.infer` 导出在**同一文件**、紧贴其 schema；`z.enum` 值域 schema
  （如 `AdminStatusSchema` / `AlertLevelSchema`）只导出 schema，不建类型别名；`base.schema.ts` 的
  `BaseModelSchema` / `BasePaginateSchema` / `BaseCursorPaginateSchema` 只作 `extend` / `intersection`
  基石，不导出类型。
- `schema/`（**23 个 schema 文件** + `index.ts` 汇总导出）：`base`（模型与分页、游标基类）/
  `app-config` / `auth` / `user` / `admin` / `object-storage` / `stream`（SSE 事件与订阅）/ `monitor`
  （告警规则、日志、健康检查）/ `session` / `agent`（agent 目录 / 会话 / 运行 / 时间线）/ `agent-run-queue` /
  `agent-run-snapshot` / `agent-stream-frame`（AG-UI 流式帧）/ `ai-model` / `gateway-usage`（网关用量）/
  `ai-tool` / `ai-tool-event` / `ai-skill`（技能库）/ `ai-memory` / `capability-service`（能力服务登记）/
  `service-grant`（服务级授权）/ `workspace`（AI 工作区）/ `share`（免授权文件分享）
- `dicts/`（**11 个字典** + `index.ts`）：`app-error-code.dict.ts`（错误码字典：`value` + `http` + `label`，
  业务抛错、server 映射、前端文案共用同一份定义）、`user-status.dict.ts`，以及 AI 相关字典
  （`ai` / `ai-tool` / `ai-tool-event` / `ai-model` / `ai-provider-endpoint` / `ai-capability` / `ai-modality` /
  `ai-skill` / `ai-memory`）
- `agui/`：AG-UI 1.0 帧的编解码、SSE 解析与常量（main 的 SSE 中继与前端会话页共用同一份帧定义）
- `app-response.ts`：`AppResponse<T>` / `AppPageQueryResponse<T>` / `AppCursorQueryResponse<T>` 与
  `ResponseUtils`（`success` / `error` / `isSuccess`）
- `logger.ts`：日志工厂 `createLogger(name, pretty, level, { redact, transport })`，
  开发环境 pretty 彩色、生产 JSON（**前后端共用**：后端 kits `LoggerModule` 也用它，见 [后端文档](./backend.md) 的「日志」一节）
- 子入口：`@repo/shared/browser`（浏览器端安全导出）、`@repo/shared/logger`（前端日志）、`@repo/shared`
  主入口（schema + dicts + utils + agui）
- `utils/`：nanoid / dayjs / md5 / tree / dict / file / zod 等通用工具；`file-kind.ts` 是**文件类型判定的唯一一份**
  （文本 / 图片 / 音视频 / PDF / Office 与 `previewKind`、`OfficeKind`），服务端据此下发、前端只 switch

## @repo/db — 数据库事实源

- **26 个 TypeORM 实体 + 38 个迁移**：`src/entities` / `src/migrations`，导出 `DB_ENTITIES` /
  `DB_MIGRATIONS` 与具名实体；所有 app 共用同一份表结构。
- 表分五类：账号（`users` / `admins`）、会话与运行（`conversations` / `runs` / `timelines` /
  `conversation_run_queue`）、AI 配置与记录（`ai_models` / `ai_providers` / `ai_provider_keys` / `ai_tools` /
  `ai_tool_audit` / `ai_skills` / `ai_skill_files` / `ai_memories` / `ai_files` / `ai_capability_services` /
  `ai_service_grants` / `ai_workspaces` / `ai_usage_daily*`）、模型网关用量（`model_gateway_usage`）、
  监控与分享（`monitor_*` / `alert_logs` / `file_shares`）。
- 组合根：main / agent-runtime 用 `entities: [...DB_ENTITIES]` 全量装配；model-gateway / capability-gateway /
  common-capability / workspace-service 按需注册自己用到的实体子集（网关用量、能力目录与审计、记忆与文件、
  工作区等），不整包注册。
- **迁移 CLI 归属本包**：`packages/db/data-source.ts` 是 TypeORM CLI 的 DataSource（先加载 `.env`、
  再用 `DB_ENTITIES` / `DB_MIGRATIONS`）；根脚本 `db:gen` / `db:migrate` 都指向 `@repo/db`
  （`pnpm db:gen <Name>` 用 `packages/db/scripts/db-generate.ts` 生成到 `packages/db/src/migrations/`，
  `pnpm db:migrate` 先构建本包再跑 `migration:run`）。
- `apps/*/src/database/entities` 的兼容 re-export **已全部删除**：实体唯一来源是本包，
  **新增字段一律来 `@repo/db` 改**。

## @repo/ai-data — AI 数据访问层

AI 域的数据访问与纯计算下沉，main（配置 / 后台查询）、agent-runtime（执行）、common-capability 与
workspace-service（文件 / 记忆能力）共用同一套读写口径；没有 Nest module，由各 app 的 `providers` 注册：

- `file/`：`FileService` / `FileRepository`（`ai_files`）、`PathLock`（同一路径的并行读写串行化）、
  `WorkspaceFsPort`（工作区文件系统端口）、`workspace.ts`（会话工作区布局 `{workspaceRoot}/{conversationId}/`
  与路径边界判断）
- `memory/`：`MemoryService` / `MemoryRepository`（`ai_memories`）+ `memory.similarity.ts`（相关度与注入排序）
- `tool-result/`：工具出参分页（字节切页、稳定 handle、按 UTF-8 码点边界，确定性对 durable 重放友好）
- `usage/`：`AiUsageService` + `AiUsageRollupService`（逐轮 tokens 落 `runs`，按日 / 维度 rollup 到
  `ai_usage_daily*`，上海时区口径）

## @repo/web-runtime — 联网工具运行时

- **出网**：`http.ts` 是 `web-fetch` / `web-request` 的唯一出口——统一浏览器 UA、超时、字节预算、
  逐跳重定向校验，以及内网地址拦截（域名后缀 + DNS 解析结果都必须是公网，元数据地址直接拒）。
  安全边界如实说明：这不是沙箱，真要严防 SSRF 得把出网放进带出口白名单的代理。
- **HTML→Markdown**（`markdown.ts`）、**按行分页**（`pager.ts`）、**站点识别**（`sites.ts`）、
  **搜索接口**（`search.ts`）。
- 错误用 `WebToolError`（`reason` / `hint` / `retryable`），不依赖 Nest / DB；调用方翻成 `ToolOutcome`。
- 只依赖 `turndown` + `zod`，agent-runtime / main / common-capability 三处共用；业务工具不要自己 `fetch`。

## @repo/monitor — 监控引擎

指标采集 / 规则评估 / 告警生命周期 / 通知，两个服务共用的**引擎**（不含 HTTP API）：

- `engine/`：采集、指标注册、规则评估、告警生命周期与投递、清理、多实例 leader、种子、静默；
- `definitions/`：指标 / 规则声明与版本哈希、聚合与窗口；`metrics/` / `rules/`：系统指标与系统规则；
  `sources/`：telemetry / process 数据源；
- `MonitorModule.forRoot(options)` / `forRootAsync(options)`（全局模块）：配置 schema 唯一来源是
  `MonitorConfigSchema`，app-config 的 `monitor` 命名空间直接复用它；
- main 既装配引擎也提供 HTTP API（`modules/monitor/api`：管理员查询 / 配置 + 免鉴权 `/monitor/health`），
  agent-runtime 只装配引擎；两边各监控自己的进程。

## @repo/kits — 后端通用能力封装

纯能力集（**不持有任何业务实体**）。装配采用「**一个基础设施一个 NestJS module**」：
每个模块用 `XxxModule.forRoot(options)` 显式接收自己的配置分片，该配置对象即模块自己的注入 bean
（`DbConfig` / `RedisConfig` / `JwtConfig` / `PasswordConfig` / `StorageConfig` / `NotifyConfig` /
`LarkConfig` / `KafkaConfig` / `WorkspaceConfig`），不再由应用聚合成一个中央 kits 模块。所有模块均 `@Global()`，
装配进各服务的 `root.module.ts` 的 `imports`：**17 个能力目录、23 个 `XxxModule`**（`src` 下 17 个目录 + `index.ts`）：

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
    `workspace.config.ts`（`WorkspaceConfig`）+ `workspace.module.ts`（`WorkspaceModule`）。
    **这一层是本地沙箱实现，没有删**：workspace-service 的 `local` 后端、runtime / main 的 `/info`
    （部署模式与会话可选权限）都还依赖它；真正的执行面是 `apps/workspace-service`（容器 / Pod）。
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
- `http/`：横切 HTTP 构件 —— `error/`（错误码映射 / `BoundaryError` / `AppExceptionFilter` /
  `ERROR_ALERT_HOOK`）、`request-context/`（@Global 模块：ALS + 自注册中间件）、`request-logger/`、
  `request-metrics/`（@Global 模块：自注册埋点中间件）、`zod-validation.ts`、`response-envelope.interceptor.ts`、
  `ops-probe.ts`；各 app 共用一份（以前各存一份 `src/common/`）
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
| `DbModule` | `{ url?, sync?, entities?, subscribers?, poolSize? }` | DbConfig + Db + DbService |
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
| `RequestContextModule` / `RequestLoggerModule` / `RequestMetricsModule` | 无（`@Global` 纯模块，自注册中间件） | 请求上下文 ALS / 请求日志 / 请求指标（装配顺序：context 必须在 logger / metrics 之前） |

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

## @repo/capability — 能力声明机制

**只提供机制、不含具体能力**（具体能力写在服务里），是「服务侧工具」的声明与登记层：

- `@CapabilityGroup` / `@CapabilityDecl`：一个执行器类 = 一个能力组，类内一个方法一个能力；入参 zod
  内联在声明里，执行体用 `findCapabilityDecl` 取同一份校验（登记与执行不会各写一份而漂移）；
- `scanCapabilities`：启动期扫描装饰器元数据（存 `WeakMap`，不依赖 reflect-metadata），声明缺执行体 /
  工具名重复直接抛；
- `toInputSchema`：zod → JSON Schema（模型看到的就是它）；`toRegistration`：服务定义 → 登记结构；
- `CapabilityRegistrar`：登记 + 10s 心跳 + 停机注销的生命周期编排，网关客户端以**最小接口**注入
  （HTTP 细节归 `@repo/internal-sdk`，本包不反向依赖它）。

依赖 `@repo/contracts`；使用方是 common-capability / workspace-service 等服务进程。

## @repo/contracts — 跨 app 契约

跨服务边界的数据结构（只依赖 `zod`，是最底层之一）：`capability`（能力接入协议 v1：服务 / 工具 / 实例
命名规则、登记、目录、调用结论）、`tool`（内部工具调用的身份 / 入参 / 结论）、`registry`（工具 worker
注册快照）、`workspace`（工作区执行契约：后端 `local|container|microvm`、desired_status、ensure / exec / fs）、
`model-gateway`（网关内部契约：线路协议枚举、canonical 对话体、模型目录、网关用量与就绪探针）。调用方与被调方
共用这一份，不要在各自服务里再写一遍。

## @repo/http-client — 通用 HTTP + 鉴权管线

业务无关的客户端基础设施，被 `@repo/sdk` 的 `ServerClient` 继承使用，也被 `@repo/internal-sdk` 复用它
的底层传输（依赖方向：`sdk → http-client → shared`）。

`HttpClient`（基于原生 fetch）的请求管线：

```
skipAuth 检查
  → CredentialResolver.resolve()（凭证校验 / acquire / refresh，并发去重）
  → AuthInjector.inject()（按 AuthStrategy 注入 headers / query / body）
  → cancelPrevious（相同在途请求去重，latest wins）
  → fetch() 发送请求
  → 错误处理：401 + 可刷新 → forceRefresh 重试一次；其余统一抛 ApiError
```

- 认证策略：`BearerToken` / `ApiKey` / `OAuth2` / `HMAC`
- 凭证管理器：`localStorage` / `memory` / `cookie` / `env`
- 凭证供应器：`empty-check` / `expires-at`（配合 OAuth2 自动续期）
- 流式：`HttpStreamClient`（SSE 请求 + 断线状态机 + `StreamParser`）+ 低层 `HttpTransport`
  （原始响应 / SSE 透传 / NDJSON）
- 错误：统一 `ApiError`（可 JSON 序列化），区分网络异常与业务异常

## @repo/sdk — 前端 / 服务端 SDK

- `ServerClient extends HttpClient`：按业务分组的全类型化方法，**15 个分组**——`config` / `auth` / `admin` /
  `user` / `share`（分享创建 / 列表 / 撤销 / 公开 meta）/ `storage` / `monitor` / `agent`（`chat` / `conversation` /
  `file` / `run` / `timeline` / `queue` / `usage*`，含 `file.workspace` / `file.adminList` / `file.adminStats` /
  `file.adminPreview`、`conversation.setFileAccess`）/ `aiModel` / `aiTool` / `aiSkill`（技能库增删改查 +
  文件读写 + 链接导入）/ `aiMemory` / `capabilityService`（能力服务登记 / 探活 / 拉 MCP 清单 +
  `listGrants` / `setGrants` 服务授权）/ `workspace`（工作区 CRUD / start / stop）/ `session`；
  `createStream()` 建 SSE 长连接，`chatStreamUrl()` / `resumeStreamUrl()` / `currentRunStreamUrl()` 给 AI SDK
  transport 用；请求 / 响应类型全部来自 `@repo/shared`。**没有** `aiConnector` 分组（2026-11-18 已删除，
  接外部系统改走能力服务 + MCP）。
- `createAppClients()`（`packages/sdk/src/app-clients.ts`）：前端装配浏览器单例 / 服务端无状态客户端 / 凭证读写，
  应用只注入 `tokenKey`、两端地址与 401 善后

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

## @repo/internal-sdk — 内网服务客户端

服务间调用的统一入口（只给后端用）：`requestJson` / `requestEnvelope` 收口 URL 拼接、`x-internal-token`
令牌、超时 / 取消合并、非 2xx 映射、响应契约校验；错误分 5 类（超时 / 取消 / 传输 / API / 协议）。
四个客户端一一对应内网服务：

- `AgentRuntimeClient`：runtime 的 `status` / `list` / `tools` / `instructions`（main 的目录代理用）
- `CapabilityGatewayClient`：服务 `register` / `deregister` / `heartbeat` / 状态、`listServices`、
  `discoverMcp`、`listCapabilities` / `invoke`、任务 `get` / `cancel`
- `ModelGatewayClient`：模型 `catalog`、`listProviderModels`、`testProvider`、`health`
- `WorkspaceServiceClient`：工作区 `ensure` / `stop` / `destroy` / `status` / `exec` / `fs`

依赖 `contracts` / `shared` / `http-client`；重试不在这里做（是否重试取决于调用是否幂等，交调用方决定）。

## @repo/ui — 前端组件库

- `src/components/ui/*`：**61 个**基础组件（shadcn 风格，按 Base UI 实现）；
- `src/components/ai-elements/*`：**48 个** AI 界面组件（另有 `markdown-fences/` 辅助目录）；
- 自有业务组件在 `src/components/*` 平铺（DataTable / DataList / ModalForm / Markdown / Storage 系列等，
  清单见 [frontend.md](./frontend.md)）；
- **设计系统唯一定义处是 `packages/ui/src/globals.css`**（`@theme inline` 颜色 token 映射，明暗对称；
  组件质感规则与字体回退链同文件），并由 `test/tokens.test.ts` 与 `pnpm check:ui` 的不变量守住；
- 子路径：`@repo/ui`、`@repo/ui/action`、`@repo/ui/components/ui/command`、`@repo/ui/globals.css`、`@repo/ui/*`。
