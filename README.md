# Billy

> 一套基于 NestJS 12、TypeScript 与 Next.js 16 的全栈应用 Monorepo 模板。
> 后端采用「NestJS 薄边界 + 业务模块（apps/server）+ 通用能力封装 @repo/kits（一个基础设施一个 NestJS module，
> 各自 `XxxModule.forRoot(options)` / `forRootAsync(options)` 显式接收自己的配置，配置对象即该模块的注入 bean）」；
> 配置由 `AppConfigFacade` 在 bootstrap 前用 Zod 统一加载校验，再经 `@nestjs/config` 的 `ConfigService` 惰性下发，
> 前端提供两套独立入口：Web 与 Admin，统一使用 `@repo/ui`（Base UI + shadcn/ui）与 Tailwind 4。

## 技术栈

```
apps/
├── server   — NestJS 12 HTTP 边界 + 业务模块 + 组合根（端口 9989）
├── web      — Next.js 16 App Router + Base UI + shadcn/ui + Tailwind 4（端口 9840）
└── admin    — Next.js 16 App Router + @repo/ui + TanStack Query/Table/Form + Zustand（端口 9845）
packages/
├── shared   — Zod schemas + 错误码字典 + 响应工具 + Pino 日志 + 通用工具（前后端共享）
├── kits     — 后端通用能力封装：Db / Redis / JWT / ObjectStorage / 消息 / 调度 / 推送 / 限流 / 分页（一个基础设施一个 module，无业务实体）
├── http-client — 通用 HTTP + 鉴权管线客户端（HttpClient / HttpStreamClient / 策略 / 凭证管理器，业务无关）
├── sdk      — ServerClient（全类型化业务 API 调用，构建在 @repo/http-client 之上）
└── ui       — Base UI + shadcn 风格共享组件库（Tailwind 4），含 DataTable / ModalForm / 存储组件等管理端组件
```

| 层         | 选型                       | 理由                                        |
| ---------- | -------------------------- | ------------------------------------------- |
| 构建系统   | pnpm + Turbo               | monorepo 依赖管理 + 按拓扑任务编排 |
| 服务端框架 | NestJS 12（Express 5）     | 模块化 HTTP 边界，业务模块归 apps/server，通用能力归 @repo/kits |
| 依赖注入   | NestJS 内建 DI             | `@Injectable` / `@Inject`（@nestjs/common）+ 构造器注入 |
| API 层     | POST JSON（NestJS Controller） | Zod 边界校验 + 全类型化 SDK               |
| ORM        | TypeORM                    | 装饰器实体 + Repository + QueryBuilder      |
| 前端框架   | Next.js 16 App Router      | RSC + SSR + Server Actions                  |
| 后台 UI    | @repo/ui + @tanstack/react-table / react-form | DataTable（tanstack 表格）/ ModalForm 声明式表单开箱即用 |
| 前台 UI    | Base UI + shadcn/ui        | 无样式原语 + 可定制组件，Tailwind 4 驱动    |
| 状态管理   | Zustand + Immer（admin）   | 轻量、不可变、无 boilerplate                |
| 服务端状态 | TanStack Query             | 查询缓存 / 失效 / 重试                      |
| 样式       | Tailwind 4                 | 原子化 CSS，零心智负担                      |
| 日志       | 自建 logger（createLogger） | 不用 nestjs-pino：kits 建唯一 pino 实例；`AppLogger` 供业务注入、`NestLoggerAdapter` 接管框架日志；请求日志由 app 中间件记录；开发 pino-pretty，生产 JSON 或推 Loki |
| 缓存       | Redis（ioredis）           | Set / List / Hash / PubSub / 分布式锁       |
| 异步消息   | Kafka（kafkajs）           | 生产者 `KafkaService.send` / 消费者 `@KafkaConsumer`；按 `KAFKA_BROKERS` 按需装配 |
| 服务端推送 | SSE（StreamHub + HttpStreamClient） | 实时推送：AI 流式 / 任务进度 / 通知，Redis pub/sub 跨实例广播 |
| 对象存储   | S3 / COS                   | 预签名 URL + 临时凭证（STS）                |
| 构建工具   | tsdown（ui 除外）          | 快速 bundler；shared / kits / http-client / sdk 产出 dts，@repo/ui 源码直出（exports 指向 `./src/*`，不参与构建） |
| 容器化     | Docker multi-stage         | server + web 独立部署，compose 一键起依赖   |

## 快速开始

### 前置条件

- Node.js >= 20（推荐 24，Docker 基础镜像使用 24.14.1）
- pnpm >= 11（`corepack enable && corepack prepare pnpm@11.15.0 --activate`）
- PostgreSQL（可用 `docker compose up postgres` 一键启动）
- Redis（compose 一键起在宿主 `6380`；`.env` 未配置时默认连接 `localhost:6379`。Redis 连接在应用启动（NestJS `OnApplicationBootstrap`）时建立，未启动会导致服务启动失败）
- MinIO / S3 / COS（可选，仅存储模块需要；未配置对象存储相关环境变量时使用默认值）

### 安装

```bash
pnpm install
```

### 一键初始化（推荐）

```bash
pnpm bootstrap
```

自动完成：环境检查 → Docker 依赖服务（postgres / redis / minio）→ 生成三份 `.env`
（`apps/server/.env` / `apps/admin/.env` / `apps/web/.env.local`）→ 安装依赖 → 执行迁移
→ 创建管理员种子 → 冒烟验证 API。交互式逐步确认，也支持非交互：

```bash
pnpm bootstrap -y             # 全默认（非交互，适合 CI / 脚本）
pnpm bootstrap --skip-docker  # 跳过 Docker 依赖启动（自行保证 pg / redis 可用）
pnpm bootstrap --skip-install # 跳过依赖安装
pnpm bootstrap --skip-migrate # 跳过迁移与种子
pnpm bootstrap --skip-seed    # 跳过管理员种子创建
pnpm bootstrap --skip-smoke   # 跳过冒烟验证
```

> 端口约定与 `docker-compose.yaml` 宿主端口一致：**PostgreSQL 15432 / Redis 6380 / MinIO 19000**
> （容器内仍为 5432 / 6379 / 9000）。若本机已有 5432 / 6379 服务，改 `.env` 回默认端口即可。

### 环境变量（手动）

`pnpm bootstrap` 会自动从模板生成，也可手动复制：

```bash
cp apps/server/.env.example apps/server/.env
cp apps/admin/.env.example apps/admin/.env
cp apps/web/.env.local.example apps/web/.env.local
```

`apps/server/.env` 关键项（完整模板见 `apps/server/.env.example`）：

```env
PORT=9989
DB_URL=postgresql://root:pg1234@localhost:15432/billy-cli  # compose 宿主端口 15432；本机 pg 为 5432
REDIS_URL=redis://localhost:6380/0                         # compose 宿主端口 6380；本机 redis 为 6379
JWT_SECRET=dev-secret-change-in-production                 # 生产务必替换
AUTH_ENABLED=true                                          # false 关闭鉴权（clone 自用）
OBJECT_STORAGE_ENDPOINT=http://localhost:19000             # compose MinIO 宿主端口 19000
```

`apps/web/.env.local` 与 `apps/admin/.env` 使用默认值即可（不配置时代码有默认值兜底）。

### 数据库

```bash
# 生成迁移文件（写入 apps/server/src/database/migrations/）
pnpm db:gen Initial

# 执行迁移
pnpm db:migrate
```

### 启动（开发）

```bash
# 终端 1：并行 watch 构建 packages（shared / kits / http-client / sdk；@repo/ui 源码直出，无需构建）
pnpm dev:pkgs

# 终端 2：启动 NestJS 服务（http://localhost:9989）
pnpm dev:server

# 终端 3：启动 Web 前台（http://localhost:9840）
pnpm dev:web

# 终端 4（可选）：启动 Admin 后台（http://localhost:9845）
pnpm dev:admin
```

