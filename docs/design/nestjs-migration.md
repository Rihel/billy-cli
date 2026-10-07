# 后端重构：删除 @repo/di、Hono → NestJS 12、kits 全面 Nest 化

> 日期：2026-09-12
> 状态：已实施并验证
> 影响面：`packages/di`（删除）、`packages/kits`、`apps/server`、`scripts/cli`、前端文案、文档与 skill
>
> 2026-09-13 更新：组合根文件/类已由 `app.module.ts`/`AppModule` 更名为 `root.module.ts`/`RootModule`；
> `core.module.ts`（`CoreModule`）已删除——应用级业务配置不再单设 bean，改为各处注入全局 `ConfigService`
> 后调 `apps/server/src/config.ts` 的 `resolveServerConfig()` 取 `server` 分片。本文正文中的旧路径/类名
> 均为当时记录，不代表现状。
>
> 2026-09-12 二次更新：本文 §3.2 的 `KitsModule.forRoot` 聚合模块**已拆除**，改为
> 「一个基础设施一个 module，配置即模块自身 bean」（`DbModule.forRoot` / `RedisModule.forRoot` /
> `JwtModule.forRoot` / `NotificationModule.forRoot` / `KafkaModule.forRoot` …，均 `@Global()`）。
> 本文其余结论（删除 `@repo/di`、Hono → NestJS 12、显式 `@Inject` 约束、HTTP 数据结构保持不变）仍然成立。
>
> 2026-09-15 三次更新（**推翻本文的日志结论**）：本文正文写的「改用 nestjs-pino、请求日志由
> pino-http 自动记录」**已作废**。现为自建 logger：kits `LoggerModule` 用
> `@repo/shared/logger` 的 `createLogger` 建唯一 pino 实例，业务注入 `AppLogger`、
> Nest 框架日志经 `NestLoggerAdapter`，请求日志由 `apps/server/src/common/request-logger/`
> 的中间件记录。详见 [manual-logger.md](./manual-logger.md)。
>
> 2026-09-12 四次更新：配置链路改为 **AppConfigFacade + `@nestjs/config` + `forRootAsync`**（对齐
> rihel-base）。kits 新增 `foundation/app-config/`（`AppConfigFacade` 在 bootstrap 前加载 + Zod 校验 + 缓存，
> `AppConfigModule.forRoot()` 把它接进全局 `ConfigService`）；需要配置的基础设施模块都新增
> `forRootAsync(options: InfraModuleAsyncOptions<...>)`（与 `forRoot` 并存）。`apps/server` 新增
> `src/app-config.ts`（`serverAppConfigSchema` 复用 kits 各模块 schema 组合成命名空间 + `mapServerEnv`），
> `main.ts` / `scripts/seed-admin.ts` 首行 `await loadServerAppConfig()`，`app.module.ts` 各基础设施改用
> `forRootAsync` + `ConfigService.get('<命名空间>')` 惰性取配置；业务模块 `modules/app-config/` 改名
> `modules/runtime-config/`（`RuntimeConfigController` + `RuntimeConfigModule`）。本文 §3.2 的
> 「配置即模块自身 bean」仍然成立，但取配置的方式以本节为准。

> 2026-09-12 五次更新：上面的配置模块进一步重构为 **可插拔 loader 抽象**。`foundation/app-config/`
> 与 `foundation/config-source/` 两个目录**已合并为单一 `foundation/config/`**（`config.loader.ts` 定义
> `ConfigLoader` 接口 + 注册表 + 错误类 + `AppConfigInitialOptions`；`loaders/index.ts` 提供内置
> `envConfigLoader` / `memoryConfigLoader` / `consulConfigLoader` 与 `resolveConfigLoader`；
> `config.facade.ts` 的 `AppConfigFacade`；`config.module.ts` 的 `AppConfigModule`）。
> `AppConfigFacade.initial({ schema, loader })` 中 **`schema` 是应用自定义的 shape、`loader` 决定来源**
> （传 loader 实例，或传名字 + `loaderOptions`）；换来源只改 `loader` 一行，shape 与各模块装配不变。
> 旧写法 `loadConfig({ schema, source })` 与 `ConfigSourceError` 已不存在。

> 2026-09-12 三次更新：日志实现改为 **nestjs-pino**（对齐 rihel-base）。自研的
> `apps/server/src/common/request-logger.middleware.ts` 已删除，请求日志由 pino-http 自动记录；
> `packages/kits/src/foundation/logger/` 改为 `app-logger.ts` + `logger.config.ts` +
> `logger.options.ts` + `LoggerModule`（`@Logger()` 装饰器与 `configureLogger()` 已删除，业务类改为
> 构造器注入 `@Inject(AppLogger)`）。下表 §3.4 的 `requestLogger` 一行按新实现理解。

## 1. 目标

1. 删除 `packages/di`（InversifyJS 8 容器）。
2. HTTP 层由 Hono 4 换成 NestJS 12。
3. `packages/kits` 的全部 bean 用 NestJS 12 封装。

