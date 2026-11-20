# 架构与数据流（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> 开始任何任务前先阅读。

## 1. 工程是什么

billy-cli 是一套**全栈应用 Monorepo 模板**：pnpm + Turbo 构建，TypeScript 全栈。
后端「NestJS 薄边界 + 业务模块 + 通用能力封装（@repo/kits）」，按控制面 / 执行面 / 内网服务拆成
**6 个 Nest 进程**（main / agent-runtime / model-gateway / capability-gateway / common-capability /
workspace-service）；前端两套独立入口（Web 前台 / Admin 后台）。

## 2. 技术栈速览

| 层 | 选型 |
| --- | --- |
| 构建 | pnpm + Turbo（`turbo.json` 按依赖拓扑编排） |
| 服务端 HTTP | NestJS 12（`@nestjs/core` + `@nestjs/common` + `@nestjs/platform-express`，底层 Express 5）；**6 个进程**：`apps/main`（`@app/main`，公网 BFF，9989）+ `apps/agent-runtime`（`@app/agent-runtime`，只跑 agent loop，9990，不对外）+ 四个内网服务 `model-gateway`（9992，模型网关）/ `capability-gateway`（9993，能力目录 / 路由 / 审计）/ `common-capability`（9994，通用能力执行）/ `workspace-service`（9995，工作区执行面） |
| 服务端推流 | `@repo/kits` 的 `StreamHub`（`POST /sse/subscribe` 长连接 + Redis pub/sub 跨实例广播）+ `@repo/http-client` 的 `HttpStreamClient`（浏览器 / Node 双环境，默认 POST + Bearer 认证）；**AI 流式另用 pub/sub 定向频道**：runtime 把模型输出发 `agent:stream:client:<clientId>`，main 的 `AgentSseBridge` 订阅后写回前端 SSE（Kafka 当前无业务 topic） |
| 服务端日志 | 自建 logger（`@repo/shared/logger` 的 `createLogger`，**不用 nestjs-pino**）：kits `LoggerModule` 建唯一 pino 实例（pino-pretty 开发美化；生产可多目标 transport 推送 pino-loki；redact 脱敏），`AppLogger` 供业务注入、`NestLoggerAdapter` 接管 Nest 框架日志；请求日志由 `@repo/kits` 的 `RequestLoggerMiddleware` 自记录 |
| 业务位置 | 控制面业务全归 main：`apps/main/src/modules/<业务>/{module, controller, service, repository, errors, index}`（auth / admin / user / session / storage / share / monitor / stream / ops / runtime-config / ai-model / ai-usage / ai-admin（conversation / file / tool / capability / skill / workspace））+ 全部 AI 配置 CRUD |
| agent 运行面 | 只在 `apps/agent-runtime/src/modules/ai/**`（agents / runtime / core(tools,prompts,skills) / tools（本地编排）/ files、memory（@repo/ai-data 的薄封装）/ skills / mastra）；**Mastra 只在这里出现**，`pnpm check:mastra` 守边界；**执行体不在本服务**（bash / 文件在 workspace-service，联网 / 记忆 / 取页在 common-capability） |
| 通用能力 | `@repo/kits`（一个基础设施一个目录 = `provider + <name>.config.ts + <name>.module.ts + index.ts`，均 `@Global()` + `XxxModule.forRoot(options)` / `forRootAsync(options)`，配置对象即模块自身 bean，无业务实体） |
| 应用配置 | `AppConfigFacade`（bootstrap 前用 Zod 加载校验 + 缓存）+ `@nestjs/config` 的全局 `ConfigService`（各模块 `forRootAsync` 惰性取命名空间分片；应用级业务配置由业务层 `resolveServerConfig(config)` 取 `server` 分片，不单设配置 bean） |
| 依赖注入 | NestJS 内建 DI（`@nestjs/common` 的 `@Injectable` / `@Inject` / `@Optional` + 构造器注入 + 生命周期钩子） |
| ORM | TypeORM（`@repo/kits` 的 `Db`；**实体与迁移的唯一来源是 `@repo/db`**（`packages/db/src/entities` / `packages/db/src/migrations`），六个 Nest 服务共用同一份，PostgreSQL） |
| 数据结构 / 共享 | Zod + 字典 + 响应工具（`@repo/shared`） |
| 前台 | Next.js 16 App Router + Base UI + shadcn/ui + Tailwind 4（`apps/web`，9840） |
| 后台 | Next.js 16 + `@repo/ui`（shadcn/ui）+ TanStack Query / Table / Form（`apps/admin`，9845） |
| API 客户端 | `@repo/http-client`（通用 HTTP 客户端：请求 + SSE 流式推送，浏览器 / Node 双环境）+ `@repo/sdk`（业务全类型化 ServerClient） |