### 构建与启动（生产）

```bash
# 全量构建（turbo，按依赖拓扑）
pnpm build

# 分别启动
pnpm start:server
pnpm start:web

# 或 Docker Compose（postgres + redis + minio + server + web）
pnpm docker:up
```

## 代码生成器（pnpm cli）

仓库内嵌脚手架生成器（`scripts/cli/`），交互式生成 workspace 模板，模板文件为
`.eta`（eta 模板引擎，见 `scripts/cli/templates/files/`）：

```bash
pnpm cli                     # 交互式选择模板类型
pnpm cli -t crud -n product --no-install  # 非交互生成 CRUD 业务模块（type / name / install 都给全才不追问）
```

四种模板类型：

| 类型 | 说明 | 生成位置 |
| --- | --- | --- |
| `package` | 通用 TypeScript 包（tsdown 构建） | `packages/<name>/` |
| `client` | Next.js 前端应用（@repo/ui 技术栈） | `apps/<name>/` |
| `service` | NestJS 服务端应用骨架（main.ts + root.module.ts + lib/http.ts + config.ts + data-source.ts） | `apps/<name>/` |
| `crud` | NestJS + TypeORM 业务模块（实体 / repository / service / controller / module / errors / schema） | `apps/server/src/modules/<name>/` 等 |

**crud 生成后的手动步骤**（生成器会打印完整清单）：

1. 在 `apps/server/src/root.module.ts` 的 `imports` 里加入 `<Xxx>Module`；
2. 同文件 `DbModule.forRootAsync({ ... useFactory: (config) => ({ ...config.get('db'), entities: [...] }) })` 的 `entities` 里加入新实体（配置值来自 `src/app-config.ts` 的 `serverAppConfigSchema` / `mapServerEnv`）；
3. `packages/shared/src/dicts/app-error-code.dict.ts` 3xxx 段加 `XxxNotFound` 错误码；
4. `packages/shared/src/schema/index.ts` 导出新 schema；
5. `pnpm db:gen Xxx` 生成迁移 + `pnpm db:migrate` 执行；
6. `packages/sdk/src/server.client.ts` 补 `xxx` 段类型化 SDK 方法；
7. 按 `develop-frontend-page` 规范开发 admin 页面并加入 `apps/admin/src/components/AppMenu.tsx` 菜单。

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
│   │       │   ├── entities/            # 业务实体：UserEntity / TodoEntity / AdminEntity / AlertRuleEntity / AlertLogEntity
│   │       │   └── migrations/          # TypeORM 迁移产物
│   │       └── modules/                 # 业务模块：auth / admin / user / todo / monitor / storage / stream / runtime-config
│   │                                    #   每模块 module + controller + service + index（repository / errors 按需）
│   ├── web/                             # Next.js 16 前台（@app/web，端口 9840）
│   │   └── src/
│   │       ├── actions/auth.actions.ts  # Server Actions（登录 / 注册）
│   │       ├── app/                     # /、/auth/*（登录 / 注册 / 忘记密码 / 重置密码）、/comparison、/markdown/*
│   │       ├── components/landing/       # 首页区块（header / hero / features / choice / architecture / ...）
│   │       ├── lib/                     # constants / server-client（SDK 单例）/ auth-session（服务端会话探测）
│   │       └── providers/QueryProvider.tsx  # TanStack Query
│   └── admin/                           # Next.js 16 管理后台（@app/admin，端口 9845）
│       └── src/
│           ├── actions/auth.actions.ts  # Server Actions（@repo/ui defineAction）
│           ├── app/
│           │   ├── auth/                # login / register / forgot-password / reset-password
│           │   └── main/                # dashboard / todo / user-center / system/{users,admins} / monitor/{rules,logs} / automation
│           ├── components/              # AppHeader / AppMenu / AppSider
│           ├── lib/                     # constants / server-client / logger
│           ├── providers/AppProviders.tsx
│           ├── stores/                  # auth.store.tsx（Zustand + Immer）/ theme.store.ts
│           └── proxy.ts                 # 中间件路由守卫（cookie）
├── packages/
│   ├── shared/                          # @repo/shared
│   │   └── src/
│   │       ├── schema/                  # Zod 共享 schema（auth / admin / user / todo / object-storage）
│   │       ├── dicts/                   # app-error-code / user-status 错误码与字典
│   │       ├── app-response.ts          # AppResponse 统一响应格式 + ResponseUtils
│   │       ├── logger.ts                # 日志工厂 createLogger（前后端共用；后端经 kits LoggerModule 包装成 AppLogger）
│   │       ├── browser.ts               # 浏览器端子入口
│   │       └── utils/                   # nanoid / dayjs / md5 / tree / dict 等工具
│   ├── kits/                            # @repo/kits — 后端通用能力封装（无业务实体）
│   │   └── src/
│   │       ├── foundation/              # 横切基础：config / errors / id-generation / logger / scheduler / time-wheel
│   │       ├── db/                      # Db / DbService 门面 + DbModule：create-db / db / db.service /
│   │       │                            #   db.config / base-entity / audit-entity / audit-subscriber /
│   │       │                            #   pagination / batch / safe-delete / sql / database.module
│   │       ├── redis/                   # RedisStore / RedisLockService / RedisListCache + RedisModule
│   │       ├── rate-limit/              # RateLimiter + RateLimitModule（复用 RedisConfig）
│   │       ├── stream/                  # StreamHub / StreamConnection + StreamHubModule（SSE）
│   │       ├── jwt/                     # TokenSigner + JwtModule（JwtConfig）
│   │       ├── session/                 # SessionStore + SessionModule
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
│   └── ui/                              # @repo/ui — shadcn 组件（src/components/ui/*）+ 自有组件（src/components/* 平铺）
├── docker/                              # Dockerfile.base / .server / .web + init-db.sql
├── docs/                                # pagination.md（分页指南）/ sdk-refactor.md / billy-pitch.md / queue.md（已废弃存档）/ design/ / dev-logs/
├── scripts/                             # cli.ts / cli/（生成器 + .eta 模板）、setup.ts（bootstrap）、kill-dev.ts、check-inject-decorators.ts、check-scaffold-templates.ts
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## Apps 详解

### apps/server — NestJS 12 HTTP 边界

`apps/server` 只做四件事：接收请求、Zod 校验、调用业务 service、映射错误。业务逻辑位于
`apps/server/src/modules/`（实体与迁移在 `src/database/`），通用能力位于 `@repo/kits`。

- **配置链路**：`src/app-config.ts` 的 `serverAppConfigSchema` **直接复用 kits 各模块的配置 schema** 组成
  命名空间（`server` / `monitor` / `db` / `redis` / `jwt` / `password` / `storage` / `logger` / `notify` /
  `lark?` / `kafka?`），`mapServerEnv(env)` 负责环境变量 → 嵌套配置；`main.ts` 与 `seed-admin.ts` 首行
  `await loadServerAppConfig()` 完成加载 + 校验 + 补默认值（`AppConfigFacade` 缓存）。该函数内部只声明
  **来源**：`AppConfigFacade.initial({ schema: serverAppConfigSchema, loader: envConfigLoader({ envFileName: '.env', mapEnv: mapServerEnv }) })`
  —— 换来源（如 Consul / Nacos）只改 `loader` 这一项，配置 shape 与各模块装配完全不变。
  除「可选模块是否装配」的两个开关（`LARK_APP_ID` / `KAFKA_BROKERS`）外，`src/` 内不再直读 `process.env`。
