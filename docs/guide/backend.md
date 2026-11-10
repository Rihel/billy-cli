# 后端（NestJS）

> `apps/server` 的 HTTP 边界、业务模块、认证、API、日志与监控。
> 通用能力封装见 [packages.md](./packages.md)，部署见 [deployment.md](./deployment.md)。

## apps/server — NestJS 12 HTTP 边界

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
  （`IdGenerationModule` / `TelemetryModule` / `SchedulerModule` / `CommandModule`）与各基础设施模块 —— 需要配置的一律用
  `forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config) => config.get('<命名空间>') })`
  **惰性**取自己的分片（`LoggerModule` / `DbModule` / `RedisModule` / `JwtModule` / `PasswordModule` /
  `ObjectStorageModule` / `NotificationModule`），无自有配置的直接引模块（`RateLimitModule` /
  `StreamHubModule` / `SessionStoreModule`）；可选模块 `LarkModule` / `KafkaModule` 用展开语法按 env 是否存在决定；
  再注册各业务模块（`AuthModule` / `AdminModule` / `UserModule` / `SessionModule` / `StorageModule` /
  `StreamModule` / `MonitorModule` / `RuntimeConfigModule` / `AiModule` / `AiModelModule` / `AiUsageModule` /
  `OpsModule`）；`providers` 里用 `APP_PIPE` / `APP_FILTER` / `APP_INTERCEPTOR` 注册全局管道、过滤器与拦截器。
- **入口**：`main.ts` 用 `NestFactory.create<NestExpressApplication>(RootModule, { bodyParser: false })`
  启动，只做引导与全局 Express 配置（`app.enableCors()`、请求体上限 2mb）；请求级横切中间件
  （`RequestContextModule` 的请求上下文 ALS / `RequestMetricsModule` 的请求埋点）由模块自注册。
- **业务模块目录**：`modules/<业务>/{module,controller,service,repository,errors,index}.ts`；
  controller 只做 HTTP 边界（Zod 校验 + 调 service + 返回数据），业务逻辑仍在 service / repository。
  `monitor` 的 `MonitorHealthController` 提供免鉴权 `POST /monitor/health`；`ops` 的 `OpsController`
  提供免鉴权根路径 `GET /healthz` / `GET /readyz` / `GET /info`（k8s 探针用，见「API 设计」的 GET 例外）；
  `admin` 的 `AdminAuthController` 提供免鉴权的 `login` / `logout`。
- **校验与响应**：请求体用 `@Body({ schema: Schema })` 参数装饰器校验，控制器只返回业务数据，由
  `ResponseEnvelopeInterceptor` 统一包成 `{ code: 0, data }`，异常统一由 `AppExceptionFilter` 处理；
  全部**业务**路由 POST 且显式标注 `@HttpCode(200)`（Nest 对 POST 默认 201）；GET 只留给运维探针与浏览器
  `EventSource` 的 AI 运行重连（`/agent/run/stream`），见「API 设计」。
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

## apps/server 业务模块

业务三层（module + controller + service + repository + errors）位于
`apps/server/src/modules/{auth,admin,user,session,monitor,storage,stream,ai,ai-model,ai-usage,runtime-config,ops}`，
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
├── monitor/        # MonitorHealthController（免鉴权 /monitor/health）+ MonitorController + 告警规则 / 记录
├── storage/        # storage.controller.ts（预签名 URL / STS 临时凭证）
├── stream/         # stream.controller.ts + stream-auth.guard.ts + stream.options.ts（SSE_ROUTE_OPTIONS）
├── ops/            # OpsController（根路径 GET /healthz、/readyz、/info，运维探针的 GET 例外）+ OpsModule
├── session/        # 多设备会话管理（登录设备列表 / 踢下线）
├── ai/             # 会话 / 运行 / 时间线 / 工具面 / 技能 / 恢复 / 连接器
│                   #   runtime/ 上下文 · 流式 · 恢复 · 用量；core/tools 注册机与网关；
│                   #   tools/ 内建工具组；connectors/ 连接器目录与驱动（sql / redis / lark-cli）
├── ai-model/       # 供应商与模型配置（后台配置即生效，运行时只用配过的模型）
├── ai-usage/       # 每日用量汇总 + 定时 rollup（按模型 / 按 agent）
└── runtime-config/ # RuntimeConfigController（公开 POST /config/get）+ RuntimeConfigModule
│                   #   目录名与类名刻意区别于 kits 的 AppConfigModule
common/                        # 横切 HTTP 构件（不依赖业务模块；外部统一从 common/index.ts 导入）
├── error/       # error-descriptor.ts（错误码 → HTTP/中文）+ boundary-error.ts + app-exception.filter.ts + error-alert-hook.ts
├── request-context/   # 模块：request-context.ts（ALS：requestId/userId/adminId）+ request-context.middleware.ts + request-context.module.ts
├── request-metrics/   # 模块：request-metrics.middleware.ts（注入 Telemetry，采 QPS/耗时）+ request-metrics.module.ts
├── security/    # authentication.ts（token 提取 / 当前身份）+ rate-limit.guard.ts（@RateLimit + RateLimitGuard）
└── http/        # zod-validation.ts（`@Body({ schema })` 校验管道）+ response-envelope.interceptor.ts（响应信封）
│                #   + ops-probe.ts（探针路径判定：请求日志 / 指标据此跳过探针）
database/
├── entities/     # 15 张表，全部继承 @repo/kits 的 BaseEntity / AuditEntity：
│                 #   用户与后台（user / admin）、监控（monitor-rule / monitor-alert / monitor-metric-sample / alert-log）、
│                 #   AI（conversation / run / timeline / ai-provider / ai-model / ai-tool / ai-connector /
│                 #   ai-usage-daily / ai-usage-daily-dimension）
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
  SessionStoreModule,
  StreamHubModule,
  TelemetryModule,
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

