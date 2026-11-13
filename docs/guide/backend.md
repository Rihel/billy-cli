# 后端（NestJS）

> `apps/server` 的 HTTP 边界、业务模块、认证、API、日志与监控。
> 通用能力封装见 [packages.md](./packages.md)，部署见 [deployment.md](./deployment.md)。

## apps/server — NestJS 12 HTTP 边界

`apps/server` 只做四件事：接收请求、Zod 校验、调用业务 service、映射错误。业务逻辑位于
`apps/server/src/modules/`（实体与迁移在 `src/database/`），通用能力位于 `@repo/kits`。

- **配置链路**：`src/app-config.ts` 的 `serverAppConfigSchema` **直接复用 kits 各模块的配置 schema** 组成
  命名空间（`server` / `agent` / `aiModel` / `monitor` / `share` / `workspace` / `db` / `redis` / `jwt` /
  `password` / `storage` / `logger` / `notify` / `lark?` / `kafka?`），`mapServerEnv(env)` 负责环境变量 →
  嵌套配置；`main.ts` 的 `program()` 与 `seed-admin.ts` 的 `main()` 都在启动 Nest **之前**
  `await loadServerAppConfig()` 完成加载 + 校验 + 补默认值（`AppConfigFacade` 缓存）。该函数内部只声明
  **来源**：`AppConfigFacade.initial({ schema: serverAppConfigSchema, loader: envConfigLoader({ envFileName: '.env', mapEnv: mapServerEnv }) })`
  —— 换来源（如 Consul / Nacos）只改 `loader` 这一项，配置 shape 与各模块装配完全不变。
  除「可选模块是否装配」的两个开关（`LARK_APP_ID` / `KAFKA_BROKERS`）与少量运行时判断
  （如 `NODE_ENV`、从链接导入技能用的 `GITHUB_TOKEN`）外，配置统一走这份 schema，不在各处散读 `process.env`。
- **组合根**：`root.module.ts` 是唯一组合根，`imports` 首项为 `AppConfigModule.forRoot()`（把已加载配置接进
  Nest：全局 `ConfigService` + `AppConfig` bean），随后是请求级横切中间件模块
  （`RequestContextModule` / `RequestLoggerModule` / `RequestMetricsModule`，顺序有硬性要求）与无配置的
  基础能力模块（`IdGenerationModule` / `TelemetryModule` / `SchedulerModule` / `CommandModule`），再到各基础设施
  模块 —— 需要配置的一律用
  `forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config) => config.get('<命名空间>') })`
  **惰性**取自己的分片（`LoggerModule` / `DbModule` / `RedisModule` / `JwtModule` / `PasswordModule` /
  `ObjectStorageModule` / `NotificationModule` / `WorkspaceModule`），无自有配置的直接引模块
  （`RateLimitModule` / `PubSubModule` / `StreamHubModule` / `EventBusModule` / `SessionStoreModule`）；
  可选模块 `LarkModule` / `KafkaModule` 用展开语法按 env 是否存在决定；
  再注册各业务模块（`AuthModule` / `AdminModule` / `UserModule` / `SessionModule` / `StorageModule` /
  `StreamModule` / `ShareModule` / `MonitorModule` / `RuntimeConfigModule` / `AiModule` / `AiModelModule` /
  `AiUsageModule` / `OpsModule`）；`providers` 里用 `APP_PIPE` / `APP_FILTER` / `APP_INTERCEPTOR` 注册
  全局管道、过滤器与拦截器，另有一个 `ERROR_ALERT_HOOK` 工厂把 `MonitorEngine` 适配成 common 层的
  告警钩子 token（避免 HTTP 边界层反向依赖业务模块）。
- **入口**：`main.ts` 用 `NestFactory.create<NestExpressApplication>(RootModule, { bodyParser: false })`
  启动，只做引导与全局 Express 配置（`app.enableCors()`、关闭 `x-powered-by`、请求体上限 2mb、
  `keepAliveTimeout` / `headersTimeout` 取 `server` 配置分片）；请求级横切中间件
  （`RequestContextModule` 的请求上下文 ALS / `RequestLoggerModule` 的请求日志 /
  `RequestMetricsModule` 的请求埋点）由模块自注册。
