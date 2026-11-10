# 架构与项目结构

> 这一篇回答「东西放在哪、依赖往哪流、启动时谁先装配」。
> 方案为什么这么定，见 [design/](../design/) 下的专题；AI 能力见 [ai.md](./ai.md)。

## 项目结构

```
├── apps/
│   ├── server/                          # NestJS 12 HTTP 边界（@app/server）
│   │   ├── data-source.ts               # TypeORM CLI 迁移配置（db:generate / db:migrate）
│   │   ├── scripts/seed-admin.ts        # 首个管理员种子脚本（createApplicationContext 启动）
│   │   └── src/
│   │       ├── main.ts                  # 入口：NestFactory 启动 + app.use() 中间件 + 优雅关闭
│   │       ├── root.module.ts           # 唯一组合根：AppConfigModule + 各基础设施 forRootAsync + 业务模块
│   │       ├── app-config.ts            # 应用配置 schema（复用 kits 各模块 schema）+ mapServerEnv + loadServerAppConfig
│   │       ├── config.ts                # ServerConfig 类型（= ServerAppConfig['server']）+ resolveServerConfig(config)
│   │       ├── common/                   # 横切 HTTP 构件（按关注点分包，各有 index.ts；外部统一从 common/index.ts 导入）
│   │       │                            #   error/（错误码映射 · 边界错误 · 异常过滤器 · 告警钩子）
│   │       │                            #   request-context/（模块：ALS 上下文 · requestId 中间件）
│   │       │                            #   request-logger/（模块：请求日志中间件）
│   │       │                            #   request-metrics/（模块：请求埋点中间件）
│   │       │                            #   security/（token 与身份读取 · 限流守卫）
│   │       │                            #   http/（Zod 校验管道 · 响应信封拦截器）
│   │       ├── database/
│   │       │   ├── entities/            # 15 张表：user / admin / alert-log / monitor-alert / monitor-rule /
│   │       │   │                        #   monitor-metric-sample / conversation / run / timeline / ai-provider /
│   │       │   │                        #   ai-model / ai-tool / ai-connector / ai-usage-daily / ai-usage-daily-dimension
│   │       │   └── migrations/          # TypeORM 迁移产物
│   │       └── modules/                 # 业务模块（12 个）：auth / admin / user / session / monitor / storage / stream /
│   │                                    #   runtime-config / ai / ai-model / ai-usage / ops
│   │                                    #   每模块 module + controller + service + index（repository / errors 按需）
│   ├── web/                             # Next.js 16 前台（@app/web，端口 9840）
│   │   └── src/
│   │       ├── actions/auth.actions.ts  # Server Actions（登录 / 注册）
│   │       ├── app/                     # /、/account（个人中心，受保护）、/auth/*、/comparison、/markdown/*
│   │       │                            #   + error.tsx / not-found.tsx / loading.tsx 应用级兜底
│   │       ├── components/landing/       # 首页区块（header / hero / proof-strip / tech-marquee / ai-section /
│   │       │                            #   observability / design-showcase / maintainability / quick-start / cta / footer）
│   │       ├── lib/                     # constants / server-client（SDK 单例）/ auth-session（服务端会话探测）/ redirect（?next= 过滤）
│   │       ├── proxy.ts                 # 受保护路由守卫（无 cookie → 307 到登录页，matcher 只挂 /account/*）
│   │       └── providers/               # QueryProvider（TanStack Query + 统一错误 toast）/ WebStorageProvider（上传）
│   └── admin/                           # Next.js 16 管理后台（@app/admin，端口 9845）
│       └── src/
│           ├── actions/auth.actions.ts  # Server Actions（@repo/ui defineAction）
│           ├── app/
│           │   ├── auth/                # login / register / forgot-password / reset-password
│           │   └── main/                # dashboard / user-center / system/{users,admins}
│           │                            #   / monitor/{status,live,metrics,logs,rules}
│           │                            #   / ai/{chat,models,tools,audit,connectors}
│           ├── components/              # AppHeader / AppMenu / AppSider
│           ├── lib/                     # constants / server-client / logger
│           ├── providers/AppProviders.tsx
│           ├── stores/                  # auth.store.tsx（Zustand + Immer）/ theme.store.ts
│           └── proxy.ts                 # 中间件路由守卫（cookie）
├── packages/
│   ├── shared/                          # @repo/shared
│   │   └── src/
│   │       ├── schema/                  # Zod 共享 schema（auth / admin / user / session / stream / monitor /
│   │       │                            #   object-storage / app-config / agent / ai-model / ai-tool / ai-tool-event /
│   │       │                            #   ai-connector / base）
│   │       ├── dicts/                   # app-error-code / user-status / ai / ai-model / ai-tool / ai-tool-event /
│   │       │                            #   ai-connector / ai-capability / ai-modality 字典
│   │       ├── app-response.ts          # AppResponse 统一响应格式 + ResponseUtils
│   │       ├── logger.ts                # 日志工厂 createLogger（前后端共用；后端经 kits LoggerModule 包装成 AppLogger）
│   │       ├── browser.ts               # 浏览器端子入口
│   │       └── utils/                   # nanoid / dayjs / md5 / tree / dict / user-agent（登录设备展示用）等工具
│   ├── kits/                            # @repo/kits — 后端通用能力封装（无业务实体）
│   │   └── src/
│   │       ├── foundation/              # 横切基础：command / config / errors / id-generation / logger / scheduler / time-wheel
│   │       ├── db/                      # Db / DbService 统一入口 + DbModule：create-db / db / db.service /
│   │       │                            #   db.config / base-entity / audit-entity / audit-subscriber /
│   │       │                            #   pagination / batch / safe-delete / sql / database.module
│   │       ├── redis/                   # RedisStore / RedisLockService / RedisListCache + RedisModule
│   │       ├── rate-limit/              # RateLimiter + RateLimitModule（复用 RedisConfig）
│   │       ├── stream/                  # StreamHub / StreamConnection + StreamHubModule（SSE）
│   │       ├── jwt/                     # TokenSigner + JwtModule（JwtConfig）
│   │       ├── session/                 # SessionStore + SessionStoreModule
│   │       ├── password/                # PasswordHasher + PasswordModule（PasswordConfig）
│   │       ├── storage/                 # ObjectStorage + ObjectStorageModule + providers/{s3,cos}
│   │       ├── kafka/                   # KafkaService / @KafkaConsumer + KafkaModule（KafkaConfig）
│   │       ├── lark/                    # LarkClient + LarkModule（LarkConfig）
│   │       ├── notification/            # Notifier + file / email / lark-notify + NotificationModule
│   │       ├── telemetry/               # Telemetry + TelemetryModule
│   │       └── (每个目录)                # provider + <name>.config.ts（如需配置）+
│   │                                    #   <name>.module.ts（@Global + forRoot）+ index.ts
│   ├── http-client/                      # @repo/http-client — 通用 HTTP + 鉴权管线（业务无关）
│   │   └── src/
│   │       ├── core/                    # http.client / credential-resolver / auth-injector / api-error
│   │       ├── stream/                  # HttpStreamClient + stream-parser / stream-transport（SSE 客户端）
│   │       ├── strategies/              # BearerToken / ApiKey / OAuth2 / HMAC
│   │       ├── managers/                # localStorage / memory / cookie / env
│   │       └── providers/               # empty-check / expires-at
│   ├── sdk/                             # @repo/sdk
│   │   └── src/
│   │       └── server.client.ts         # ServerClient（全类型化业务 API，继承 http-client 的 HttpClient）
│   └── ui/                               # @repo/ui — shadcn 组件（src/components/ui/*）+ 自有组件（src/components/* 平铺）
│                                         #   + ai-elements（48 个 AI 界面组件）+ 设计系统（src/globals.css，唯一定义处）
├── docker/                              # Dockerfile.base / .server / .web + init-db.sql
├── k8s/                                 # server 的 Kubernetes 清单（Deployment / Service / PDB / Ingress + 部署说明）
├── docs/                                # guide/（使用指南）/ design/（设计文档）/ dev-logs/（开发日志）/ pagination.md / sdk-refactor.md / billy-pitch.md
├── scripts/                             # setup.ts（bootstrap）、kill-dev.ts、check-inject-decorators.ts、check-mastra-boundary.ts、check-ui.ts、codegraph-setup.ts
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## 分层与数据流

```
浏览器 ── POST JSON ──→ Next.js（Server Actions / 客户端 SDK）── POST JSON ──→ NestJS
                       （SSR）                                        │
                                                                      ├─ 业务 service ──→ PostgreSQL
                                                                      │                    (TypeORM)
                                                                      └─ 业务 service ──→ Redis / S3 / COS