- **组合根**：`root.module.ts` 是唯一组合根，`imports` 首项为 `AppConfigModule.forRoot()`（把已加载配置接进
  Nest：全局 `ConfigService` + `AppConfig` bean），随后是无配置的基础能力模块
  （`IdGenerationModule` / `TelemetryModule` / `SchedulerModule`）与各基础设施模块 —— 需要配置的一律用
  `forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config) => config.get('<命名空间>') })`
  **惰性**取自己的分片（`LoggerModule` / `DbModule` / `RedisModule` / `JwtModule` / `PasswordModule` /
  `ObjectStorageModule` / `NotificationModule`），无自有配置的直接引模块（`RateLimitModule` /
  `StreamHubModule` / `SessionModule`）；可选模块 `LarkModule` / `KafkaModule` 用展开语法按 env 是否存在决定；
  再注册各业务模块（`AuthModule` / `AdminModule` / `UserModule` / `TodoModule` / `StorageModule` /
  `StreamModule` / `MonitorModule` / `RuntimeConfigModule`）；`providers` 里用 `APP_PIPE` / `APP_FILTER` /
  `APP_INTERCEPTOR` 注册全局管道、过滤器与拦截器。
- **入口**：`main.ts` 用 `NestFactory.create<NestExpressApplication>(RootModule, { bodyParser: false })`
  启动，只做引导与全局 Express 配置（`app.enableCors()`、请求体上限 2mb）；请求级横切中间件
  （`RequestContextModule` 的请求上下文 ALS / `RequestMetricsModule` 的请求埋点）由模块自注册。
- **业务模块目录**：`modules/<业务>/{module,controller,service,repository,errors,index}.ts`；
  controller 只做 HTTP 边界（Zod 校验 + 调 service + 返回数据），业务逻辑仍在 service / repository。
  `monitor` 的 `MonitorHealthController` 提供免鉴权 `POST /monitor/health`；`admin` 的
  `AdminAuthController` 提供免鉴权的 `login` / `logout`。
- **校验与响应**：请求体用 `@Body({ schema: Schema })` 参数装饰器校验，控制器只返回业务数据，由
  `ResponseEnvelopeInterceptor` 统一包成 `{ code: 0, data }`，异常统一由 `AppExceptionFilter` 处理；
  全部路由 POST 且显式标注 `@HttpCode(200)`（Nest 对 POST 默认 201）。
- **守卫**：`UserAuthGuard` / `AdminAuthGuard` / `RateLimitGuard`（配合 `@RateLimit({ scope })`
  方法装饰器，超限抛 `BoundaryError` 并带 `Retry-After` 响应头）。
- **SSE 推流**：`modules/stream/stream.controller.ts` 的 `StreamController` 暴露 `POST /sse/subscribe`
  长连接（Bearer / cookie 认证，强制注册 `user:{userId}` 身份频道），业务模块经 `StreamHub.publish(channel, event)`
  推流，多实例经 Redis pub/sub 跨实例广播（`sse.md` 设计文档，客户端为 `@repo/http-client` 的 `HttpStreamClient`）。
- **请求上下文 / 请求日志**：`common/request-context/request-context.ts` 基于 `AsyncLocalStorage`，跨中间件与业务调用
  传递 `userId` / `adminId`，避免参数透传；`common/request-context/request-context.middleware.ts` 生成 `requestId`
  并写入 `X-Request-Id` 响应头。请求日志由 **`common/request-logger` 的 `RequestLoggerMiddleware` 记录**
  （method / url / statusCode / durationMs / requestId / userId / adminId），按状态码分级
  （<400 info / 4xx warn / 5xx error），日志 `requestId` 与响应头同值；业务侧不要自写请求日志。
- **优雅关闭**：`program()` 监听 SIGINT / SIGTERM，`await app.close()`（Express 适配器先排空在途请求，
  再执行 `OnApplicationShutdown` 释放 DB / Redis / Kafka 等连接）。

### apps/web — Next.js 16 前台

面向 C 端的前台应用，使用 **Base UI + shadcn/ui**（来自 `@repo/ui`）与 Tailwind 4。

- 页面：`/`（首页）、`/auth/*`（登录 / 注册 / 忘记密码 / 重置密码）、`/comparison`（竞品调研）、`/markdown/*`（Markdown 渲染示例）
- Server Actions（`actions/auth.actions.ts`）封装登录 / 注册 / 忘记密码 / 重置密码 / 登出，token 写入 httpOnly cookie
- `lib/server-client.ts`：浏览器端单例（`LocalStorageCredentialsManager` 管理 token，baseUrl 走 `NEXT_PUBLIC_SERVER_URL`）+ 服务端无状态客户端（`MemoryCredentialsManager` + 显式传入 token，baseUrl 走运行时 `SERVER_URL`）；httpOnly cookie 在 `lib/auth-session.ts` 读取
- `providers/QueryProvider.tsx` 注入 TanStack Query
- `app/layout.tsx` 标记 `force-dynamic`：前端根 layout 统一动态渲染（每次请求 SSR，不做静态预渲染）
- `next.config.ts`：`output: 'standalone'`、React Compiler、transpile `@repo/ui`

### apps/admin — Next.js 16 管理后台

面向后台的管理应用，与前台同源使用 **@repo/ui**（shadcn/ui 风格），表格用
**@tanstack/react-table**（`DataTable`）、表单用 **@tanstack/react-form**
（`ModalForm` / `DrawerForm` / `FormRenderer` 声明式 items），适合表格 / 表单 / 权限类页面。
登录使用**后台管理员**账号（`AdminEntity`，`/admin/*` 接口），与前台用户体系隔离。

- 页面：`/auth/login`（管理员登录）、`/main/dashboard`、`/main/todo`、`/main/user-center`、
  `/main/system/users`、`/main/system/admins`（管理员管理）、`/main/monitor/rules`（告警规则）、
  `/main/monitor/logs`（告警记录）、`/main/automation`（自动化演示）
- 布局：`AppHeader` + `AppSider` + `AppMenu`；根 `app/layout.tsx` 与 `main/layout.tsx` 均标记
  `force-dynamic`（前者让前端根 layout 统一动态渲染，后者在 SSR 侧通过 cookie 调用
  `admin.getMe()` 做鉴权，失败 `redirect()` 到登录页）
- 路由守卫：`proxy.ts` 中间件按 `PublicPaths` + cookie 判断，未登录访问非公开页时 `redirect()` 到登录页（不对已登录用户做反向重定向）
- Server Actions：`@repo/ui/action` 的 `defineAction` / `callAction` 统一返回
  `{ ok, data } | { ok: false, error }` 结构，简化错误处理
- 状态管理：Zustand + Immer（`auth.store` 保存 `adminInfo` / `theme.store` 保存主题），
  `main/layout.tsx` SSR 预取管理员信息