- **业务模块目录**：`modules/<业务>/{module,controller,service,repository,errors,index}.ts`；
  controller 只做 HTTP 边界（Zod 校验 + 调 service + 返回数据），业务逻辑仍在 service / repository。
  `monitor` 的 `MonitorHealthController` 提供免鉴权 `POST /monitor/health`；`ops` 的 `OpsController`
  提供免鉴权根路径 `GET /healthz` / `GET /readyz` / `GET /info`（k8s 探针用，见「API 设计」的 GET 例外）；
  `admin` 的 `AdminAuthController` 提供免鉴权的 `login` / `logout`。
- **校验与响应**：请求体用 `@Body({ schema: Schema })` 参数装饰器校验，控制器只返回业务数据，由
  `ResponseEnvelopeInterceptor` 统一包成 `{ code: 0, data }`，异常统一由 `AppExceptionFilter` 处理；
  全部**业务**路由 POST 且显式标注 `@HttpCode(200)`（Nest 对 POST 默认 201）；GET 只留给运维探针、
  浏览器 `EventSource` 的 AI 运行重连（`/agent/run/stream`、`/agent/run/:runId/stream`）与
  `GET /agent/file/workspace-content`（见「API 设计」）。
- **守卫**：`UserAuthGuard` / `AdminAuthGuard` / `AnyAuthGuard`（任一身份通过，基于
  `common/security/any-of-guards.ts`）/ `RateLimitGuard`（配合 `@RateLimit({ scope })`
  方法装饰器，超限抛 `BoundaryError` 并带 `Retry-After` 响应头）。
- **SSE 推流**：`modules/stream/stream.controller.ts` 的 `StreamController` 暴露 `POST /sse/subscribe`
  长连接（Bearer / cookie 认证），`SSE_ROUTE_OPTIONS` 当前配 `auth: 'both'`（前台用户订阅 `user:{userId}`、
  管理员订阅 `admin:{adminId}` 并自动叠加 `admin:all` 广播频道），业务模块经 `StreamHub.publish(channel, event)`
  推流，多实例经 kits 的 `PubSub`（Redis pub/sub）跨实例广播（[sse.md](../design/sse.md) 设计文档，
  客户端为 `@repo/http-client` 的 `HttpStreamClient`）。
- **请求上下文 / 请求日志**：`common/request-context/request-context.ts` 基于 `AsyncLocalStorage`，跨中间件与业务调用
  传递 `userId` / `adminId`（登录时另把 `ip` / `userAgent` 写进会话元数据，供登录设备列表展示），避免参数透传；
  `common/request-context/request-context.middleware.ts` 生成 `requestId` 并写入 `X-Request-Id` 响应头。
  请求日志由 **`common/request-logger` 的 `RequestLoggerMiddleware` 记录**
  （method / url / statusCode / durationMs / requestId / userId / adminId），按状态码分级
  （<400 info / 4xx warn / 5xx error），日志 `requestId` 与响应头同值；业务侧不要自写请求日志。
- **优雅关闭**：`program()` 监听 SIGINT / SIGTERM，`await app.close()`（`StreamHub` 先推 `stream.shutdown`
  并关闭全部 SSE 长连接，Express 适配器再排空在途请求，最后执行 `OnApplicationShutdown` 释放 DB / Redis /
  Kafka 等连接）；超过 `server.shutdownTimeoutMs`（默认 25s）强制退出，避免进程挂到
  `terminationGracePeriodSeconds` 被 SIGKILL 而留不下日志。

## apps/server 业务模块

业务三层（module + controller + service + repository + errors）位于
`apps/server/src/modules/{auth,admin,user,session,monitor,storage,stream,share,ai,ai-model,ai-usage,runtime-config,ops}`（13 个），
实体 / 迁移位于 `apps/server/src/database/`（`data-source.ts` 供 `db:generate` / `db:migrate`），
横切 HTTP 构件位于 `apps/server/src/common/`：