```

分层规则：`apps/server`（HTTP 适配 + 业务模块 + 实体/迁移）→ `@repo/kits`（通用能力）→ 外部资源
（DB / Redis / S3 / COS）。前端通过 `@repo/sdk` 调用，请求 / 响应类型与后端共享 `@repo/shared`
的 Zod schema。

## 组合根与生命周期

组合根收敛到唯一装配点 `apps/server/src/root.module.ts`，kits 侧由「一个基础设施一个模块」分别装配：

- 每个基础设施一个 `@Global()` NestJS 模块，需要配置的都提供 `forRoot(options)` 与
  `forRootAsync(options)` 两种装配方式：`LoggerModule` / `DbModule` / `RedisModule` / `JwtModule` /
  `PasswordModule` / `ObjectStorageModule` / `NotificationModule` / `LarkModule` / `KafkaModule`；
  `RateLimitModule` / `StreamHubModule` / `SessionStoreModule` 复用上游模块的配置 bean
  （RedisConfig / JwtConfig / IdGeneration），`IdGenerationModule` / `TelemetryModule` /
  `SchedulerModule` 无配置；模块内部 `Schema.parse(...)` 校验 + 补默认值，**配置对象本身就是该模块的
  注入 bean**（`DbConfig` / `RedisConfig` / `JwtConfig` / `PasswordConfig` / `StorageConfig` /
  `NotifyConfig` / `LarkConfig` / `KafkaConfig`）
- **配置链路（惰性规则）**：`AppConfigFacade.initial({ schema, loader })` 在
  `NestFactory.create` **之前**完成「加载 → 校验 → 补默认值 → 缓存」；
  `schema` 是应用自定义的 shape（zod），`loader` 决定来源（内置 `env` / `memory` / `consul`，
  或自定义实例 / `registerConfigLoader` 注册的名字）；`AppConfigModule.forRoot()` 用
  `ConfigModule.forRoot({ isGlobal: true, load: [() => AppConfigFacade.getConfig()] })` 把它接进 Nest；
  各模块用 `forRootAsync` 的 `useFactory` 惰性取分片。**不要在 `root.module.ts` 顶层直接读配置值** ——
  ESM 下 `import { RootModule }` 的装饰器求值早于 `main()` 里的配置加载，顶层读会拿到空配置
- **按需装配**：某基础设施不 import 即视为未启用（如不 import `KafkaModule` 就没有 Kafka 客户端）；
  可选依赖用 `@Optional()` 优雅降级（未装配 `LarkModule` 时 `LarkNotifyClient` 自动「未配置」）
- **应用级业务配置**：`apps/server/src/config.ts` 只导出 `ServerConfig` 类型（= `ServerAppConfig['server']`）
  与 `resolveServerConfig(config)`；守卫 / service / 控制器注入全局 `ConfigService` 后调它取 `server` 分片
  （端口 / 鉴权开关 / 限流白名单等），**无需额外的配置 bean / 模块**
- `apps/server/src/main.ts`：只用 `NestFactory.create(RootModule, { bodyParser: false })` 启动，
  再 `app.enableCors()` / 设置请求体上限，不承担业务注册职责；请求上下文 / 请求日志 / 请求指标
  中间件由 `common/` 的 `RequestContextModule` / `RequestLoggerModule` / `RequestMetricsModule`
  **自注册**（`forRoutes('*')`，均标 `@Global()`，且 `RequestContextModule` 必须排在最前）
- 生命周期由 Nest 驱动：组件实现 `OnApplicationBootstrap` / `OnApplicationShutdown`，
  装配完成后按 providers 声明顺序启动（Db 初始化、Redis 连接、ObjectStorage 建桶 / 客户端），
  `app.close()` 时逆序释放资源
- 业务模块在 `root.module.ts` 的 `imports` 注册，各自的 repository / service 在自己模块的
  `providers` 声明；实体是类引用、无法来自环境变量，由组合根在 `DbModule.forRootAsync` 的
  `useFactory` 里补 `entities: [...]`（其余 `db` 配置仍来自应用配置）

## 分页

`packages/kits/src/db/pagination.ts` 提供四种分页策略（构建在 TypeORM QueryBuilder 之上）：

- **`pageWith`** — 单表 `LIMIT/OFFSET` 页码分页，返回 `total/page/size`
- **`pageWithDeferred`** — 两阶段 Offset 分页：先主键分页，再按主键加载详情，适合复杂联表表格
- **`cursorPageWith`** — 单表 Seek/Cursor 分页（复合键），适合无限滚动与持续新增的数据流
- **`cursorPageWithDeferred`** — 两阶段 Cursor 分页：先定位主键与 cursor，再查询当页 JOIN 数据

项目约定：后台 `DataTable` 默认普通分页，滚动 `DataList` 默认 Cursor 分页；一对多 JOIN 或重聚合
查询优先使用对应的 Deferred 方法。完整原理、SQL、索引与选型指南见
[分页设计指南](../pagination.md)。

## 数据操作统一入口（DbService）

业务代码里**注入 `DbService`**（`packages/kits/src/db/db.service.ts`，由 `DbModule` 装配、`@Global`），
它把 kits 的数据能力收成统一入口，方法面与 rihel-base 的 `DBService` 对齐且是其超集：

```ts
constructor(@Inject(DbService) private readonly dbService: DbService) {}