## 3. 分层架构与依赖方向（最重要的心智模型）

```
apps/main       公网 BFF：NestJS HTTP 边界 + 控制面业务模块 + 配置 + 唯一组合根（9989，对外）
               · common/security/  仅剩 main 专属的访问控制（token 与身份读取 · 限流守卫 ·
                                   「任一身份」守卫编排）；它依赖应用级 ServerConfig，故不进 kits
               · 横切 HTTP 构件（错误 / 请求上下文 / 请求日志 / 请求指标 / Zod 校验 / 响应信封）
                 已在 `@repo/kits` 的 `packages/kits/src/http/`，各服务共用一份
               · modules/<业务>/  module / controller / service / repository / errors / index
                               （auth / admin / user / session / storage / share / monitor / ops /
                                 runtime-config / ai-model / ai-usage / ai-admin/*）
               · agent/         /agent 的转发与 pub/sub→SSE 中继（AgentSseBridge）
               · app-config.ts  serverAppConfigSchema + mapServerEnv + loadServerAppConfig
               · root.module.ts 组合根：AppConfigModule + 各基础设施 forRootAsync + 业务模块 imports
apps/model-gateway  模型网关：canonical OpenAI 接口（/v1/models/{id}/chat/completions）+ 模型目录
               · 4 套协议适配（openai-compatible / deepseek / anthropic / ollama），持有供应商 key
               · 只读 ai_providers / ai_models；不碰会话 / 时间线 / ai_files（9992，不对外）
apps/capability-gateway  能力目录权威：服务登记 / 心跳 / 能力目录 / 授权过滤 / 调用路由 / 限流校验 /
               MCP client / ai_tool_audit / 内建 wait-task·cancel-task·tool-search（9993，不执行能力）
apps/common-capability  通用能力执行：登记服务 `common`（9 个能力：memory 3 / web 3 /
               read-tool-result 1 / file-submit·file-download 2）（9994，不对外）
apps/workspace-service  工作区执行面：工作区生命周期（ensure/stop/destroy/status/exec/fs）+
               容器 / k8s Pod 驱动 + 空闲回收；登记服务 `workspace`（bash + 文件 7 个）（9995，不对外）
apps/agent-runtime  agent 运行面：只跑 agent loop，只暴露 /internal/agent/* 与运维探针（9990，不对外）
               · modules/ai/    api/（AgentInternalController，唯一业务 controller）+ agents / runtime /
                               core / tools（本地编排：plan / 子 agent / 技能库 / 网关任务）/ files、memory
                               （@repo/ai-data 薄封装）/ skills / mastra
               · modules/       ops（模型目录与服务能力目录分别来自 model-gateway 与 capability-gateway）
               · 与 main 同构的 app-config.ts / config.ts / root.module.ts / main.ts
   ↓ 两者都只依赖
@repo/kits    后端通用能力封装：一个基础设施一个目录（provider + <name>.config.ts +
              <name>.module.ts + index.ts，均 @Global + XxxModule.forRoot(options)）
              · db/           Db 统一入口（连接生命周期）/ DbService（注入式数据操作统一入口：四种分页 +
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
              · http/         横切 HTTP 构件：error（错误码映射 · 边界错误 · 全局异常过滤器 ·
                              告警钩子）/ request-context（@Global：ALS 上下文 + 自注册中间件）/
                              request-logger / request-metrics（@Global：自注册埋点中间件）/
                              Zod 校验管道 / 响应信封拦截器 / 运维探针路径
              · 配置对象即模块自身注入 bean；未 import 即未装配；实体由 `@repo/db` 的
                `DB_ENTITIES` 在 app 的 `DbModule.forRootAsync` 工厂里注入（类引用无法来自环境变量）
@repo/db      TypeORM 实体 + 迁移的唯一来源：`packages/db/src/entities` / `packages/db/src/migrations`，
              导出 `DB_ENTITIES` / `DB_MIGRATIONS`，各服务的组合根与迁移 CLI 的 DataSource 直接复用；
              app 内不再有 `src/database/entities/*` 薄壳，模块直接用 `@repo/db`
   ↑ 依赖 kits（BaseEntity），被 main / agent-runtime 依赖
@repo/monitor 监控引擎（指标采集 / 规则评估 / 告警 / 通知）+ `MonitorModule.forRootAsync`：
              main 与 agent-runtime 各装配一份（各自监控自己）；HTTP API 只在 main 的
              `modules/monitor/api`
   ↑ 依赖 kits / shared / db，被 main / agent-runtime 依赖
@repo/contracts 跨服务契约（capability / tool / workspace / registry / model-gateway 的 Zod schema）
@repo/internal-sdk  内部服务 typed client（CapabilityGatewayClient / WorkspaceServiceClient /
              ModelGatewayClient / AgentRuntimeClient；统一 x-internal-token 与信封）
@repo/capability  能力声明机制：@CapabilityGroup / @CapabilityDecl / scanCapabilities / CapabilityRegistrar
@repo/ai-data  AI 数据能力：FileService / MemoryService / 工具结果分页 / 用量（main、runtime、worker 共用）
@repo/web-runtime  出网 / SSRF 校验 / HTML→Markdown / 按行分页 / 反爬（runtime、main、common-capability 共用）
@repo/shared  Zod schema（数据结构）+ dicts（错误码 / 字典）+ AppResponse（响应格式）
   ↑ 被 kits / main / agent-runtime / sdk / 前端共同依赖 —— 数据结构先行
@repo/sdk     ServerClient：全类型化业务 API 调用（前端 / 脚本使用）
@repo/http-client  通用 HTTP 客户端：请求管线 + SSE 客户端（fetch 流 + 状态机，认证凭证体系
                   CredentialsManager / AuthStrategy / CredentialProvider / CredentialResolver，
                   浏览器 / Node 双环境，零第三方依赖）
apps/web      前台（Base UI + shadcn，`@repo/ui`）
apps/admin    后台（`@repo/ui` + @tanstack/react-table + @tanstack/react-form）
```

**依赖方向不可逆**：`shared` 不依赖任何业务包；`kits` / `monitor` 不 import `apps/*`；`apps/main` 与
`apps/agent-runtime` 按依赖方向自底向上落代码。横切 HTTP 构件在 `@repo/kits`、不依赖具体业务模块
（技术错误告警通过 `ERROR_ALERT_HOOK` token 由 `root.module.ts` 注入 `MonitorEngine` 适配器）；
`apps/main/src/common/security/` 是 main 专属访问控制（依赖应用级配置）；controller 只做 HTTP 边界，
业务逻辑在 service / repository。

**六个服务的边界**（控制面 / 执行面 / 内网服务拆分之后）：

1. **前端只连 main（9989）**；runtime 与四个内网服务都没有 public controller，也不发 CORS。
   main 校验身份后带 `x-internal-token` / `x-user-id` / `x-admin-id` 调 runtime。
2. **main 不做 agent 执行、不执行能力**：不 import Mastra 编排、不跑工具循环；它只做转发、
   pub/sub→SSE 中继与全部控制面 CRUD。
3. **runtime 不做控制面 CRUD、不持执行体**：技能库 / 工具配置由 main 写库，runtime 靠事件
   （`ai.skill.changed`）或启动全量同步感知；bash / 联网 / 文件 / 记忆的执行在
   `common-capability` / `workspace-service`，runtime 只装配工具面（本地注册机 + 能力目录）。
4. **内网服务之间只走内网 HTTP + 内部令牌**：runtime → model-gateway / capability-gateway，
   capability-gateway → common-capability / workspace-service，common-capability → workspace-service。

## 4. 一次请求的数据流

1. 前端调用 `ServerClient.xxx.create(payload)`（`@repo/sdk`）。
2. 请求进入自注册的 Express 中间件（按 `imports` 顺序，均来自 `@repo/kits` 的 `http/`）：
   `RequestContextModule`（AsyncLocalStorage，生成 `requestId` 并写响应头 `X-Request-Id`）→
   `RequestLoggerMiddleware`（响应结束时记录 method / url / status / 耗时 / requestId /
   userId / adminId）→ 请求指标埋点中间件。
3. 守卫（`UserAuthGuard` / `AdminAuthGuard` / `RateLimitGuard`）在进入控制器前校验身份与限流，
   把 `userId` / `adminId` 写入请求上下文。4. `apps/main/src/modules/<业务>/<业务>.controller.ts` 用
   `@Body({ schema: Schema })` 做 **Zod 边界校验**，再调注入的 service。
5. service（可 `@Transactional()`）调 repository 读写 TypeORM。
6. 业务错误抛 `AppError` 子类（自带数字 `code`），由 `@repo/kits` 的
   `AppExceptionFilter` 经 `AppErrorCodes` 字典映射为 HTTP 状态码 + 中文文案；
   校验失败走 HTTP 200 + `{ code: 400 }`，未知错误一律 5001 / 500。
7. 成功由 `ResponseEnvelopeInterceptor` 统一包为 `{ code: 0, data }`（HTTP 200）。

**中间件顺序规定（Nest 12）**：模块中间件按模块 `distance` 排序装配，**`@Global()` 模块排在最前**
（`middleware-module.js` 把 `distance === Number.MAX_VALUE` 视为全局、权重 -1），全局模块之间再按
容器注册顺序（即组合根 `imports` 顺序）稳定排序。因此请求上下文模块必须：① 标 `@Global()`；
② 在 `imports` 里写在 `RequestLoggerModule` / `RequestMetricsModule` 之前。顺序错了的后果：
请求日志 / 指标中间件在响应结束时读不到 ALS 里的 `requestId` / `userId` / `adminId`
（日志丢掉登录身份、requestId 与响应头对不上）。

## 5. AI 对话流（跨 main / runtime 的链路）

```
前端 ──POST /agent/chat/stream──> main（AnyAuthGuard，生成 clientId）
                                   │ 带 x-internal-token + 身份头，转发到 runtime
                                   └──> agent-runtime（POST /internal/agent/chat/stream）
                                          │ 跑 agent loop（Mastra / 工具面 / 记忆 / 技能）
                                          │ 工具执行：本地注册机（计划 / 子 agent / 技能库 / 网关任务）
                                          │         + 能力目录（bash / 文件 → workspace-service，
                                          │           联网 / 记忆 / 取页 → common-capability）
                                          └─ Redis pub/sub：agent:stream:client:<clientId>
main（AgentSseBridge，`PubSub.subscribeAsync(agentStreamChannel(clientId))`）
  └─ AG-UI 帧原样写 data:；收尾 RUN_FINISHED + end()（默认不写 [DONE]）
```

- **AI 的配置 CRUD 与查询在 main，执行在 runtime**：模型 / 工具 / 能力服务 / 服务授权 / 技能 / 工作区 /
  记忆 / 会话 / 运行 / 时间线 / 用量的接口全在 `apps/main/src/modules/ai-admin/**` 与
  `ai-model` / `ai-usage`；真正跑 agent 的代码只在 `apps/agent-runtime/src/modules/ai/**`。
- **工具面 = 本地编排工具 + 能力目录**：本地注册机 4 组 18 个 key；目录里 `source='code'` 随工具面下发，
  `source='manual'`（MCP / 外部登记）用 `tool-search` 搜到后下一轮才进工具面。授权只写 key 或 `'*'`。
- **流式对话只依赖 Redis**：收件地址（`clientId`）存在 runtime 的进度 Hash 里，重连落在哪个副本都
  能找到；补发从 Redis 输出记录按 `sinceRev` 读，不是 broker 回放。`KAFKA_BROKERS` 当前没有业务 topic 依赖。
  2026-11-15 之前用 Kafka 承载这条流，实测 18 小时 1,536,196 条 / 686MB，且跨副本绑定是进程内的，
  已回退。默认出口协议是 `agui`（`RUN_FINISHED` 收尾、不写 `[DONE]`）；`?protocol=ai` 才逆映射回旧格式。
- **迁移入口在 `@repo/db`**：根脚本 `db:gen` / `db:migrate` 指向 `@repo/db`（CLI DataSource 在
  `packages/db/data-source.ts`），产物落在 `packages/db/src/migrations/`。
