# 去掉 nestjs-pino，改为自建 logger（@repo/shared createLogger）

> 需求（用户）：把 nestjs-pino 去掉，手动建 logger，复用 `@repo/shared` 的 `createLogger`。
> 状态：**已实施并实测通过**（2026-09-15）· 影响面：`packages/kits`、`packages/shared`、
> `apps/server`、依赖、文档与 skill
>
> 实施结果与本文差异：Loki **保留**（决策 1 选保留）；请求日志字段保持原样（决策 2）。
> 实施中另有两个发现：
> ① `pino-loki` 依赖必须声明在 `@repo/shared`（创建 pino 实例的包）——曾声明在 kits，
>    运行时报 `unable to determine transport target for "pino-loki"`（探针实测），已挪到 shared；
> ② `createLogger` 增加了 `child(context)`：pino 的 transport 每个实例起一个 worker，
>    每个宿主类各调一次 `createLogger()` 会拉起几十个 worker，故必须复用同一实例派生 child。
>
> 2026-09-17 修订：`RequestLoggerMiddleware` 改为**注册时捕获 ALS store 引用**（原为 `finish` 时
> `requestContext.get(...)`）。`requestContext.run(store, () => next())` 的作用域在 `next()` 返回时
> 即退出，普通请求只因 `end()` 同步发生在处理链路内才读得到；SSE 长连接的响应结束来自 socket 的
> 异步上下文，那时 store 已不在 —— 长连接日志的 requestId / userId / adminId 全为 null（响应头与
> 日志对不上）。已补回归用例：`apps/server/test/request-logger.test.ts` 在作用域外触发 finish。
>
> 2026-11-13 核对：方案与实现一致，补充当前事实 —— ① `packages/kits/src/foundation/logger/`
> 现有 `logger.config.ts` / `logger.options.ts` / `logger.providers.ts`（`LOGGER_INSTANCE` token）/
> `app-logger.ts` / `nest-logger.ts` / `logger.module.ts` / `index.ts`；② 整应用**唯一** pino 实例
> 由 `LoggerModule` 的 `LOGGER_INSTANCE` factory 建一次，`AppLogger` 与 `NestLoggerAdapter` 都走
> 它的 `child(context)`；③ 注入 `@Inject(AppLogger)` 的类已从当时的 19 个增长到 59 个
> （server 45 + kits 14，`grep -rl "Inject(AppLogger)" apps/server/src packages/kits/src | wc -l`），
> 接口未变；④ 本文 §7 两个「待确认决策」均已落定：Loki 保留、请求日志字段保持原样。

## 1. 关键认识（决定改造成本）

`nestjs-pino` 只提供两样东西：

| 它提供的 | 本质 | 去掉后要不要自己补 |
| --- | --- | --- |
| `Logger` / `PinoLogger`（Nest `LoggerService` 适配） | 把 pino 接进 Nest 的 `app.useLogger` 与 `INQUIRER` 注入 | **要**：自己写一个 ~30 行的 `LoggerService` 适配器 |
| `pino-http` 中间件（请求日志） | 每条请求的 method / url / status / duration 自动记录 | **要**：自己写请求日志中间件 |

而下面这些**是纯 pino 能力，跟 nestjs-pino 无关**，去掉它并不会丢：

- `transport`（`pino/file` 落盘 + `pino-loki` 推送，多目标）
- `redact`（`authorization` / `cookie` 脱敏）
- `level` / `pretty` / 子 logger `/ context`

> 结论：**这是一次「把两处 Nest 适配自己实现」的改造，不是能力削减**。
> 唯一需要动 `@repo/shared` 的是给 `createLogger` 增加一个可选参数，把 `redact` /
> `transport` 透传给 pino（现有三个位置参数保持不变，向后兼容）。

## 2. 现状（本次要替换的）