```
modules/                       # 业务领域（每个模块同目录：module + controller + service + repository + errors + index）
├── auth/           # auth.service.ts（register/login/logout/forgot/reset/change-password/getMe/verifyToken）
│                   #   + auth.controller.ts + user-auth.guard.ts + any-auth.guard.ts + errors
├── admin/          # admin.service.ts（后台管理员 login/logout/getMe/CRUD/resetPassword/changePassword/verifyToken）
│                   #   + admin.repository.ts + admin.controller.ts + admin-auth.guard.ts + errors
│                   #   token 带 type='admin'，与前台用户隔离
├── user/           # user.service.ts + user.repository.ts + user.controller.ts + errors
├── monitor/        # api/ MonitorController + MonitorHealthController（免鉴权 /monitor/health）
│                   #   + definitions/（代码里的指标 / 规则定义与版本哈希）
│                   #   + engine/（采集 · 规则评估 · 告警生命周期 · 投递 · 清理 · 多实例 leader）
│                   #   + metrics/ · rules/（系统指标与系统规则）+ sources/（telemetry / process）+ config.ts
├── storage/        # storage.controller.ts（预签名 URL / STS 临时凭证）+ storage-key.ts（key 前缀策略）
├── stream/         # stream.controller.ts + stream-auth.guard.ts + stream.options.ts（SSE_ROUTE_OPTIONS）
├── share/          # 文件免授权分享（create/list/revoke + 公开 meta + 内部 resolve）+ share.token.ts
├── ops/            # OpsController（根路径 GET /healthz、/readyz、/info，运维探针的 GET 例外）+ OpsModule
├── session/        # 多设备会话管理（登录设备列表 / 踢下线）
├── ai/             # 会话 / 运行 / 时间线 / 工具面 / 技能 / 文件 / 恢复 / 连接器
│                   #   api/ HTTP 边界（/agent/*、/ai-tool/*）；runtime/ 上下文 · 流式 · 恢复 · 用量；
│                   #   core/tools 注册机与网关；core/skills 与 skills/ 技能库；files/ 会话工作区文件；
│                   #   tools/ 内建工具组；connectors/ 连接器目录与驱动（sql / redis / lark-cli）；
│                   #   agents/ · mastra/ 适配 · monitoring/ 观测
├── ai-model/       # 供应商与模型配置（后台配置即生效，运行时只用配过的模型）
├── ai-usage/       # 每日用量汇总 + 定时 rollup（按模型 / 按 agent）
└── runtime-config/ # RuntimeConfigController（公开 POST /config/get）+ RuntimeConfigModule
│                   #   目录名与类名刻意区别于 kits 的 AppConfigModule
common/                        # 横切 HTTP 构件（不依赖业务模块；外部统一从 common/index.ts 导入）
├── error/       # error-descriptor.ts（错误码 → HTTP/中文）+ boundary-error.ts + app-exception.filter.ts + error-alert-hook.ts
├── request-context/   # 模块：request-context.ts（ALS：requestId/userId/adminId）+ request-context.middleware.ts + request-context.module.ts
├── request-logger/    # 模块：request-logger.middleware.ts（请求日志：状态码分级 + 身份）+ request-logger.module.ts
├── request-metrics/   # 模块：request-metrics.middleware.ts（注入 Telemetry，采 QPS/耗时）+ request-metrics.module.ts
├── security/    # authentication.ts（token 提取 / 当前身份）+ rate-limit.guard.ts（@RateLimit + RateLimitGuard）
│                #   + any-of-guards.ts（AnyAuthGuard 的「任一身份通过」编排）
└── http/        # zod-validation.ts（`@Body({ schema })` 校验管道）+ response-envelope.interceptor.ts（响应信封）
│                #   + ops-probe.ts（探针路径判定：请求日志 / 指标据此跳过探针）
database/
├── entities/     # 19 张表，全部继承 @repo/kits 的 BaseEntity / AuditEntity：
│                 #   用户与后台（user / admin）、监控（monitor-rule / monitor-alert / monitor-metric-sample / alert-log）、
│                 #   AI（conversation / run / timeline / ai-provider / ai-model / ai-tool / ai-connector /
│                 #   ai-file / ai-skill / ai-skill-file / ai-usage-daily / ai-usage-daily-dimension）、
│                 #   分享（file-share）
└── migrations/   # TypeORM 迁移产物
```

**使用方式（应用组合根 `apps/server/src/root.module.ts`）：**

> 下面只给骨架，省略了 `RequestContextModule` / `RequestLoggerModule` / `RequestMetricsModule`
> （三者顺序有先后规定，见 [架构文档](./architecture.md) 的「组合根与生命周期」）与完整实体列表；
> 实际装配以 `apps/server/src/root.module.ts` 为准。