## 2. 调查结论（动手前的现状与外部事实）

### 2.1 现状

- `@repo/di`（`@Injectable` / `@Inject` / `@Optional` + `AppContext` + `LifeCycleHost` + `autoRegister`）
  被引用 44 处：kits 全部基建 bean、server 全部业务 bean、`features/*` 路由工厂、`lib/*`、
  `scripts/cli` 模板、kits 测试。
- 服务端是 Hono「薄边界」：`features/*.ts` 路由工厂 + `lib/`（ALS 请求上下文 / 请求日志 /
  限流 / 鉴权 / 错误映射 / `jsonBody` Zod 校验）+ `main.ts` 组合根。
- 隐含约定（前端 SDK / Web / Admin 全依赖，必须原样保住）：全部 `POST`；成功 `{ code: 0, data }`
  且 **HTTP 200**；校验失败 **HTTP 200** + `{ code: 400, message }`；业务错误按 `AppErrorCodes`
  字典映射 HTTP；路由未命中 `{ code: 404, message: '接口不存在' }`；未知错误 HTTP 500 +
  `{ code: 5001 }`；`X-Request-Id` 响应头；SSE 为 `POST /sse/subscribe`。

### 2.2 NestJS 12 的真实约束（核对了 npm 元数据与官方迁移指南）

| 事实 | 影响 |
| --- | --- |
| `@nestjs/core@12.0.1` 为 latest，**ESM-only**，运行需 Node ≥ 20.19 / 22.12 | 本仓库 `type: module` + `module: nodenext` + Node 24，天然匹配，无需改造模块格式 |
| `@nestjs/platform-express@12.0.1` 内置 Express 5.2.1 | Express 5 通配路由语法变更，故横切中间件改用 `app.use()` 而非 Nest 中间件 |
| `@HttpCode` 仍是**方法级**（无类级） | 每个业务方法显式 `@HttpCode(200)`，否则 POST 默认 201，破坏约定 |
| 生命周期钩子按组件层级调用 | 原 `OnAppStart` / `OnAppStop` 映射为 `OnApplicationBootstrap` / `OnApplicationShutdown` |
| 注入器 `reflectConstructorParams` 用 `@Inject` 元数据覆盖 `design:paramtypes` | **只要每个构造器参数都显式 `@Inject(token)`，即使拿不到 `design:paramtypes` 也能正确装配** |
| `@Optional()` 在依赖解析抛错时兜底为 `undefined` | 保留「按配置存在装配」的条件语义 |

### 2.3 决定性风险与实测

`dev:server` 用 `tsx`（esbuild），而 **esbuild 不支持 `emitDecoratorMetadata`**，
NestJS 的隐式按类型注入会失效。实测（tsx + `NestFactory.createApplicationContext`）：

- `@Inject(Token)`：正常解析；
- `@Optional()` + 未注册 token：注入 `undefined`，不报错；
- 仅靠 TS 类型（无 `@Inject`）：**静默注入 `undefined`，不报错**。

结论：方案可行，但必须把「构造器参数一律显式 `@Inject(token)`」定为硬约束并写进
`billy-dev-foundation`，避免后来者写出静默失败的代码。

## 3. 设计决策

### 3.1 DI 全面交给 NestJS

- `@Injectable` / `@Inject` / `@Optional` 改为从 `@nestjs/common` 引入。
- 删除 `AppContext` / `LifeCycleHost` / `autoRegister` / `markManual`：装配改为显式模块
  （`providers` / `exports` / `imports`），比全局注册表更可读、可静态分析。
- `runtime.get(X)` 全部消失，改为构造器注入。

### 3.2 kits 用 `@Global()` 动态模块封装

`packages/kits/src/kits.module.ts` 新增 `KitsModule.forRoot(config: KitsConfig): DynamicModule`
（**已拆除**，见文首二次更新；现为一个基础设施一个 `<name>.module.ts`）：

- 逐分片解析配置（zod 校验 + 默认值），分片存在才注册对应 provider；
- 组件按「所需配置存在」注册（传了 `db` 才装配 `Db`，传了 `redis` 才装配
  `RedisStore` / `QueueManager` / `StreamHub` / `RateLimiter`），与旧 `createServiceContext` 一致；
- 可选通道（`Notifier` ← `FileClient` / `LarkNotifyClient` / `EmailClient`）用 `@Optional()`，
  未装配即 `undefined`，由调用方降级；
- `@Global()` 让业务模块无需逐个 import 基建；
- `Telemetry` 构造器带可选数值参数，用 `useFactory` 装配，避免 Nest 解析数值 token；
- 生命周期：`OnApplicationBootstrap`（启动）与 `OnApplicationShutdown`（释放连接），
  按 `providers` 声明顺序执行；各组件持有独立连接，停止期互不依赖。

### 3.3 apps/server 结构与职责