```
packages/kits/src/foundation/logger/
  logger.config.ts    LoggerConfig（prefix / level / pretty? / loki?）+ 配置 token
  logger.options.ts   buildLoggerParams() → nestjs-pino Params（pino-http 配置、redact、
                      genReqId、customProps、pretty/loki/file transport）
  app-logger.ts       可注入 AppLogger（TRANSIENT + INQUIRER → context=宿主类名）
  logger.module.ts    @Global + 包 nestjs-pino LoggerModule.forRoot(+Async)
  index.ts            转出 nestjs-pino 的 Logger / PinoLogger
packages/shared/src/logger.ts   createLogger(name, pretty, level) → 仅 name/level/pretty
```

- 请求日志：由 `pino-http` 自动记录；requestId 走 `genReqId`（读响应头 `X-Request-Id`），
  登录身份走 `customProps`（读 ALS）。
- **中间件顺序规定**正是为 pino-http 立的：`RequestContextModule` 必须 `@Global` 且写在
  `LoggerModule` 之前，否则 `req.id` / `customProps` 取不到值。
- 业务侧 **19 个类注入 `@Inject(AppLogger)`** —— 这次改造必须让它们**一行不改**。

## 3. 目标形态

```
packages/shared/src/logger.ts
  createLogger(name, pretty, level, options?: { redact?: string[]; transport?: unknown })
   ↑ 仅新增可选第 4 参；admin 现有调用不受影响

packages/kits/src/foundation/logger/
  logger.config.ts    不变（prefix / level / pretty? / loki?）
  logger.options.ts   改为 buildPinoOptions()：返回纯 pino options（redact / transport），
                      不再产出 nestjs-pino Params、不再有 pino-http 段
  logger.providers.ts 新增：`LOGGER_INSTANCE` token —— 整应用唯一的 pino 实例
                      （pino transport 每个实例起一个 worker，故只建一次）
  app-logger.ts       底层由 PinoLogger 改为 `LOGGER_INSTANCE.child(context)`；接口与调用签名不变
  nest-logger.ts      新增：NestLoggerAdapter implements LoggerService（log/error/warn/
                      debug/verbose），把 Nest 框架日志转到同一 pino 实例
  logger.module.ts    @Global + 纯模块：提供 LoggerConfig + LOGGER_INSTANCE + AppLogger + NestLoggerAdapter
                      （`forRoot` / `forRootAsync` 两种装配）
  index.ts            不再转出 nestjs-pino 的 Logger / PinoLogger

apps/server/src/common/request-logger/    新增（横切 HTTP 构件）
  request-logger.middleware.ts   记录 method / url / status / durationMs / requestId /
                                 userId / adminId；按状态码分级（<400 info、4xx warn、5xx error）；
                                 运维探针路径（`/healthz`、`/readyz`）不记
  request-logger.module.ts       @Global + configure() 自注册，必须排在 RequestContextModule 之后
apps/server/src/main.ts          去掉 `app.useLogger(app.get(Logger))`（nestjs-pino 的 Logger），
                                 改为 `app.useLogger(app.get(NestLoggerAdapter))`；
                                 `bufferLogs: true` 保留（Nest 会缓冲到 useLogger 生效）
```

`AppLogger` 的语义保持不变（这是本方案最大的收益点）：

- `Scope.TRANSIENT` + `@Inject(INQUIRER)` 取宿主类名 → `logger.setContext(类名)`；
- 调用签名 `(message?, data?)`；`data` 为普通对象并入结构化字段，
  `RESERVED_KEYS`（name/msg/level/time/pid/hostname/context）收进 `data` 子对象；
- `IAppLogger` 接口不变 → 业务侧注入点（当时 19 处，现 59 处）与
  `apps/server/test/helpers/logger.ts` 全不用动。

## 4. 关键流程

1. **启动日志**：`NestFactory.create(RootModule, { bufferLogs: true })` 缓冲 → `app.useLogger(adapter)`
   → 缓冲的框架日志（InstanceLoader / RoutesResolver…）经 adapter 落到 pino。
2. **请求日志**：`RequestContextModule`（写 ALS + `X-Request-Id`）→ `RequestLoggerModule`
   （`res.on('finish')` 时从 ALS 取 requestId / userId / adminId，汇总一条结构化日志）。
   顺序要求与现在**方向一致但要改归属**：由「排在 LoggerModule 之前」改为
   「排在 RequestContextModule 之后」（前者是 kits 模块，后者是 app 构件）。