```ts
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import {
  AppConfigModule,
  CommandModule,
  DbModule,
  EventBusModule,
  IdGenerationModule,
  JwtModule,
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
  TelemetryModule,
  WorkspaceModule,
} from '@repo/kits'
import {
  AppExceptionFilter,
  ResponseEnvelopeInterceptor,
  createZodValidationPipe,
} from './common/index.js'
import { UserEntity } from './database/entities/user-entity.js'
import { UserModule } from './modules/user/index.js'

@Module({
  imports: [
    // 应用配置：bootstrap 已 await loadServerAppConfig()，这里接进 Nest（全局 ConfigService + AppConfig bean）
    AppConfigModule.forRoot(),
    // 基础能力（无配置）
    IdGenerationModule,
    TelemetryModule,
    SchedulerModule,
    CommandModule,
    // 工作区运行时：执行环境（沙箱 / 非沙箱）的选择与探测
    WorkspaceModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('workspace')!,
    }),
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
        entities: [UserEntity],
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
    // 业务模块在 imports 注册（模块内 providers 声明自己的 repository / service）
    UserModule,
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
// modules/user/user.module.ts
@Module({
  imports: [AdminModule],
  controllers: [UserController],
  providers: [UserRepository, UserService],
  exports: [UserRepository, UserService],
})
export class UserModule {}
```

**生命周期设计：**

- 生命周期组件实现 `OnApplicationBootstrap` / `OnApplicationShutdown`（`@nestjs/common`），由 Nest 在装配完成后按 providers 声明顺序启动，`app.close()` 时逆序释放
- 各组件持有独立连接、停止期互不依赖；单个组件释放失败由框架记录，不阻断其余
- **第 6 条规定**：项目用 `tsx`（esbuild）编译，**不产出 `design:paramtypes`**，因此**每个构造器参数必须显式写 `@Inject(token)`**，不能依赖 TypeScript 类型推断；漏写会静默注入 `undefined` 而不报错（controller / service / repository / guard / filter 一律如此）
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

## 认证

- JWT token，通过 `Authorization: Bearer` 或身份对应的 cookie 传递（前台 `access-token` / 后台
  `admin-access-token`，两者名不同以免同域部署时互相覆盖）；payload 带
  `jti`（唯一 id，`TokenSigner.sign` 显式写入）—— 否则同一秒内重复登录会签出**逐字节相同**的
  token，服务端会话按 `sha256(token)` 主键会把两台设备合并成一条
- `UserAuthGuard`（`modules/auth/user-auth.guard.ts`）与 `AdminAuthGuard`
  （`modules/admin/admin-auth.guard.ts`）调用业务 `verifyToken`，校验通过后把 `userId` /
  `adminId` 写入 AsyncLocalStorage 请求上下文（管理员 token payload 带 `type: 'admin'`）；
  `AnyAuthGuard`（`modules/auth/any-auth.guard.ts`，编排在 `common/security/any-of-guards.ts`）
  依次尝试两个守卫，任一通过即放行，用于「双端都要开放」的能力
- 两类 token 的**身份体系**严格隔离（用户 token 不会获得管理员身份、反之亦然），但接口鉴权分四类：
  仅管理员（`/admin/*` 的受保护路由、`/user/*`、`/monitor/*`、`/ai-model/*`、`/ai-tool/*`、
  `/ai-connector/*`、`/ai-skill/*`、`/agent/usage/*`、`/agent/file/admin/*`）、仅前台用户
  （`/auth/get-me`、`/auth/update-info`、`/auth/change-password`）、任一身份（`AnyAuthGuard`：
  `/storage/*`、`/session/*`、`/sse/*`、`/share/{create,list,revoke}`、`/agent/*` 的其余接口）、
  内部密钥（`POST /share/resolve` 只给 Next 内容路由调，靠 `x-share-internal` 头里的
  `SHARE_INTERNAL_SECRET`，而不是用户 token）
- 公开接口（注册 / 登录 / 登出 / 忘记密码 / 重置密码 / 管理员登录与登出 / `POST /config/get` /
  `POST /monitor/health` / `POST /share/meta`）不加 Guard
- Admin SSR 侧：`components/AdminAuthBoundary.tsx`（`main` 与 `(standalone)` 两棵布局共用）用 cookie
  调 `getMe()`，失败 `redirect()`；`proxy.ts` 中间件做首屏路由守卫（`api` 与分享页 `s/` 在 matcher 排除名单里）
- Web 侧：Server Actions 用 `@repo/ui/action` 的 `defineAction` 统一 `{ ok, data | error }` 结果约定（两个前端同一套）
- Admin 客户端：token 存 localStorage，同时写 httpOnly cookie 供 SSR 守卫使用
- **登录设备（会话管理）**：会话写入 Redis 时带 `sessionId` / `ip` / `userAgent` / 时间；
  `POST /session/list`（标出 `current`）与 `POST /session/remove`（按 `sessionId` 幂等下线），
  前台用户与管理员共用（`AnyAuthGuard`）。入口：web `/account/sessions`、admin 个人中心。
  设计见 [docs/design/session-management.md](../design/session-management.md)