- JWT token，通过 `Authorization: Bearer` 或 `access-token` cookie 传递；payload 带
  `jti`（唯一 id，`TokenSigner.sign` 显式写入）—— 否则同一秒内重复登录会签出**逐字节相同**的
  token，服务端会话按 `sha256(token)` 主键会把两台设备合并成一条
- `UserAuthGuard`（`modules/auth/user-auth.guard.ts`）与 `AdminAuthGuard`
  （`modules/admin/admin-auth.guard.ts`）调用业务 `verifyToken`，校验通过后把 `userId` /
  `adminId` 写入 AsyncLocalStorage 请求上下文（管理员 token payload 带 `type: 'admin'`）
- 两类 token 严格隔离：用户 token 只能访问用户接口，管理员 token 只能访问 `/admin/*` 接口
- 公开接口（注册 / 登录 / 管理员登录 / 忘记密码 / 重置密码）不加 Guard
- Admin SSR 侧：`main/layout.tsx` 用 cookie 调 `getMe()`，失败 `redirect()`；`proxy.ts`
  中间件做首屏路由守卫
- Web 侧：Server Actions 用 `@repo/ui/action` 的 `defineAction` 统一 `{ ok, data | error }` 结果约定（两个前端同一套）
- Admin 客户端：token 存 localStorage，同时写 httpOnly cookie 供 SSR 守卫使用
- **登录设备（会话管理）**：会话写入 Redis 时带 `sessionId` / `ip` / `userAgent` / 时间；
  `POST /session/list`（标出 `current`）与 `POST /session/remove`（按 `sessionId` 幂等下线），
  前台用户与管理员共用（`AnyAuthGuard`）。入口：web `/account/sessions`、admin 个人中心。
  设计见 [docs/design/session-management.md](../design/session-management.md)

## API 设计

所有**业务**接口均为 `POST`（每条路由显式 `@HttpCode(200)` 固定，Nest 对 POST 默认 201，必须覆盖），
请求体由 Zod schema 校验，响应统一包装为 `AppResponse<T>`：

