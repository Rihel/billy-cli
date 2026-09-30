# 架构与数据流（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> 开始任何任务前先阅读。

## 1. 工程是什么

billy-cli 是一套**全栈应用 Monorepo 模板**：pnpm + Turbo 构建，TypeScript 全栈。
后端「NestJS 薄边界 + 业务模块 + 通用能力封装（@repo/kits）」，前端两套独立入口
（Web 前台 / Admin 后台）。

## 2. 技术栈速览

| 层 | 选型 |
| --- | --- |
| 构建 | pnpm + Turbo（`turbo.json` 按依赖拓扑编排） |
| 服务端 HTTP | NestJS 12（`@nestjs/core` + `@nestjs/common` + `@nestjs/platform-express`，底层 Express 5；`apps/server`，端口 9989） |
| 服务端推流 | `@repo/kits` 的 `StreamHub`（`POST /sse/subscribe` 长连接 + Redis pub/sub 跨实例广播）+ `@repo/http-client` 的 `HttpStreamClient`（浏览器 / Node 双环境，默认 POST + Bearer 认证） |
| 服务端日志 | 自建 logger（`@repo/shared/logger` 的 `createLogger`，**不用 nestjs-pino**）：kits `LoggerModule` 建唯一 pino 实例（pino-pretty 开发美化；生产可多目标 transport 推送 pino-loki；redact 脱敏），`AppLogger` 供业务注入、`NestLoggerAdapter` 接管 Nest 框架日志；请求日志由 `common/request-logger` 的中间件自记录 |
| 业务落点 | `apps/server/src/modules/<业务>/{module, controller, service, repository, errors, index}`（业务 + 实体 + 迁移归 server） |
| 通用能力 | `@repo/kits`（一个基础设施一个目录 = `provider + <name>.config.ts + <name>.module.ts + index.ts`，均 `@Global()` + `XxxModule.forRoot(options)` / `forRootAsync(options)`，配置对象即模块自身 bean，无业务实体） |
| 应用配置 | `AppConfigFacade`（bootstrap 前用 Zod 加载校验 + 缓存）+ `@nestjs/config` 的全局 `ConfigService`（各模块 `forRootAsync` 惰性取命名空间分片；应用级业务配置由业务层 `resolveServerConfig(config)` 取 `server` 分片，不单设配置 bean） |
| 依赖注入 | NestJS 内建 DI（`@nestjs/common` 的 `@Injectable` / `@Inject` / `@Optional` + 构造器注入 + 生命周期钩子） |
| ORM | TypeORM（`@repo/kits` 的 `Db` + `apps/server` 的实体 / 迁移，PostgreSQL） |
| 契约 / 共享 | Zod + 字典 + 响应工具（`@repo/shared`） |
| 前台 | Next.js 16 App Router + Base UI + shadcn/ui + Tailwind 4（`apps/web`，9840） |
| 后台 | Next.js 16 + `@repo/ui`（shadcn/ui）+ TanStack Query / Table / Form（`apps/admin`，9845） |
| API 客户端 | `@repo/http-client`（通用 HTTP 客户端：请求 + SSE 流式推送，浏览器 / Node 双环境）+ `@repo/sdk`（业务全类型化 ServerClient） |

## 3. 分层架构与依赖方向（最重要的心智模型）