## API 设计

所有**业务**接口均为 `POST`（每条路由显式 `@HttpCode(200)` 固定，Nest 对 POST 默认 201，必须覆盖），
请求体由 Zod schema 校验，响应统一包装为 `AppResponse<T>`：

> **GET 例外只有三类**：
> 1. 运维探针 `GET /healthz`、`GET /readyz`、`GET /info` —— k8s 的 `httpGet` 探针**只会发 GET**，
>    业务路由全 POST 会让探针 404、pod 永远不就绪，故为探针开放 GET；
> 2. AI 运行重连 `GET /agent/run/stream`、`GET /agent/run/:runId/stream` —— 浏览器 `EventSource`
>    只能发 GET（首次对话仍走 `POST /agent/chat/stream`）；
> 3. `GET /agent/file/workspace-content` —— 浏览器直取工作区文件流：`<img>` / `<video>` / `<iframe>`
>    带不上 `Authorization`，改按身份读 cookie；实现 Range 分段（206）与 `Content-Disposition`。
> 两个周期性探针路径（`/healthz`、`/readyz`）会被请求日志与请求指标跳过
> （`common/http/ops-probe.ts`）：否则每 3s 一条日志刷屏，并把探针自身的 503 算进
> `request.error`，污染错误率告警。

**成功响应：**

```json
{ "code": 0, "data": { ... } }
```

**业务异常响应：**

```json
{ "code": 1000, "message": "邮箱不存在" }
```