// 分页
await this.dbService.pageWith(builder, page, size)            // 页码分页
await this.dbService.pageWithDeferred({ selectIds, fetchIds, idCol, page, size })
await this.dbService.cursorPageWith(builder, { cursorColumns, getCursor, size })
await this.dbService.cursorPageWithDeferred(builder, { ... })

// 批量
await this.dbService.batchInsert(UserEntity, rows)            // 默认 manager
await this.dbService.batchSave(rows)
await this.dbService.batchUpsert(UserEntity, rows, ['sku'])
await this.dbService.batchDelete(UserEntity, { selectIds })
await this.dbService.safeDelete(UserEntity, { id })           // 操作人默认取当前身份
await this.dbService.getFullSqlStatement(builder)             // 返回完整 SQL，要打日志自己打
```

它比裸函数少传两个到处都有的参数——**默认 manager**（`Db.dataSource.manager`）与
**默认操作人**（`getAuditUser()`，即 `setAuditUserProvider` 挂的钩子，与 `AuditSubscriber` 同源）。
内核仍是可单测的纯函数（`db/pagination.ts` / `db/batch.ts` / `db/safe-delete.ts` / `db/sql.ts`），
脱离 DI 时直接用：

| 纯函数 | 说明 |
| --- | --- |
| `pageWith` / `pageWithDeferred` | 页码分页 / 两阶段页码分页（先主键后回表）；后者即 rihel 的 `multiplePageWith` |
| `cursorPageWith` / `cursorPageWithDeferred` | 游标分页 / 两阶段游标分页（billy 多出的能力） |
| `batchInsert` | 每片一条 `INSERT ... VALUES (...)`，不触发实体钩子、不级联，最快 |
| `batchSave` | 走 `manager.save`，触发钩子与级联（每条一次 SELECT 判断增改，较慢） |
| `batchUpsert` | `INSERT ... ON CONFLICT DO UPDATE`，需传 `conflictPaths` |
| `batchDelete` | 先按 `selectIds` 取主键，再分片 `DELETE ... WHERE id IN (...)` |
| `batch` | 底层骨架，自定义批量更新 / 复杂批量逻辑时直接复用 |
| `safeDelete` | 先写 `deletedBy` 再软删（顺序颠倒会被软删的 UPDATE 覆盖） |
| `getFullSqlStatement` | 把占位符还原成完整 SQL，仅用于调试输出 |

两条硬约定：

1. **事务内自动串行** —— `manager.queryRunner.isTransactionActive` 为真时并发度降为 1，
   避免争用同一连接与事务快照。**事务方法内要显式传事务的 `manager`**，否则会落到根 manager 上脱离事务。
2. **部分失败不静默** —— 任一分片失败不阻断其余分片，结束后聚合抛 `BatchOperationError`，
   携带失败分片数与原始异常。
