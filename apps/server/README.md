# @app/server

NestJS 12（Express 适配器）HTTP 边界 + 业务模块 + 实体/迁移（能力复用 `@repo/kits`）。

## 目录

```
src/
├── main.ts                 # 入口：await loadServerAppConfig() → NestFactory 引导 + 横切中间件 + 优雅关闭
├── app-config.ts           # 应用配置：serverAppConfigSchema（复用 kits 各模块 schema）+ mapServerEnv + loadServerAppConfig
├── root.module.ts          # 组合根：AppConfigModule + 各基础设施 forRootAsync + 业务模块 + 全局管道/过滤器/拦截器
├── config.ts               # ServerConfig 类型（= ServerAppConfig['server']）+ resolveServerConfig(config)
├── common/                 # 横切 HTTP 构件（不依赖业务模块；各包有 index.ts，外部从 common/index.ts 导入）
│   ├── error/              #   错误码映射 · 边界错误 · 全局异常过滤器 · 告警钩子
│   ├── request-context/    #   （模块，@Global）ALS 上下文 + 自注册中间件（requestId / X-Request-Id）
│   ├── request-metrics/    #   （模块，@Global）自注册埋点中间件（QPS / 耗时直方图，注入 Telemetry）
│   ├── security/           #   token 与身份读取 · 限流守卫
│   └── http/               #   Zod 校验管道 · 响应信封拦截器
├── database/               # TypeORM 实体与迁移（实体在 root.module.ts 的 DbModule.forRootAsync 工厂里注入）
└── modules/<业务>/          # NestJS 业务模块：module + controller + service + repository + errors
    └── runtime-config/     # 运行配置接口（RuntimeConfigController 公开 POST /config/get）
```

## 分层约定

- `modules/<业务>/<业务>.controller.ts` 只做 HTTP 边界：守卫 + Zod 校验（`@Body({ schema })`）
  + 调 service + 返回业务数据（响应信封由全局拦截器统一包装）。
- 业务逻辑在 `service`，数据访问在 `repository`；二者不依赖 HTTP 类型。
- 所有业务接口统一 `POST + JSON body`，并显式 `@HttpCode(200)`（Nest 对 POST 默认 201）。
- 日志：业务类构造器注入 `@Inject(AppLogger)`（来自 `@repo/kits`，`context` 自动取宿主类名）；
  请求日志由 **nestjs-pino 的 pino-http 自动记录**，`main.ts` 用 `bufferLogs: true` +
  `app.useLogger(app.get(Logger))` 让 Nest 框架日志与业务日志走同一条 pino 通道。
- **配置链路**：`app-config.ts` 的 `serverAppConfigSchema` 复用 kits 各模块的 config schema 组成命名空间
  （`server` / `monitor` / `db` / `redis` / `jwt` / `password` / `storage` / `logger` / `notify` / `lark?` / `kafka?`），
  `main.ts` 与 `seed-admin.ts` 首行 `await loadServerAppConfig()` 加载校验（内部
  `AppConfigFacade.initial({ schema, loader: envConfigLoader({ envFileName: '.env', mapEnv: mapServerEnv }) })`，
  换来源只改 `loader` 一行）；各基础设施用
  `forRootAsync` + `ConfigService.get('<命名空间>')` **惰性取**（ESM 下模块装饰器求值早于配置加载，
  不要在 `root.module.ts` 顶层直读配置值）。除可选模块开关 `LARK_APP_ID` / `KAFKA_BROKERS` 外，
  `src/` 内不直读 `process.env`。

## 开发须知（重要）

项目用 `tsx`（esbuild）跑开发态，**不产出 `design:paramtypes`**，因此 NestJS 的
**每个构造器参数都必须显式写 `@Inject(token)`**；漏写不会报错，而是静默注入 `undefined`。

### 开发态加载器必须用 `tsx/esm`

`pnpm dev:server` / `seed:admin` 用的是 **`node --watch --import tsx/esm`**，不是 `tsx` CLI：

- `tsx` CLI 会**同时**注册 CJS 钩子，此时 CJS 依赖（`nestjs-pino`）里的 `require('@nestjs/core')`
  与我们的 ESM `import '@nestjs/core'` 会拿到**两份模块实例** → `ApplicationConfig`（@nestjs/core 里
  由 Nest 逐模块注册的 class token）与 nestjs-pino 构造器元数据里的那个类对不上，
  启动即报 `Nest can't resolve dependencies of the LoggerModule (pino-params, ?)`；
- 只挂 ESM 加载器（`tsx/esm`）时 `require(esm)` 复用同一份 ESM 缓存，行为等价于 `node dist/main.js`
  （实测：`tsx`、`node --import tsx` 有坑，`node --import tsx/esm` 没有）；
- 仅 `db:generate` / `db:migrate` 仍用 `node --import tsx`（typeorm CLI 走 CJS require，不启动 Nest 容器）。

### 一次性脚本要显式退出

开发态日志走 `pino-pretty`，其 transport 是独立 worker 线程，**不随 `app.close()` 结束**，会一直挂住
事件循环。一次性脚本（如 `scripts/seed-admin.ts`）关闭应用后需显式
`process.exit(process.exitCode ?? 0)`；生产 JSON 日志无此问题。

### 为什么不用 `nest` CLI（TypeScript 7 阻塞）

`@nestjs/cli@12`（对应 Nest 12）需要 TypeScript 的**编程式 compiler API**
（`ts.getParsedCommandLineOfConfigFile`），而本仓库统一锁 **TypeScript 7.0.2**（原生编译器，只提供
`tsc` 可执行文件，该 API 预计 7.1 回归）。实测装好 @nestjs/cli 后 `nest start --watch` 直接报：

> The installed TypeScript version (7.0.2) does not expose the programmatic compiler API that the
> Nest CLI requires. … Please install TypeScript 6 (e.g. "npm i -D typescript@^6") until then.

该 loader 在 `lib/compiler/typescript-loader.js`，被 `build.action.js` 无条件加载，
**任何 builder（tsc / swc / webpack / rspack）都过不去**。因此在 TS 7.1 之前：

- 开发态：`node --watch --import tsx/esm src/main.ts`（见上节，无需编译步骤、不引入新依赖）
- 构建：`tsc -p tsconfig.build.json`（`pnpm --filter @app/server build`）
- 生产：`node dist/main.js`（与 dev 同一条 ESM 语义路径）

要强行改用 nest CLI，就得把 TypeScript 降到 6（整仓或仅 server），代价是失去 TS 7 原生编译速度，
并多出 `@nestjs/cli` + `@angular-devkit/*` 一整套依赖与 `nest-cli.json` 配置。

## Development

```bash
pnpm dev:pkgs                        # 终端 1：watch 构建 @repo/kits 等 packages
pnpm --filter @app/server dev        # 终端 2：NestJS 服务（默认 9989）
```

服务监听 `PORT`（默认 `9989`）。

## Build

```bash
pnpm --filter @app/server build
pnpm --filter @app/server start:prod
```

## 数据库

```bash
pnpm db:gen <Name>   # 生成迁移
pnpm db:migrate      # 执行迁移
pnpm seed:admin      # 创建首个管理员
```