错误响应格式（`AppExceptionFilter` 统一映射，保持历史格式不变）：

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
| `POST /auth/get-me`                  | 获取当前用户     | 用户 |
| `POST /auth/update-info`             | 更新个人信息     | 用户 |
| `POST /auth/change-password`         | 修改密码         | 用户 |
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
| `POST /storage/get-presigned-url`    | 获取上传预签名 URL（前台用户 key 被改写进 `user/{userId}/`） | 用户 / 管理员 |
| `POST /storage/get-download-url`     | 获取下载预签名 URL（前台用户仅限自己前缀，越界 403） | 用户 / 管理员 |
| `POST /storage/get-temporary-credentials` | 获取 STS 临时凭证（整桶权限，前台身份在控制器内拒绝） | 管理员 |
| `POST /session/list`                 | 登录设备列表（含 `current` 标记） | 用户 / 管理员 |
| `POST /session/remove`               | 下线指定设备（按 `sessionId`，幂等） | 用户 / 管理员 |
| `POST /sse/subscribe`              | SSE 订阅（长连接推流，body `{ channels: [...] }`） | 是 |
| `GET /healthz`                     | 存活探针（livenessProbe，**不探外部依赖**，进程活着即 200） | 否 |
| `GET /readyz`                      | 就绪探针（readinessProbe，探 DB / Redis，不可用返回 **503** + `code: 5002` 主动摘流） | 否 |
| `GET /info`                        | 运行信息（版本 / 运行时 / 已生效的长连接超时 / 工作区执行环境与沙箱能力） | 否 |
| `POST /monitor/health`             | 健康检查（DB / Redis 探活，容器 / 云平台探针） | 否 |
| `POST /monitor/rule/definitions`   | 规则定义清单（代码注册的规则 + 默认值 / 可配字段 / 定义版本） | 管理员 |
| `POST /monitor/rule/list`          | 规则实例列表（当前配置与开关） | 管理员 |
| `POST /monitor/rule/update`        | 更新规则实例配置 | 管理员 |
| `POST /monitor/rule/reset`         | 恢复规则默认配置（清掉人工覆盖） | 管理员 |
| `POST /monitor/alert/page-query`   | 告警记录分页 | 管理员 |
| `POST /monitor/alert/detail`       | 告警详情（命中快照 + 各通道投递记录） | 管理员 |
| `POST /monitor/metric/definitions` | 指标定义清单（raw / derived） | 管理员 |
| `POST /monitor/metric/series`      | 指标时序（按窗口 / 维度） | 管理员 |
| `POST /monitor/metric/latest`      | 指标最新值（多指标 / 维度筛选） | 管理员 |
| `POST /monitor/engine/status`      | 引擎状态（实例 / leader / 槽位 / 指标新鲜度 / 规则最近评估与触发） | 管理员 |
| `POST /monitor/log/page-query`     | 告警发送记录分页 | 管理员 |
| `POST /monitor/test`               | 测试通知（手动验证通道） | 管理员 |
| `POST /config/get`                 | 公开运行配置（返回 `authEnabled`） | 否 |
| `POST /share/create`               | 生成文件分享链接（token 只存哈希，可设过期时间） | 用户 / 管理员 |
| `POST /share/list`                 | 某个文件的历史分享记录（不含 token） | 用户 / 管理员 |
| `POST /share/revoke`               | 撤销分享（写 `revoked_at`，状态派生） | 用户 / 管理员 |
| `POST /share/meta`                 | 公共分享元信息（分享页 SSR 用，按 token + 限流） | 否 |
| `POST /share/resolve`              | 内部解析 token 换预签名地址（仅 Next 内容路由调用） | 内部密钥 |
| `POST /agent/status`               | AI 能力状态（可用性 / 默认模型 / 模型数 / agent 数） | 用户 / 管理员 |
| `POST /agent/list`                 | agent 清单 | 用户 / 管理员 |
| `POST /agent/instructions`         | 系统指令原文（带 `conversationId` 取会话快照，否则取静态定义） | 用户 / 管理员 |
| `POST /agent/models`               | 本轮可选模型（只回供应商 + 模型都启用的） | 用户 / 管理员 |
| `POST /agent/chat`                 | 一轮问答（非流式，落库后返回） | 用户 / 管理员 |
| `POST /agent/chat/stream`          | 发起一轮对话（SSE 流式，唯一不套信封的对话接口） | 用户 / 管理员 |
| `POST /agent/chat/resume`          | 回答挂起中的一轮（`ask-user-questions` 后续跑，SSE） | 用户 / 管理员 |
| `POST /agent/run/stop`             | 停止某一轮（本进程 abort，否则广播） | 用户 / 管理员 |
| `GET /agent/run/stream`            | 重连当前运行（SSE，`EventSource` 只能 GET） | 用户 / 管理员 |
| `GET /agent/run/:runId/stream`     | 重连指定运行（SSE） | 用户 / 管理员 |
| `POST /agent/conversation/create`  | 新建会话 | 用户 / 管理员 |
| `POST /agent/conversation/list`    | 会话列表 | 用户 / 管理员 |
| `POST /agent/conversation/detail`  | 会话详情 | 用户 / 管理员 |
| `POST /agent/conversation/rename`  | 会话重命名（记一条时间线事件） | 用户 / 管理员 |
| `POST /agent/conversation/file-access` | 切换会话文件权限（只读 / 可写） | 用户 / 管理员 |
| `POST /agent/conversation/remove`  | 软删会话（唯一的删除入口） | 用户 / 管理员 |
| `POST /agent/run/list`             | 运行列表（含子 agent，审计与复盘） | 用户 / 管理员 |
| `POST /agent/run/detail`           | 运行详情（输入快照 / 上游错误 / 子 agent） | 用户 / 管理员 |
| `POST /agent/usage/summary`        | 用量汇总（按模型 / 按 agent） | 管理员 |
| `POST /agent/usage/rollup`         | 手动触发用量 rollup | 管理员 |
| `POST /agent/timeline/list`        | 会话时间线查询 | 用户 / 管理员 |
| `POST /agent/file/workspace-link`  | 工作区文件换临时 OSS 链接（前端直取，不经后端转发） | 用户 / 管理员 |
| `POST /agent/file/workspace`       | 右栏工作区文件清单（不含内容） | 用户 / 管理员 |
| `POST /agent/file/preview`         | 文本 / HTML 预览（会话文件或工作区文件） | 用户 / 管理员 |
| `GET /agent/file/workspace-content` | 工作区内容流（图片 / PDF / 音视频 / 下载，cookie 身份 + Range） | 用户 / 管理员 |
| `POST /agent/file/admin/list`      | 后台文件页：跨会话全量列表 | 管理员 |
| `POST /agent/file/admin/preview`   | 后台文件页：任意会话的文本预览 | 管理员 |
| `POST /agent/file/admin/stats`     | 后台文件页：文件量统计 | 管理员 |
| `POST /ai-model/provider/{list,create,detail,update,remove,sync,test}` | 模型供应商配置 | 管理员 |
| `POST /ai-model/model/{list,create,update,remove}` | 模型配置 | 管理员 |
| `POST /ai-tool/{list,detail,update,reset}` | 工具配置（开关 / 作用域 / 限额 / 配置值 / 密钥） | 管理员 |
| `POST /ai-tool/workspace`          | 执行环境能力（只读探测：沙箱是否可用 / 允许哪些文件权限） | 管理员 |
| `POST /ai-connector/{catalog,list,create,update,detail,test,sync,remove}` | 连接器实例 | 管理员 |
| `POST /ai-skill/{list,detail,create,update,remove}` | 技能库增删改查（DB 为事实源，落盘给 Mastra） | 管理员 |
| `POST /ai-skill/file/{read,save,remove}` | 技能文件读写删（`SKILL.md` 不允许删） | 管理员 |
| `POST /ai-skill/import/preview`    | 导入预览（链接里有哪些技能、哪些已存在） | 管理员 |
| `POST /ai-skill/import`            | 从链接导入技能（skills.sh / GitHub / Markdown） | 管理员 |