```
apps/server   NestJS HTTP 边界 + 业务模块 + 实体 / 迁移 + 配置 + 唯一组合根
               · common/       横切 HTTP 构件（各包有 index.ts，外部从 common/index.ts 导入）：
                               error/（错误码映射 · 边界错误 · 全局异常过滤器 · 告警钩子）、
                               request-context/（模块 @Global：ALS 上下文 + 自注册中间件）、
                               request-metrics/（模块 @Global：自注册埋点中间件）、
                               security/（token 与身份读取 · 限流守卫）、
                               http/（Zod 校验管道 · 响应信封拦截器）
               · modules/<业务>/  module / controller / service / repository / errors / index
               · database/      entities/ + migrations/
               · app-config.ts  serverAppConfigSchema + mapServerEnv + loadServerAppConfig
               · root.module.ts 组合根：AppConfigModule + 各基础设施 forRootAsync + 业务模块 imports
   ↓ 只依赖
@repo/kits    后端通用能力封装：一个基础设施一个目录（provider + <name>.config.ts +
              <name>.module.ts + index.ts，均 @Global + XxxModule.forRoot(options)）
              · db/           Db 门面（连接生命周期）/ DbService（注入式数据操作门面：四种分页 +
                              批量写入/删除 + safeDelete + getFullSqlStatement；只依赖 Db，不注入
                              logger），自动带默认 manager 与操作人）/
                              DbConfig / DbModule / create-db / BaseEntity / AuditEntity +
                              AuditSubscriber / pagination / batch / safe-delete / sql
              · redis/        RedisStore / RedisLockService（自旋等待 + 看门狗续期 + @RedisLock）/
                              RedisListCache / RedisConfig / RedisModule
              · rate-limit/   RateLimiter / RateLimitModule（复用 RedisConfig）
              · stream/       StreamHub / StreamConnection / StreamHubModule（SSE）
              · jwt/          TokenSigner / JwtConfig / JwtModule
              · session/      SessionStore / SessionStoreModule
              · password/     PasswordHasher / PasswordConfig / PasswordModule
              · storage/      ObjectStorage / StorageConfig / ObjectStorageModule（providers/{s3,cos}）
              · kafka/        KafkaService / @KafkaConsumer / KafkaConfig / KafkaModule
              · lark/         LarkClient / LarkConfig / LarkModule
              · notification/ Notifier / FileClient / EmailClient / LarkNotifyClient / NotifyConfig /
                              NotificationModule
              · telemetry/    Telemetry / TelemetryModule
              · foundation/   config（可插拔 ConfigLoader 抽象 + 内置 env / memory / consul loader
                              + AppConfigFacade + AppConfigModule：把已加载配置接进 @nestjs/config
                              的全局 ConfigService）/ command（跨平台命令执行：CommandRunner +
                              CommandModule，底层 execa）/ errors / id-generation / logger / scheduler
              · 配置对象即模块自身注入 bean；未 import 即未装配；实体由 app 在
                DbModule.forRootAsync 的工厂里注入（类引用无法来自环境变量）
@repo/shared  Zod schema（契约）+ dicts（错误码 / 字典）+ AppResponse（响应格式）
   ↑ 被 kits / server / sdk / 前端共同依赖 —— 契约先行
@repo/sdk     ServerClient：全类型化业务 API 调用（前端 / 脚本使用）
@repo/http-client  通用 HTTP 客户端：请求管线 + SSE 客户端（fetch 流 + 状态机，认证凭证体系
                   CredentialsManager / AuthStrategy / CredentialProvider / CredentialResolver，
                   浏览器 / Node 双环境，零第三方依赖）
apps/web      前台（Base UI + shadcn，`@repo/ui`）
apps/admin    后台（`@repo/ui` + @tanstack/react-table + @tanstack/react-form）
```

**依赖方向不可逆**：`shared` 不依赖任何业务包；`kits` 不 import `apps/*`；`apps/server`
按依赖方向自底向上落代码。`apps/server` 的 `common/` 只放横切 HTTP 构件，且不依赖具体业务
模块（技术错误告警通过 `ERROR_ALERT_HOOK` token 由 `root.module.ts` 注入 `AlertTrigger`）；
controller 只做 HTTP 边界，业务逻辑在 service / repository。

## 4. 一次请求的数据流

1. 前端调用 `ServerClient.xxx.create(payload)`（`@repo/sdk`）。
2. 请求进入自注册的 Express 中间件（按 `imports` 顺序）：`common/request-context` 的
   `RequestContextModule`（AsyncLocalStorage，生成 `requestId` 并写响应头 `X-Request-Id`）→
   `common/request-logger` 的 `RequestLoggerMiddleware`（响应结束时记录 method / url / status /
   耗时 / requestId / userId / adminId）→ `common/request-metrics` 的埋点中间件。
3. 守卫（`UserAuthGuard` / `AdminAuthGuard` / `RateLimitGuard`）在进入控制器前校验身份与限流，
   把 `userId` / `adminId` 写入请求上下文。4. `apps/server/src/modules/<业务>/<业务>.controller.ts` 用 `@Body({ schema: Schema })` 做 **Zod 边界校验**，
   再调注入的 service。
5. service（可 `@Transactional()`）调 repository 读写 TypeORM。
6. 业务错误抛 `AppError` 子类（自带数字 `code`），由 `common/error/app-exception.filter.ts` 的
   `AppExceptionFilter` 经 `AppErrorCodes` 字典映射为 HTTP 状态码 + 中文文案；
   校验失败走 HTTP 200 + `{ code: 400 }`，未知错误一律 5001 / 500。
7. 成功由 `ResponseEnvelopeInterceptor` 统一包为 `{ code: 0, data }`（HTTP 200）。

**中间件顺序铁律（Nest 12）**：模块中间件按模块 `distance` 排序装配，**`@Global()` 模块排在最前**
（`middleware-module.js` 把 `distance === Number.MAX_VALUE` 视为全局、权重 -1），全局模块之间再按
容器注册顺序（即组合根 `imports` 顺序）稳定排序。因此请求上下文模块必须：① 标 `@Global()`；
② 在 `imports` 里写在 `RequestLoggerModule` / `RequestMetricsModule` 之前。顺序错了的后果：
请求日志 / 指标中间件在响应结束时读不到 ALS 里的 `requestId` / `userId` / `adminId`
（日志丢掉登录身份、requestId 与响应头对不上）。