3. **脱敏**：pino `redact` 路径不变（`req.headers.authorization` / `req.headers.cookie` /
   `res.headers["set-cookie"]`），由 `buildPinoOptions()` 传下去。
4. **Loki**：生产 + 配置 `loki` → `transport.targets = [pino/file, pino-loki]`，与现在一致。

## 5. 影响面清单

- 依赖：`packages/kits` 去掉 `nestjs-pino`、`pino-http`；**保留 `pino-loki`**（transport 用）；
  `pino` / `pino-pretty` 留在 `@repo/shared`（`createLogger` 用）。
- 代码：上表 8 个文件；`apps/server/src/main.ts`；`root.module.ts` 的 imports 注释与顺序；
  `common/request-context/*` 里 3 处「pino-http」注释。
- 文档 / skill：README（后端日志整节）、`architecture.md`（日志行 + 中间件顺序规定 + 数据流第 2 步）、
  `billy-dev-foundation/SKILL.md`（若提到 nestjs-pino）、`develop-backend-api`（可观测性）、
  `docs/design/backend-kits-refactor.md`？（历史文档不改）、dev-log。
- 记忆：MEMORY 里「后端日志已按 rihel-base 方式改造为 nestjs-pino」这条要更新。

## 6. 测试点

- `AppLogger`：context 取宿主类名、`(message, data)` 结构、RESERVED_KEYS 归入 `data`、level 过滤（kits 单测）。
- `NestLoggerAdapter`：Nest 的 `log(msg, context)` 两个位置参数落到 pino 的 msg + context。
- `createLogger` 新参数：redact 生效、transport 透传、不传时行为与现在完全一致（shared 单测，若有）。
- 请求日志中间件：状态码分级、duration 有值、从 ALS 取 requestId/userId、abort（未 finish）不丢日志。
- 冒烟：`pnpm dev:server` 启动日志（缓冲后输出）、一次 curl 的请求日志字段、`pnpm check:inject`。

## 7. 待确认决策

> 2026-11-13：两条决策均已落定 —— **Loki 保留**（`pino-loki` 在 `@repo/shared`，`LOKI_HOST` 配了
> 且非生产美化时才走多目标 transport）、**请求日志字段保持原样**（method / url / status /
> durationMs / requestId / userId / adminId，按状态码分级）。

1. **Loki 保留还是去掉？**（保留 = `pino-loki` 留在 kits、`createLogger` 增加可选 transport 参数；
   去掉 = 少一个依赖 + `logger.config.ts` 的 `loki` 分支删除，但生产失去日志聚合推送。）
2. **请求日志字段是否要增减？**（默认保持现状：method / url / status / duration / requestId /
   userId / adminId，按状态码分级。）

## 8. 现状核对（2026-11-13）

| 项 | 现状 |
| --- | --- |
| 日志配置来源 | `apps/server/.env.example`：`LOG_LEVEL`（默认 info）、`LOKI_HOST`（不配则不打 Loki）；prefix 固定 `server`，pretty 由 `NODE_ENV` 推导 |
| 实例数 | 整应用**一个** pino 实例（`LOGGER_INSTANCE`），其余全部 `child(context)` 派生 |
| 框架日志 | `main.ts` 的 `app.useLogger(app.get(NestLoggerAdapter))`，`bufferLogs: true` |
| 业务日志 | `@Inject(AppLogger)`（`Scope.TRANSIENT`，context 自动取宿主类名）；共 59 处（server 45 + kits 14） |
| 请求日志 | `apps/server/src/common/request-logger/`；`root.module.ts` 的 imports 顺序 `RequestContextModule` → `RequestLoggerModule` → `RequestMetricsModule` |
| 脱敏 | `REDACT_PATHS` = `req.headers.authorization` / `req.headers.cookie` / `res.headers["set-cookie"]`（`logger.options.ts`） |
| 测试 | `apps/server/test/request-logger.test.ts`、`packages/kits/test/logger.test.ts` |