```
apps/server/src/
├── main.ts          NestFactory 引导 + app.use 三个横切中间件 + app.close 优雅关闭
├── app.module.ts    唯一组合根（CoreModule + 各基础设施 XxxModule.forRoot + 业务模块 + APP_PIPE/APP_FILTER/APP_INTERCEPTOR）
├── core.module.ts   @Global：应用级配置 bean（ServerConfig）
├── common/          横切 HTTP 构件（不依赖具体业务模块）
└── modules/<业务>/   module + controller + service + repository + errors
```

分层规则相应更新：`modules/` 现在**含 controller**（NestJS 惯例），但 controller 只做
HTTP 边界（守卫 + Zod 校验 + 调 service + 返回数据），业务逻辑仍在 service / repository；
`common/` 放横切构件，且不反向依赖业务模块（技术错误告警通过 `ERROR_ALERT_HOOK` token 由
`app.module.ts` 注入 `AlertTrigger`）。

### 3.4 数据结构映射（逐项对照）

| 旧（Hono） | 新（NestJS） |
| --- | --- |
| `jsonBody(Schema)` 中间件 | 原生 `@Body({ schema: Schema })` + 全局 `StandardSchemaValidationPipe` 与 `exceptionFactory`（保 200 + code 400 格式） |
| `success(context, data)` | `ResponseEnvelopeInterceptor` 统一包 `{ code: 0, data }` |
| `errorHandler` / `notFound` | `AppExceptionFilter`（`@Catch()`）；框架 404 / 解析 400 不告警不记错误 |
| `makeRequireAuth` / `makeRequireAdminAuth` 中间件 | `UserAuthGuard` / `AdminAuthGuard`（`CanActivate`）|
| `makeRateLimit(runtime, opts)` | `RateLimitGuard` + `@RateLimit({ scope })` 方法装饰器（超限抛 `BoundaryError` 带 `Retry-After`）|
| `makeRequestContextMiddleware` | `requestContextMiddleware`（Express 中间件，`app.use` 注册）|
| `requestLogger` | **pino-http 自动记录**（`request completed`，含 `req.id` / `statusCode` / `responseTime`，按状态码分级；身份经 `LoggerModule.forRoot({ customProps })` 附加）|
| `makeRequestMetrics` | `makeRequestMetricsMiddleware`（保持中间件语义，避免漏统计被守卫拒绝的请求）|
| `streamSSE` + `writeSSE` | `@Res()` 直写 Express 响应，帧格式（event → data → id，多行 data，空行结束）与响应头逐字节对齐 |
| `app.route('/x', makeXRoutes(runtime))` | `@Controller('x')` + 模块 `controllers` |

### 3.5 安全与明确的取舍

- **不保留** `design:paramtypes` 依赖：用「显式 `@Inject`」换取 tsx / 任何打包器下行为一致。
- **不保留** `autoRegister` 的隐式登记：新增业务模块需显式进 `imports`，换来可读的依赖图。
- **不放宽** 校验：校验失败仍是 HTTP 200 + `code 400`（前端 SDK 按 `code` 判错）。
- 请求体上限从 Express 默认 100kb 提升到 2mb（`bodyParser: false` + `useBodyParser`）。

## 4. 验证

- `packages/kits` / `apps/server` 单测：49 + 23 通过；`@repo/http-client` 90 通过。
- `tsc` 零错误（kits、server `src` + `scripts`）；`pnpm build` 7/7 任务成功。
- 开发态（`tsx src/main.ts`）与编译态（`node dist/main.js`）双态启动，47 条路由映射正确。
- 接口冒烟：成功 200 信封、未认证 401 / `1006`、无效 token 401 / `1005`、
  校验失败 200 / `400` + 中文文案、未知路由 404 / `404`、畸形 JSON 400 / `400`、
  限流 429 / `4002` + `Retry-After`、健康检查 DB + Redis 正常。
- SSE 端到端：`POST /sse/subscribe` 返回 200 + `text/event-stream`，经 Redis 广播收到
  `event: smoke.test` / `data: {...}` / `id: evt-1` 帧。
- 优雅关闭：SIGTERM 依次执行 Redis / Scheduler / Db / StreamHub 的 `onApplicationShutdown`，
  进程退出码 0。

## 5. 遗留与风险

- `apps/server/test/*.test.ts` 存在**历史遗留**的 TS 类型错误（缺 `Telemetry` / `FileClient` /
  `Scheduler` 等类型导入；`Scheduler` 被 DOM lib 同名类型占用）。`tsconfig.json` 的
  `include` 只含 `src`，故不影响 `tsc`；测试运行态全部通过。本次未改动这些文件。
- NestJS 12 的 HTTP 适配器错误映射在 12 有小幅重构；本项目用自定义全局过滤器接管了错误渲染，
  不依赖框架默认响应体。
- 多实例下 Nest 的模块级生命周期顺序不再是「依赖拓扑序」，本项目各基建组件在停止期互不依赖，
  故无影响；新增有停止期依赖的组件时需要显式排序（或改为在一个协调组件中统一关闭）。