> 表中带 `{...}` 的行是同一前缀下的一组路由，成员已逐一列出；展开后 **115 条**，与 16 个
> controller 的 `@Post` / `@Get` 一一对应。

> 鉴权列：**管理员** = `AdminAuthGuard`（后台管理员令牌；`/admin/*` 的受保护路由、`/user/*`、
> `/monitor/*`、`/ai-model/*`、`/ai-tool/*`、`/ai-connector/*`、`/ai-skill/*`、`/agent/usage/*`、
> `/agent/file/admin/*` 都是它；`/storage/get-temporary-credentials` 在控制器里额外拒绝前台身份）；
> **用户** = `UserAuthGuard`（前台用户令牌，只用在 `/auth/get-me`、`/auth/update-info`、
> `/auth/change-password`）；**用户 / 管理员** = `AnyAuthGuard`（两套身份任一通过，身份分域由
> 调用方读请求上下文自行判断）；**内部密钥** = `/share/resolve` 的 `x-share-internal`。
> 前三种身份都从 Bearer / 对应 cookie 取令牌。
> `/sse/subscribe` 标「是」指 SSE 专用的 `StreamAuthGuard`（Bearer / cookie，按通过的身份订阅
> `user:{id}` / `admin:{id}` 并叠加 `admin:all` 广播频道）。

> SSE 事件通过 `StreamHub.publish(channel, event)` 推送：业务模块 `@Inject(StreamHub)` 后
> `publish('task:42', { event: 'progress', data: {...} })`；身份频道 `user:{userId}` / `admin:{adminId}`
> 自动订阅，业务频道需在 `modules/stream/stream.module.ts` 的 `SSE_ROUTE_OPTIONS`
> （`{ auth, broadcastChannels, allowChannel }`）注入白名单校验（当前 `allowChannel` 全拒，
> 只放行身份频道与 `admin:all`）。

**监控告警**：`monitor` 业务模块（admin「运维监控」的 status / live / metrics / logs / rules 页）——
**架构：定义（代码）→ 采集（槽位）→ 样本落库 → 规则评估 → 告警生命周期 + 通知**。
- **定义在代码、配置在库**：指标与规则都由代码注册（`MetricRegistry` / `RuleRegistry`，系统指标与规则
  在 `modules/monitor/metrics` / `rules`，业务模块可 import `MonitorModule` 拿 `MonitorRegistry`
  注册自己的定义，如 AI 用量的 `ai.usage.*`）；启动时 `SeedService` 按 `ruleKey` 对账写入
  `monitor_rules`（新建 / 恢复 / 更新元数据与定义版本哈希，代码里删掉的标 `deprecated` 并收掉在途告警），
  **不覆盖用户改过的 `config` / `enabled`**。因此后台只能改参数、开关、级别与通道，不能凭空新增规则。
- **埋点**（`@repo/kits` 的 `Telemetry`，一行埋点即可）：Counter / Gauge / 对数桶直方图（近似 P50/P95/P99）；
  框架由 `RequestMetricsMiddleware` 自动埋请求指标（`request.*`），业务自定义指标由业务方自行埋点
  并注册定义（AI 用量指标即走这条路径），样本按实例带 `instanceId`。
- **指标采集**：`MonitorTimeline` 按定义声明的评估周期分槽触发；每个实例采集本实例 raw 指标
  （`request.count` / `request.duration.count` / `request.duration.sum` / `request.error` /
  `request.p95` / `request.p99` / `process.memory.total` / `process.memory.used`，源为 telemetry / process），
  leader 额外采集 `scope: global` 指标；raw 采到后同一窗口计算 derived 指标（`request.qps` /
  `request.avgDuration` / `request.errorRate` / `process.memoryRatio`，只允许依赖 raw）；样本落 `monitor_metric_samples`，
  按 `retentionDays`（默认 30 天）保留，由 leader 每 10 分钟清理一次。