- 首个管理员：`pnpm seed:admin`（默认 `admin@billy.local / admin123`，可用
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` 覆盖），随后可在「系统设置 → 管理员管理」中维护

## Packages 详解

### @repo/shared — 前后端共享层

Zod schema 单一事实源，同时派生 TypeScript 类型（`*.schema.ts` 导出 `XxxModel` / `XxxDto`）：

- **契约命名（硬性）**：schema 常量一律 `XxxSchema` 结尾（值后缀）；入参类型 `XxxDto`、响应类型
  `XxxModel`（类型后缀），两者 `z.infer` 导出在**同一文件**、紧贴其 schema；`z.enum` 值域 schema
  （如 `AdminStatusSchema` / `AlertLevelSchema`）只导出 schema，不建类型别名；`base.schema.ts` 的
  `BaseModelSchema` / `BasePaginateSchema` / `BaseCursorPaginateSchema` 只作 `extend` / `intersection`
  基石，不导出类型。
- `schema/`：auth / admin / user / todo / stream（SSE 事件与订阅）/ monitor（告警规则、日志、健康检查）/
  object-storage / app-config / base（模型与分页、游标基类）
- `dicts/`：`app-error-code.dict.ts`（错误码字典：`value` + `http` + `label`，业务抛错、server 映射、
  前端文案共用同一份定义）、`user-status.dict.ts`
- `app-response.ts`：`AppResponse<T>` / `AppPageQueryResponse<T>` / `AppCursorQueryResponse<T>` 与
  `ResponseUtils`（`success` / `error` / `isSuccess`）
- `logger.ts`：日志工厂 `createLogger(name, pretty, level, { redact, transport })`，
  开发环境 pretty 彩色、生产 JSON（**前后端共用**：后端 kits `LoggerModule` 也用它，见下文「日志」）
- 子入口：`@repo/shared/browser`（浏览器端安全导出）、`@repo/shared/logger`（前端日志）
- `utils/`：nanoid / dayjs / md5 / tree / dict / file / zod 等通用工具

### @repo/kits — 后端通用能力封装

纯能力集（**不持有任何业务实体**）。装配采用「**一个基础设施一个 NestJS module**」：
每个模块用 `XxxModule.forRoot(options)` 显式接收自己的配置分片，该配置对象即模块自己的注入 bean
（`DbConfig` / `RedisConfig` / `JwtConfig` / `PasswordConfig` / `StorageConfig` / `NotifyConfig` /
`LarkConfig` / `KafkaConfig`），不再由应用聚合成一个中央 kits 模块。所有模块均 `@Global()`，
装配进 `apps/server/src/root.module.ts` 的 `imports`：

- `db/`：`create-db.ts`（PostgreSQL DataSource 工厂，实体由应用注入）、`db.ts`（`Db`：连接生命周期门面）、
  `db.service.ts`（`DbService`：**注入式数据操作门面**——四种分页 / 批量写入与删除 / 软删 /
  SQL 还原；只依赖 `Db`，不注入 logger，
  自动带默认 manager 与当前操作人。纯函数是内核，本类只是把它接进容器，
  见下文「批量写入」）、`db.config.ts`（`DbConfig`）、`database.module.ts`（`DbModule`）、
  `pagination.ts`（四种分页策略，见下文「分页」）、
  `batch.ts`（`batch` 分片 + 并发骨架 / `batchInsert` / `batchSave` / `batchUpsert`，
  事务内自动串行）、`safe-delete.ts`（`safeDelete`：先写 `deletedBy` 再软删）、
  `sql.ts`（`getFullSqlStatement`：占位符还原成完整 SQL，仅调试）、
  `base-entity.ts`（`BaseEntity`：`id` nanoid 主键 + `createdAt` / `updatedAt` /
  软删除 `deletedAt`）、`audit-entity.ts` + `audit-subscriber.ts`（**可选审计**：继承 `AuditEntity`
  并把 `AuditSubscriber` 放进 `db.subscribers`，自动记录 `createdBy` / `updatedBy` / `deletedBy`；
  操作人来源用 `setAuditUserProvider()` 挂载，`DbService.operatorId` 读同一个钩子）
- 各基础设施一个目录（每个目录都是 `provider + <name>.config.ts + <name>.module.ts + index.ts`）：
  - `redis/`：`redis-store.ts`（KV / TTL / JSON / 基础锁）、`redis-lock.service.ts`（自旋等待 +
    看门狗续期）、`redis-lock.decorator.ts`（`@RedisLock`）、`redis-list-cache.ts`（Hash 列表缓存）、
    `redis.config.ts`（`RedisConfig`）、`redis.module.ts`（`RedisModule`）
  - `rate-limit/`：`rate-limiter.ts`（基于 rate-limiter-flexible，IP 白名单用 `ip-utils.ts`）+
    `rate-limit.module.ts`（`RateLimitModule`，复用 `RedisConfig`）
  - `stream/`：`stream-hub.ts` / `stream-connection.ts`（SSE 推流）+ `stream-hub.module.ts`
  - `jwt/`：`token-signer.ts` + `jwt.config.ts`（`JwtConfig`）+ `jwt.module.ts`
  - `session/`：`session-store.ts` + `session.module.ts`
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
  带字段路径的校验错误）、`errors/`（AppError / InfrastructureError）、`id-generation/`（`IdGeneration` + `IdGenerationModule`）、
  `logger/`（`app-logger.ts` + `logger.config.ts` + `logger.options.ts` + `LoggerModule`）、`scheduler/`（croner + `SchedulerModule`）、
  `time-wheel/`（`TimeWheel` 进程内高频调度原语：秒级/毫秒级刻度 + 自适应补偿 + 落后任务防堆积。
  **普通类非 DI 门面**——需构造参数且天然多实例，用 `new TimeWheel(tickDuration, wheelsCount)`
  自行 `start()` / `stop()`，故无 module）
- **模块清单**（均在 `packages/kits/src` 下，全部 `@Global()`）：

| Module | forRoot 选项 | 提供的 bean |
| --- | --- | --- |
| `AppConfigModule` | `forRoot()` 无选项（前置：bootstrap 先 `await AppConfigFacade.initial({ schema, loader })`） | AppConfig（整份已加载配置）+ 全局 `ConfigService` |
| `IdGenerationModule` / `SchedulerModule` / `TelemetryModule` | 无 | IdGeneration / Scheduler / Telemetry |
| `LoggerModule` | `{ prefix?, level?, pretty?, loki? }` | LoggerConfig + LOGGER_INSTANCE + AppLogger + NestLoggerAdapter |
| `DbModule` | `{ url?, sync?, entities?, subscribers? }` | DbConfig + Db + DbService |
| `RedisModule` | `{ url?, keyPrefix? }` | RedisConfig + RedisStore + RedisLockService |
| `RateLimitModule` | 无（复用 RedisConfig） | RateLimiter |
| `StreamHubModule` | 无（复用 RedisConfig + IdGeneration） | StreamHub |
| `JwtModule` | `{ secret?, expiresIn? }` | JwtConfig + TokenSigner |
| `SessionModule` | 无（复用 JwtConfig + RedisStore） | SessionStore |
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

### apps/server 业务模块

业务三层（module + controller + service + repository + errors）位于
`apps/server/src/modules/{auth,admin,user,todo,monitor,storage,stream,runtime-config}`，
实体 / 迁移位于 `apps/server/src/database/`（`data-source.ts` 供 `db:generate` / `db:migrate`），
横切 HTTP 构件位于 `apps/server/src/common/`：

```
modules/                       # 业务领域（每个模块同目录：module + controller + service + repository + errors + index）
├── auth/           # auth.service.ts（register/login/logout/forgot/reset/change-password/getMe/verifyToken）
│                   #   + auth.controller.ts + user-auth.guard.ts + errors
├── admin/          # admin.service.ts（后台管理员 login/logout/getMe/CRUD/resetPassword/changePassword/verifyToken）
│                   #   + admin.repository.ts + admin.controller.ts + admin-auth.guard.ts + errors
│                   #   token 带 type='admin'，与前台用户隔离
├── user/           # user.service.ts + user.repository.ts + user.controller.ts + errors
├── todo/           # todo.service.ts + todo.repository.ts + todo.controller.ts + errors
├── monitor/        # MonitorHealthController（免鉴权 /monitor/health）+ MonitorController + 告警规则 / 记录
├── storage/        # storage.controller.ts（预签名 URL / STS 临时凭证）
├── stream/         # stream.controller.ts + stream-auth.guard.ts + stream.options.ts（SSE_ROUTE_OPTIONS）
└── runtime-config/ # RuntimeConfigController（公开 POST /config/get）+ RuntimeConfigModule
│                   #   目录名与类名刻意区别于 kits 的 AppConfigModule
common/                        # 横切 HTTP 构件（不依赖业务模块；外部统一从 common/index.ts 导入）
├── error/       # error-descriptor.ts（错误码 → HTTP/中文）+ boundary-error.ts + app-exception.filter.ts + error-alert-hook.ts
├── request-context/   # 模块：request-context.ts（ALS：requestId/userId/adminId）+ request-context.middleware.ts + request-context.module.ts
├── request-metrics/   # 模块：request-metrics.middleware.ts（注入 Telemetry，采 QPS/耗时）+ request-metrics.module.ts
├── security/    # authentication.ts（token 提取 / 当前身份）+ rate-limit.guard.ts（@RateLimit + RateLimitGuard）
└── http/        # zod-validation.ts（`@Body({ schema })` 校验管道）+ response-envelope.interceptor.ts（响应信封）
database/
├── entities/     # UserEntity / TodoEntity / AdminEntity / AlertRuleEntity / AlertLogEntity（继承 @repo/kits 的 BaseEntity）
└── migrations/   # TypeORM 迁移产物
```

**使用方式（应用组合根 `apps/server/src/root.module.ts`）：**

> 下面只给骨架，省略了 `RequestContextModule` / `RequestLoggerModule` / `RequestMetricsModule`
> （三者顺序有铁律，见上文）与完整实体列表；实际装配以 `apps/server/src/root.module.ts` 为准。

```ts
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import {
  AppConfigModule,
  DbModule,
  IdGenerationModule,
  JwtModule,
  LoggerModule,
  NotificationModule,
  ObjectStorageModule,
  PasswordModule,
  RateLimitModule,
  RedisModule,
  SchedulerModule,
  SessionModule,
  StreamHubModule,
  TelemetryModule,
} from '@repo/kits'
import {
  AppExceptionFilter,
  ResponseEnvelopeInterceptor,
  createZodValidationPipe,
} from './common/index.js'
import { TodoEntity } from './database/entities/todo-entity.js'
import { TodoModule } from './modules/todo/index.js'