> **GET 例外只有两类**：
> 1. 运维探针 `GET /healthz`、`GET /readyz`、`GET /info` —— k8s 的 `httpGet` 探针**只会发 GET**，
>    业务路由全 POST 会让探针 404、pod 永远不就绪，故为探针开放 GET；
> 2. AI 运行重连 `GET /agent/run/stream`、`GET /agent/run/:runId/stream` —— 浏览器 `EventSource`
>    只能发 GET（首次对话仍走 `POST /agent/chat/stream`）。
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
| `POST /storage/get-presigned-url`    | 获取上传预签名 URL（前台用户 key 被改写进 `user/{userId}/`） | 用户 / 管理员 |
| `POST /storage/get-download-url`     | 获取下载预签名 URL（前台用户仅限自己前缀，越界 403） | 用户 / 管理员 |
| `POST /storage/get-temporary-credentials` | 获取 STS 临时凭证（整桶权限，**仅管理员**） | 管理员 |
| `POST /session/list`                 | 登录设备列表（含 `current` 标记） | 用户 / 管理员 |
| `POST /session/remove`               | 下线指定设备（按 `sessionId`，幂等） | 用户 / 管理员 |
| `POST /sse/subscribe`              | SSE 订阅（长连接推流，body `{ channels: [...] }`） | 是 |
| `GET /healthz`                     | 存活探针（livenessProbe，**不探外部依赖**，进程活着即 200） | 否 |
| `GET /readyz`                      | 就绪探针（readinessProbe，探 DB / Redis，不可用返回 **503** + `code: 5002` 主动摘流） | 否 |
| `GET /info`                        | 运行信息（版本 / 运行时 / 已生效的长连接超时） | 否 |
| `POST /monitor/health`             | 健康检查（DB / Redis 探活，容器 / 云平台探针） | 否 |
| `POST /monitor/rule/create`        | 创建告警规则 | 管理员 |
| `POST /monitor/rule/page-query`    | 告警规则分页查询 | 管理员 |
| `POST /monitor/rule/detail`        | 告警规则详情 | 管理员 |
| `POST /monitor/rule/update`        | 更新告警规则 | 管理员 |
| `POST /monitor/rule/remove`        | 删除告警规则 | 管理员 |
| `POST /monitor/log/page-query`     | 告警发送记录分页 | 管理员 |
| `POST /monitor/test`               | 测试通知（手动验证通道） | 管理员 |
| `POST /config/get`                 | 公开运行配置（返回 `authEnabled`） | 否 |
| `POST /agent/chat/stream`          | 发起一轮对话（SSE 流式） | 用户 / 管理员 |
| `POST /agent/chat/resume`          | 断线续传（按 offset 接着推） | 用户 / 管理员 |
| `GET /agent/run/stream`            | 重连当前运行（SSE，`EventSource` 只能 GET） | 用户 / 管理员 |
| `GET /agent/run/:runId/stream`     | 重连指定运行（SSE） | 用户 / 管理员 |
| `POST /agent/run/{list,detail,stop}` | 运行列表 / 详情 / 停止（审计与复盘） | 用户 / 管理员 |
| `POST /agent/conversation/*`       | 会话增删改查（create / list / detail / rename / remove） | 用户 / 管理员 |
| `POST /agent/usage/summary`        | 用量汇总（按模型 / 按 agent） | 管理员 |
| `POST /agent/usage/rollup`         | 手动触发用量 rollup | 管理员 |
| `POST /ai-model/provider/*`        | 模型供应商配置（list / create / detail / update / remove / sync / test） | 管理员 |
| `POST /ai-model/model/*`           | 模型配置（list / create / update / remove） | 管理员 |
| `POST /ai-tool/{list,detail,update,reset}` | 工具配置（开关 / 作用域 / 限额 / 配置值 / 密钥） | 管理员 |
| `POST /ai-connector/*`             | 连接器实例（catalog / list / create / update / detail / test / sync / remove） | 管理员 |

> 鉴权列：**管理员** = `AdminAuthGuard`（后台管理员令牌；`/admin/*`、`/user/*`、`/monitor/*`、`/storage/*`、
> `/ai-model/*`、`/ai-tool/*`、`/ai-connector/*` 以及 `/agent/usage/*` 都是它）；
> `UserAuthGuard`（前台用户令牌）只用在 `/auth/get-me`、`/auth/update-info`、`/auth/change-password`；
> `/agent/*` 的对话与运行接口用 `AnyAuthGuard`（前台用户与管理员同一套）；两者都从 Bearer / cookie 取令牌。
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
  `NotifyConfig.file.path`（默认 `logs/alerts.log`），当前未开放 env 覆盖。设计文档：[monitor-alert.md](../design/monitor-alert.md)、
  [notifier.md](../design/notifier.md)。

**接口限流**：`/auth/login`、`/auth/register`、`/auth/forgot-password`、`/auth/reset-password`、
`/admin/login` 按 IP 固定窗口限流（默认 20 次 / 60s，超限 429 + `Retry-After`）；白名单
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
  它在中间件注册时**捕获请求上下文 ALS 的 store 引用**（而不是在 `finish` 时现取）：普通请求恰好
  能现取是因为 `end()` 同步发生在处理链路内，而 SSE 等长连接的响应结束发生在 socket 的异步上下文里，
  那时作用域早已退出（曾因此让长连接日志的 requestId 全为 null）；日志 `requestId` 即响应头 `X-Request-Id`；
- **输出目标**：开发 `pino-pretty` 彩色；生产 JSON；生产且配置 `loki` 时多目标 transport
  （`pino/file` 落盘 + `pino-loki` 推送，带 labels 与批量间隔）。注意 `pino-loki` 依赖必须声明在
  `@repo/shared`（创建 pino 实例的包），挪到 kits 会报 `unable to determine transport target`；
- **默认脱敏**：`req.headers.authorization` / `req.headers.cookie` / `res.headers["set-cookie"]`。

> `@repo/shared/logger` 现在是**前后端共用**的日志工厂：前端（`apps/admin`）直接用，
> 后端由 kits `LoggerModule` 包装成可注入的 `AppLogger` 与 `NestLoggerAdapter`。