- **规则类型**（库里的 `monitor_rules`）：`kind` = `metric` | `event`，`driver` = `batch` | `stream`。
  指标规则取窗口内样本按 aggregation 归并后与阈值比较；stream 规则要求连续 `streakWindows` 个窗口命中；
  事件规则匹配错误码 / 关键字，并按窗口在 Redis 计数后过 `threshold`。可配字段：`enabled` / `operator` /
  `threshold` / `level` / `channels` / `silenceSeconds` / `recoverAfterWindows` / `notifyOnRecovery` /
  `streakWindows` / 维度与匹配条件。
- **多实例**：每个槽位用 Redis 锁选 leader（`engine/status` 回 `instanceId` / `leader`），非 leader
  只采集不评估，避免重复告警；指标最新样本超过 `staleAfterSeconds` 视为陈旧，跳过评估。
- **触发与恢复**：技术错误由 `AppExceptionFilter` 与 `main.ts` 的 `uncaughtException` /
  `unhandledRejection` 汇入 `MonitorEngine.ingestError`，直接驱动事件规则；指标规则按槽位周期评估。
  命中即开 `monitor_alerts`（同规则同主体同时只允许一条 `firing`），投递前查静默期，连续
  `recoverAfterWindows` 个窗口未命中则置 `resolved`（`notifyOnRecovery` 决定是否再发一条恢复通知）。
- **通知通道**：`file`（默认写入 `logs/alerts.log`，零配置开箱即用）+ `lark`（飞书）+ `email`（SMTP），
  规则的 `channels` 选择；每次通道发送（成功或失败）都落 `alert_logs` 审计，同时把告警事件推到 SSE 的
  `admin:all` 频道。设计文档：[monitor-engine.md](../design/monitor-engine.md)、
  [monitor-alert.md](../design/monitor-alert.md)、[notifier.md](../design/notifier.md)。
- 告警配置 env：`ALERT_ENABLED`（总开关）/ `ALERT_EMAIL_TO` / `ALERT_SMTP_*` /
  `LARK_APP_ID` + `LARK_APP_SECRET` + `LARK_NOTIFY_RECEIVE_ID`（飞书）/ `MONITOR_INSTANCE_ID`（实例标识，
  缺省 `hostname:pid`）/ `MONITOR_SAMPLE_RETENTION_DAYS`（样本保留天数）。文件通道路径取
  `NotifyConfig.file.path`（默认 `logs/alerts.log`），当前未开放 env 覆盖。

**接口限流**：`/auth/login`、`/auth/register`、`/auth/forgot-password`、`/auth/reset-password`、
`/admin/login` 按 IP 固定窗口限流（默认 20 次 / 60s，超限 429 + `Retry-After`）；
`/share/meta` 另配 60 次 / 60s（分享页匿名可调）。白名单
（env `RATE_LIMIT_WHITELIST`）豁免，`RATE_LIMIT_TRUST_PROXY=true` 时信任 `x-forwarded-for`。
其他接口按需用 `@UseGuards(RateLimitGuard)` + `@RateLimit({ scope, limit, windowSeconds })`
方法装饰器开启限流。

## 日志

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
  它在请求进入时（`use()` 里）**捕获请求上下文 ALS 的 store 引用**（而不是在 `finish` 时现取）：普通请求恰好
  能现取是因为 `end()` 同步发生在处理链路内，而 SSE 等长连接的响应结束发生在 socket 的异步上下文里，
  那时作用域早已退出（曾因此让长连接日志的 requestId 全为 null）；日志 `requestId` 即响应头 `X-Request-Id`；
- **输出目标**：开发 `pino-pretty` 彩色；生产 JSON；生产且配置 `loki` 时多目标 transport
  （`pino/file` 落盘 + `pino-loki` 推送，带 labels 与批量间隔）。注意 `pino-loki` 依赖必须声明在
  `@repo/shared`（创建 pino 实例的包），挪到 kits 会报 `unable to determine transport target`；
- **默认脱敏**：`req.headers.authorization` / `req.headers.cookie` / `res.headers["set-cookie"]`。

> `@repo/shared/logger` 现在是**前后端共用**的日志工厂：前端（`apps/admin`）直接用，
> 后端由 kits `LoggerModule` 包装成可注入的 `AppLogger` 与 `NestLoggerAdapter`。