@Module({
  imports: [
    // 应用配置：bootstrap 已 await loadServerAppConfig()，这里接进 Nest（全局 ConfigService + AppConfig bean）
    AppConfigModule.forRoot(),
    // 基础能力（无配置）
    IdGenerationModule,
    TelemetryModule,
    SchedulerModule,
    // 基础设施：配置由 ConfigService 惰性解析（模块装饰器求值早于配置加载，不能顶层直读）
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
        // 实体是类引用，无法来自环境变量，由组合根补上
        entities: [TodoEntity],
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
    // 业务模块在 imports 注册（模块内 providers 声明自己的 repository / service）
    TodoModule,
  ],
  providers: [
    { provide: APP_PIPE, useFactory: createZodValidationPipe },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class RootModule {}
```

对应 `apps/server/src/main.ts` 的启动顺序（配置必须先于 `NestFactory.create`）：

```ts
await loadServerAppConfig()   // AppConfigFacade.initial({ schema, loader: envConfigLoader({...}) })

const app = await NestFactory.create<NestExpressApplication>(RootModule, {
  bodyParser: false,
  bufferLogs: true,
})
```

```ts
// modules/todo/todo.module.ts
@Module({
  imports: [AdminModule],
  controllers: [TodoController],
  providers: [TodoRepository, TodoService],
})
export class TodoModule {}
```

**生命周期设计：**

- 生命周期组件实现 `OnApplicationBootstrap` / `OnApplicationShutdown`（`@nestjs/common`），由 Nest 在装配完成后按 providers 声明顺序启动，`app.close()` 时逆序释放
- 各组件持有独立连接、停止期互不依赖；单个组件释放失败由框架记录，不阻断其余
- **第 6 条铁律**：项目用 `tsx`（esbuild）编译，**不产出 `design:paramtypes`**，因此**每个构造器参数必须显式写 `@Inject(token)`**，不能依赖 TypeScript 类型推断；漏写会静默注入 `undefined` 而不报错（controller / service / repository / guard / filter 一律如此）
- **开发态必须用 `node --import tsx/esm`**（`pnpm dev:server` 已内置）：`tsx` CLI 会同时挂 CJS 钩子，导致 CJS 依赖（如 `pino`、`pg`）`require('@nestjs/core')` 与 ESM `import` 拿到**两份模块实例**，`ApplicationConfig` 这类跨包 class token 对不上而启动失败；只挂 ESM 加载器即与 `node dist/main.js` 行为一致
- 例外：kits 内部对带可选数值参数的构造器（如 `Telemetry`）用 `useFactory` 显式装配；`RateLimitGuard` 用 `Reflect.getMetadata` 直接读方法元数据而不注入 `Reflector`

**设计原则：**

- 通用能力（基础设施 / 横切基础 / 数据访问）归 `@repo/kits`，业务模块与实体 / 迁移归 `apps/server`
- 统一用 `@nestjs/common` 的 `@Injectable` / `@Inject`，所有能力与业务服务都是构造器注入依赖的 class
- 错误以 `Error` 子类抛出并携带 `code`，`AppExceptionFilter` 按 `code` 映射 HTTP 错误码与文案
- DTO / Zod 校验与 HTTP 错误转换只存在于 apps/server 的 HTTP 边界
- 业务模块不 import HTTP 框架（controller / 守卫等 HTTP 构件只出现在 HTTP 边界）
- 业务错误保持原义，不包装成统一 `AppError`
- 基础设施服务隔离数据库、Redis、JWT 与对象存储等技术细节，业务层不感知具体实现
- 无装饰器反射之外的魔法，兼容 Node type-stripping / esbuild / tsdown

### @repo/http-client — 通用 HTTP + 鉴权管线

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
  （`config` / `auth` / `admin` / `user` / `todo` / `storage` / `monitor`），请求 / 响应类型全部来自 `@repo/shared`
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
const todos = await client.todo.cursorQuery({ size: 20 })
```

### @repo/ui — 共享组件库

shadcn 风格的组件实现统一在 `src/components/ui/*`（约 60 个：button / dialog / table /
sidebar / toast / chart 等），Tailwind 4 主题变量由 `globals.css` 提供。重型组件按需从子路径引入
（`@repo/ui/components/ui/command` 等）。

### @repo/ui 的管理端组件

我们自己的组件与 shadcn 分开存放：shadcn 组件在 `src/components/ui/*`，
自有组件直接平铺在 `src/components/*`（与 ui/ 平级，不混入 shadcn 目录，避免被
`shadcn add` / registry 覆盖）。在 shadcn 基础组件之上提供管理端通用组件
（全部基于 **@tanstack/react-table** 与 **@tanstack/react-form**）：

- 表格：`DataTable`（@tanstack/react-table 列定义 + 服务端分页）/ `TableActions` /
  `ConfirmAction`（AlertDialog 确认）/ `PageToolbar`
- 列表：`DataList`（react-virtuoso 游标滚动加载）
- 表单：`ModalForm` / `DrawerForm` / `FormRenderer`（@tanstack/react-form 声明式
  items：widget + required/validate 校验）/ `EditableInput`
- 存储：`StorageProvider` / `useStorage` / `ImageUpload` / `FileUpload` / `FilePreview` /
  `SortableFileList`（配合 `/storage/*` 接口）
- 展示：`DictTag` / `DisplayValue` / `DisplayRender` / `Tag` / `Icon` / `IconText` /
  `PageLoading` / `Group` / `AutoSize` 等
- `action.ts`：`defineAction` / `callAction` —— Server Action 的 `{ ok, data } | { ok: false, error }`
  包装器，与 `useDisclosure` / `usePasteFiles` / `useRect` 等 hooks

## 架构设计

### 分层与数据流

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

### 组合根与生命周期

组合根收敛到唯一装配点 `apps/server/src/root.module.ts`，kits 侧由「一个基础设施一个模块」分别装配：

- 每个基础设施一个 `@Global()` NestJS 模块，需要配置的都提供 `forRoot(options)` 与
  `forRootAsync(options)` 两种装配方式：`LoggerModule` / `DbModule` / `RedisModule` / `JwtModule` /
  `PasswordModule` / `ObjectStorageModule` / `NotificationModule` / `LarkModule` / `KafkaModule`；
  `RateLimitModule` / `StreamHubModule` / `SessionModule` 复用上游模块的配置 bean
  （RedisConfig / JwtConfig / IdGeneration），`IdGenerationModule` / `TelemetryModule` /
  `SchedulerModule` 无配置；模块内部 `Schema.parse(...)` 校验 + 补默认值，**配置对象本身就是该模块的
  注入 bean**（`DbConfig` / `RedisConfig` / `JwtConfig` / `PasswordConfig` / `StorageConfig` /
  `NotifyConfig` / `LarkConfig` / `KafkaConfig`）
- **配置链路（惰性铁律）**：`AppConfigFacade.initial({ schema, loader })` 在
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

### 认证

- JWT token，通过 `Authorization: Bearer` 或 `access-token` cookie 传递
- `UserAuthGuard`（`modules/auth/user-auth.guard.ts`）与 `AdminAuthGuard`
  （`modules/admin/admin-auth.guard.ts`）调用业务 `verifyToken`，校验通过后把 `userId` /
  `adminId` 写入 AsyncLocalStorage 请求上下文（管理员 token payload 带 `type: 'admin'`）
- 两类 token 严格隔离：用户 token 只能访问用户接口，管理员 token 只能访问 `/admin/*` 接口
- 公开接口（注册 / 登录 / 管理员登录 / 忘记密码 / 重置密码）不加 Guard
- Admin SSR 侧：`main/layout.tsx` 用 cookie 调 `getMe()`，失败 `redirect()`；`proxy.ts`
  中间件做首屏路由守卫
- Web 侧：`onUnauthorized` 回调 + Server Actions 返回 `ActionResult` 结构
- Admin 客户端：token 存 localStorage，同时写 httpOnly cookie 供 SSR 守卫使用

### API 设计

所有接口均为 `POST`（每条路由显式 `@HttpCode(200)` 固定，Nest 对 POST 默认 201，必须覆盖），
请求体由 Zod schema 校验，响应统一包装为 `AppResponse<T>`：

**成功响应：**

```json
{ "code": 0, "data": { ... } }
```

**业务异常响应：**

```json
{ "code": 1000, "message": "邮箱不存在" }
```

错误响应契约（`AppExceptionFilter` 统一映射，保持历史契约不变）：

- 校验失败：**HTTP 200** + `{ "code": 400, "message": "中文文案" }`（历史上不使用 HTTP 400，勿改）
- 路由未命中：HTTP 404 + `{ "code": 404, "message": "接口不存在" }`
- 未知错误：HTTP 500 + `{ "code": 5001, "message": "系统错误" }`
- 守卫 / 限流等边界错误：按 `BoundaryError` 携带的 HTTP 状态与响应头返回

| 路由                                 | 说明             | 鉴权 |
| ------------------------------------ | ---------------- | ---- |
| `POST /auth/register`                | 注册             | 否   |
| `POST /auth/login`                   | 登录             | 否   |
| `POST /auth/logout`                  | 登出             | 否   |
| `POST /auth/forgot-password`         | 忘记密码         | 否   |
| `POST /auth/reset-password`          | 重置密码         | 否   |
| `POST /auth/get-me`                  | 获取当前用户     | 是   |
| `POST /auth/update-info`             | 更新个人信息     | 是   |
| `POST /auth/change-password`         | 修改密码         | 是   |
| `POST /admin/login`                  | 管理员登录       | 否   |
| `POST /admin/logout`                 | 管理员登出       | 否   |
| `POST /admin/get-me`                 | 获取当前管理员   | 管理员 |
| `POST /admin/update-info`            | 更新个人信息     | 管理员 |
| `POST /admin/change-password`        | 修改密码         | 管理员 |
| `POST /admin/create`                 | 创建管理员       | 管理员 |
| `POST /admin/page-query`             | 管理员分页查询   | 管理员 |
| `POST /admin/detail`                 | 管理员详情       | 管理员 |
| `POST /admin/update`                 | 更新管理员       | 管理员 |
| `POST /admin/remove`                 | 删除管理员       | 管理员 |
| `POST /admin/reset-password`         | 重置管理员密码   | 管理员 |
| `POST /user/create`                  | 创建用户         | 管理员 |
| `POST /user/page-query`              | 用户分页查询     | 管理员 |
| `POST /user/detail`                  | 用户详情         | 管理员 |
| `POST /user/update`                  | 更新用户         | 管理员 |
| `POST /user/remove`                  | 删除用户         | 管理员 |
| `POST /user/reset-password`          | 重置用户密码     | 管理员 |
| `POST /todo/create`                  | 创建 Todo        | 管理员 |
| `POST /todo/page-query`              | Todo 页码分页    | 管理员 |
| `POST /todo/cursor-query`            | Todo 游标分页    | 管理员 |
| `POST /todo/detail`                  | Todo 详情        | 管理员 |
| `POST /todo/update`                  | 更新 Todo        | 管理员 |
| `POST /todo/remove`                  | 删除 Todo        | 管理员 |
| `POST /storage/get-presigned-url`    | 获取上传预签名 URL | 管理员 |
| `POST /storage/get-download-url`     | 获取下载预签名 URL | 管理员 |
| `POST /storage/get-temporary-credentials` | 获取 STS 临时凭证 | 管理员 |
| `POST /sse/subscribe`              | SSE 订阅（长连接推流，body `{ channels: [...] }`） | 是 |
| `POST /monitor/health`             | 健康检查（DB / Redis 探活，容器 / 云平台探针） | 否 |
| `POST /monitor/rule/create`        | 创建告警规则 | 管理员 |
| `POST /monitor/rule/page-query`    | 告警规则分页查询 | 管理员 |
| `POST /monitor/rule/detail`        | 告警规则详情 | 管理员 |
| `POST /monitor/rule/update`        | 更新告警规则 | 管理员 |
| `POST /monitor/rule/remove`        | 删除告警规则 | 管理员 |
| `POST /monitor/log/page-query`     | 告警发送记录分页 | 管理员 |
| `POST /monitor/test`               | 测试通知（手动验证通道） | 管理员 |
| `POST /config/get`                 | 公开运行配置（返回 `authEnabled`） | 否 |

> 鉴权列：**管理员** = `AdminAuthGuard`（后台管理员令牌，`/admin/*`、`/user/*`、`/todo/*`、`/monitor/*`、`/storage/*` 都是它）；
> `UserAuthGuard`（前台用户令牌）只用在 `/auth/get-me`、`/auth/update-info`、`/auth/change-password`；两者都从 Bearer / cookie 取令牌。
> `/sse/subscribe` 标「是」指 SSE 专用的 `StreamAuthGuard`（Bearer / cookie，强制订阅身份频道）。

> SSE 事件通过 `StreamHub.publish(channel, event)` 推送：业务模块 `@Inject(StreamHub)` 后
> `publish('task:42', { event: 'progress', data: {...} })`；身份频道 `user:{userId}` 自动强制订阅，
> 业务频道需在 `modules/stream/stream.module.ts` 的 `SSE_ROUTE_OPTIONS`（`{ auth, allowChannel }`）
> 注入白名单校验。

**监控告警**：`monitor` 业务模块（admin「运维监控 → 告警规则 / 告警记录」管理）——
**架构：埋点 → 聚合 → 规则评估 → 通知**。
- **埋点**（`@repo/kits` 的 `Telemetry`，任何业务一行埋点）：Counter / Gauge / 直方图
  （近似 P50/P95/P99）；框架自动埋（全局请求中间件：`request.count` / `request.duration` /
  5xx → 错误率 / QPS / P95 / P99 / 进程内存），业务自定义指标（如 `inventory.available`、
  `order.count`）业务方自行埋点。
- **规则类型**（`alert_rules` 表 `type` 字段，`AlertRuleTypeSchema`：`tech` / `business` / `metric` / `surge`，admin 配置）：
  技术事件规则（错误码 / 关键字 + **次数阈值**）、业务事件规则、指标规则（metric + 比较符 + 阈值，周期评估）、
  突变规则（环比基线，QPS 飙升 / 洪峰）。
- **触发**：技术错误（`AppExceptionFilter` + `uncaughtException`/`unhandledRejection`，后两者在
  `main.ts` 注册）匹配事件规则；`Scheduler` 周期评估 metric / surge 规则 → 经通知模块发送 →
  每次落 `alert_logs` 审计。
- **通知通道**：`file`（默认文件输出 `logs/alerts.log`，零配置开箱即用）+ `lark`（飞书）+
  `email`（SMTP），规则可选通道。
- 规则表为空时技术告警走默认兜底（文件 + 配置通道）。
- 告警配置 env：`ALERT_ENABLED`（总开关）/ `ALERT_EMAIL_TO` / `ALERT_SMTP_*` /
  `LARK_APP_ID` + `LARK_APP_SECRET` + `LARK_NOTIFY_RECEIVE_ID`（飞书）。文件通道路径取
  `NotifyConfig.file.path`（默认 `logs/alerts.log`），当前未开放 env 覆盖。设计文档：[monitor-alert.md](docs/design/monitor-alert.md)、
  [notifier.md](docs/design/notifier.md)。

**接口限流**：`/auth/login`、`/auth/register`、`/auth/forgot-password`、`/auth/reset-password`、
`/admin/login` 按 IP 固定窗口限流（默认 20 次 / 60s，超限 429 + `Retry-After`）；白名单
（env `RATE_LIMIT_WHITELIST`）豁免，`RATE_LIMIT_TRUST_PROXY=true` 时信任 `x-forwarded-for`。
其他接口按需用 `@UseGuards(RateLimitGuard)` + `@RateLimit({ scope, limit, windowSeconds })`
方法装饰器开启限流。

### 分页

`packages/kits/src/db/pagination.ts` 提供四种分页策略（构建在 TypeORM QueryBuilder 之上）：

- **`pageWith`** — 单表 `LIMIT/OFFSET` 页码分页，返回 `total/page/size`
- **`pageWithDeferred`** — 两阶段 Offset 分页：先主键分页，再按主键加载详情，适合复杂联表表格
- **`cursorPageWith`** — 单表 Seek/Cursor 分页（复合键），适合无限滚动与持续新增的数据流
- **`cursorPageWithDeferred`** — 两阶段 Cursor 分页：先定位主键与 cursor，再查询当页 JOIN 数据

项目约定：后台 `DataTable` 默认普通分页，滚动 `DataList` 默认 Cursor 分页；一对多 JOIN 或重聚合
查询优先使用对应的 Deferred 方法。完整原理、SQL、索引与选型指南见
[分页设计指南](docs/pagination.md)。

### 数据操作门面（DbService）

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
await this.dbService.batchInsert(TodoEntity, rows)            // 默认 manager
await this.dbService.batchSave(rows)
await this.dbService.batchUpsert(TodoEntity, rows, ['sku'])
await this.dbService.batchDelete(TodoEntity, { selectIds })
await this.dbService.safeDelete(TodoEntity, { id })           // 操作人默认取当前身份
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

### 日志

后端日志是**自建 logger**（`@repo/shared` 的 `createLogger`，**不再依赖 nestjs-pino**）：

- **唯一 pino 实例**：`LoggerModule` 用 `createLogger(prefix, pretty, level, { redact, transport })`
  建一个实例并以 `LOGGER_INSTANCE` 暴露。pino 的 `transport` 会为每个实例拉起 worker 线程，
  所以**只能建一次**；需要带 context 的日志一律 `child(context)` 派生；
- **框架日志与业务日志同通道**：`main.ts` 用 `NestFactory.create(RootModule, { bufferLogs: true })`
  缓冲启动期日志，随后 `app.useLogger(app.get(NestLoggerAdapter))` 接管，Nest 自身的 InstanceLoader /
  RoutesResolver 等日志经适配器落到同一个 pino 实例；
- **业务类构造器注入** `AppLogger`（`Scope.TRANSIENT` + `INQUIRER`，自动以宿主类名作 `context`）：
  `logger.log('<域>.<动作>', { id })`。不要再使用 `@Logger()` 装饰器（已删除）；
- **请求日志由 `common/request-logger` 的 `RequestLoggerMiddleware` 记录**：method / url / statusCode /
  durationMs / requestId / userId / adminId，按状态码分级（`<400` info、`4xx` warn、`5xx` error）。
  它直接从请求上下文 ALS 取身份；日志 `requestId` 即响应头 `X-Request-Id`；
- **输出目标**：开发 `pino-pretty` 彩色；生产 JSON；生产且配置 `loki` 时多目标 transport
  （`pino/file` 落盘 + `pino-loki` 推送，带 labels 与批量间隔）。注意 `pino-loki` 依赖必须声明在
  `@repo/shared`（创建 pino 实例的包），挪到 kits 会报 `unable to determine transport target`；
- **默认脱敏**：`req.headers.authorization` / `req.headers.cookie` / `res.headers["set-cookie"]`。

> `@repo/shared/logger` 现在是**前后端共用**的日志工厂：前端（`apps/admin`）直接用，
> 后端由 kits `LoggerModule` 包装成可注入的 `AppLogger` 与 `NestLoggerAdapter`。

## CLI 脚手架

`scripts/cli.ts`（`pnpm cli`）是 Billy Workspace 生成器，基于 `commander` + `@inquirer/prompts` +
`eta` 模板引擎（模板文件见 `scripts/cli/templates/files/`），可生成四类模板：

- `package` — 新 workspace 包（tsdown 构建）
- `client` — Next.js 前端应用（@repo/ui 技术栈）
- `service` — NestJS 服务端应用骨架（`main.ts` + `root.module.ts` + `app-config.ts` + `config.ts` + `data-source.ts` + `lib/http.ts` + `common/` 的请求上下文 / 请求日志 / 请求指标自注册中间件）
- `crud` — 完整 CRUD 业务模块（NestJS 实体 / repository / service / controller / module / errors / schema）

```bash
pnpm cli            # 交互式选择模板
pnpm cli --help     # 查看参数
```

生成 CRUD 后会提示手动补全：`root.module.ts` 注册模块与实体、schema 导出、错误码注册、
SDK 方法、admin 页面，并运行 `pnpm db:gen` 生成迁移。

`service` 骨架的生产级默认与 `apps/server` 对齐：请求上下文（`X-Request-Id`）/ 请求日志 /
请求指标三件自注册中间件（组合根 `imports` 内的顺序有铁律，见生成物注释）、限流模块，
以及 75s / 80s 的长连接超时默认值（前置网关场景，见「前置反向代理」一节）。

模板与工作区包的一致性由 `pnpm check:scaffold` 保证，它做三件事：汇总所有模板对
`@repo/kits` / `@repo/shared` 的具名导入、把 `service` 模板整体渲染成一套骨架做类型检查、
**真的调 CLI 生成一个 crud 模块**（并补上它提示的两个手动步骤）做类型检查。注意 tsc 读的是
packages 的 `dist` 声明，所以刚改过 packages 源码要先 `pnpm build:pkgs`（脚本会告警）。

## 脚本

| 命令                | 说明                                    |
| ------------------- | --------------------------------------- |
| `pnpm cli`          | 脚手架生成器                            |
| `pnpm dev:pkgs`     | 并行 watch 构建 packages                |
| `pnpm build:pkgs`   | 构建 packages                           |
| `pnpm dev:server`   | 启动 NestJS 开发服务器（9989，`node --watch --import tsx/esm`） |
| `pnpm dev:web`      | 启动 Web 前台（9840）                   |
| `pnpm dev:admin`    | 启动 Admin 后台（9845）                 |
| `pnpm kill:dev`     | 一键停掉全部 dev 服务（Web / Admin / Server / packages watcher；`--dry-run` 仅预览） |
| `pnpm build`        | 全量构建（turbo）                       |
| `pnpm start:server` | 启动生产 Server                         |
| `pnpm start:web`    | 启动生产 Web                            |
| `pnpm db:gen <name>`| 生成 TypeORM 迁移（写入 `apps/server/src/database/migrations/`） |
| `pnpm db:migrate`   | 执行 TypeORM 迁移                       |
| `pnpm seed:admin`   | 初始化第一个后台管理员（`admin@billy.local / admin123`，可用环境变量覆盖） |
| `pnpm docker:up`    | `docker compose up -d --build`          |
| `pnpm clean`        | 清理 node_modules / dist / 缓存         |
| `pnpm check:inject` | 守卫：构造器 `@Inject` / providers `@Injectable` 一致性检查 |
| `pnpm check:scaffold` | 守卫：脚手架模板与工作区包一致性检查（导入名 + service/crud 渲染类型检查） |

## Docker

### Compose 服务（依赖一键起）

```bash
docker compose up -d postgres redis minio   # 仅基础设施
pnpm docker:up                              # 全部（含 server + web）
docker compose --profile kafka up -d        # 追加 Kafka + 控制台（可选，默认不启动）
```

| 服务     | 镜像 / 构建             | 端口映射                    |
| -------- | ----------------------- | --------------------------- |
| postgres | postgres:17-alpine      | `15432:5432`（init-db.sql 只做库级设置，建表由迁移负责）|
| redis    | redis:7-alpine          | `6380:6379`                 |
| minio    | minio/minio             | `19000:9000` / `19001:9001` |
| server   | docker/Dockerfile.server| `9989:9989`                 |
| web      | docker/Dockerfile.web   | `3001:3001`                 |
| kafka  ¹ | confluentinc/cp-kafka:7.4.8 | `29092:29092`            |
| kafka-ui ¹ | provectuslabs/kafka-ui | `8085:8080`               |
| zookeeper ¹ | confluentinc/cp-zookeeper:7.4.8 | `22181:2181`      |

¹ 这三个服务带 `profiles: ["kafka"]`，**不指定 profile 不会启动**。启用后把服务端
`KAFKA_BROKERS` 设为 `kafka:9092`（容器内）或 `127.0.0.1:29092`（宿主机直连）；
不配置 `KAFKA_BROKERS` 时 `KafkaModule` 根本不装配，不影响其它功能。

### 镜像构建

```bash
# 先构建基础镜像（node 24.14.1 + pnpm 11.15.0 + 运维工具 bash/curl/wget/jq/tzdata）
./build-base-image.sh
# 等价于
docker build -t node24-pnpm11:1.0 -f docker/Dockerfile.base .

# 构建 server / web 镜像
docker build -t billy-server:latest -f docker/Dockerfile.server .
docker build -t billy-web:latest -f docker/Dockerfile.web .
```

### 特性

- **server**：multi-stage + `pnpm deploy --prod` 提取运行时依赖，仅携带编译产物与生产依赖，
  非 root 用户运行
- **web**：Next.js `output: 'standalone'` 模式，产物不携带源码与 devDependencies
- **基础镜像**：内置 `bash / curl / wget / jq / bind-tools / tzdata（Asia/Shanghai）` 等运维工具，
  并切换 npmmirror 镜像源

### 前置反向代理（Kong / Nginx / LB）

前面挂了网关时，有三处必须核对，否则会出现「查不到原因」的间歇性故障：

**1. keep-alive 复用竞态（间歇 502）**

Node 的 `server.keepAliveTimeout` 默认 **5s**，而 Kong 上游连接池默认
`upstream_keepalive_idle_timeout = 60s`，且它**不认**后端响应头里的 `Keep-Alive: timeout=N`
提示 —— 后端 5s 就关、网关认为 60s 内还能复用，于是网关在 **[5s, 60s] 窗口**里挑中一条正在
关闭的连接发请求 → 间歇性 `502 / upstream prematurely closed connection`。
**后端日志里查不到**（请求没到应用），很难定位。

本工程已默认 `keepAliveTimeout = 75s` / `headersTimeout = 80s`（>`KEEP_ALIVE_TIMEOUT_MS` 与
`HEADERS_TIMEOUT_MS` 可覆盖，见 `.env.example`）。规则：**每一跳里「服务端」的空闲超时必须大于
「客户端」的**，即从外到内递增，各留 5s 以上余量（LB 空闲 < Kong 客户端 keepalive；
Kong 上游空闲 60s < 后端 75s）。注意 `headersTimeout` 必须大于 `keepAliveTimeout`——
Node 对反序**不报错、静默接受**，故本项目在配置层用 `superRefine` 显式拦住（超了直接启动失败）。

**2. SSE 会被网关缓冲**

`POST /sse/subscribe` 是长连接流（默认 15s 心跳保活）。Kong 的 Route 属性
`response_buffering` 默认 `true`，会把响应缓冲后统一下发 → 流式失效 / 断续。
需在该路由（或 Service）上设 **`response_buffering = false`**；Service 的 `read_timeout`
（默认 60s）必须大于 SSE 心跳间隔。

**3. 限流与客户端 IP**

走网关必须把 `RATE_LIMIT_TRUST_PROXY=true`，否则限流按网关的 IP 计数（所有客户端共用一个
key、白名单失效）。

## Agent Skills（AI 原生开发）

工程把「怎么做」写进 skill：`.agents/skills/` 下每个 skill 是一个独立目录（标准 Agent Skills 格式，
`SKILL.md` 带 YAML frontmatter 的 `name` + `description`，大块内容拆到 `references/`），
AI 编码 Agent 按任务**按需加载**，工具无关（Claude Code / Codex / Cursor 等均可读取）。

- **最高准则**：[AGENTS.md](AGENTS.md)（8 条首要准则，先于一切 skill 与规范）；Claude Code 入口为
  [CLAUDE.md](CLAUDE.md)
- **必读入口**：`billy-dev-foundation`（分层架构、代码约定含「不重复造轮子」实现查找顺序、常用命令、标准流程）
- **共 17 个 skill**：必读 1（`billy-dev-foundation`）+ 功能 15（`define-data-structure` / `define-dict-enum` /
  `database` / `develop-business-module` / `develop-backend-api` / `develop-frontend-page` / `implement-auth` /
  `object-storage` / `concurrency` / `kafka` / `scheduler` / `stream` / `state-machine` / `write-tests` /
  `git-workflow`）+ 元 1（`manage-skills`）；完整索引见
  [`.agents/skills/README.md`](.agents/skills/README.md) 与
  [`billy-dev-foundation/references/catalog.md`](.agents/skills/billy-dev-foundation/references/catalog.md)
- **典型全链路**（`develop-business-module`）：数据结构（schema + 实体）→ 建表迁移 → 业务（repository /
  service）→ 接口（controller + 错误码）→ SDK → 前端页面
- **维护**：新增 / 修改 skill 走 `manage-skills`（目录与 frontmatter 规范、references 拆分、索引注册）；
  **代码变更后须同步受影响的 skill 与文档**

## 文档

- [docs/pagination.md](docs/pagination.md) — 分页设计指南（Offset / Cursor / Deferred 选型与实现）
- [docs/sdk-refactor.md](docs/sdk-refactor.md) — SDK 职责拆分说明（HttpClient / CredentialResolver / AuthInjector）
- [docs/design/nestjs-migration.md](docs/design/nestjs-migration.md) — 后端重构设计（删除 @repo/di、迁移 NestJS 12、kits 全面 Nest 化）
- [docs/design/backend-kits-refactor.md](docs/design/backend-kits-refactor.md) — kits 通用能力封装设计（一个基础设施一个 module）
- [docs/design/sse.md](docs/design/sse.md) — 服务端推送（SSE / StreamHub）设计
- [docs/design/monitor-alert.md](docs/design/monitor-alert.md) — 监控告警设计（规则 / 触发 / 通道）
- [docs/design/auth-session.md](docs/design/auth-session.md) — 认证与会话设计（JWT + Redis 会话）
- [docs/queue.md](docs/queue.md) — 已废弃（BullMQ 队列方案，已被 Kafka 取代，仅存档）
- [docs/billy-pitch.md](docs/billy-pitch.md) — 项目定位与竞品调研
- [docs/dev-logs/](docs/dev-logs/) — 开发日志（按日追加，记录每轮改动的背景 / 做了什么 / 验证）
