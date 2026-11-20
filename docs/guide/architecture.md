# 架构与项目结构

> 这一篇回答「东西放在哪、依赖往哪流、启动时谁先装配」。
> 方案为什么这么定，见 [design/](../design/) 下的专题；AI 能力见 [ai.md](./ai.md)。

## 项目结构

```
├── apps/
│   ├── main/                            # 公网 BFF（@app/main，9989）；实体唯一来源 @repo/db，没有 src/database/entities
│   │   ├── src/
│   │   │   ├── main.ts                  # 入口：NestFactory 启动 + 全局 Express 配置 + 优雅关闭
│   │   │   ├── root.module.ts           # 唯一组合根：配置 + 横切中间件 + 各基础设施 + 业务模块
│   │   │   ├── app-config.ts            # 应用配置 schema（复用 kits 各模块 schema）+ mapServerEnv + loadServerAppConfig
│   │   │   ├── config.ts                # ServerConfig 类型（= ServerAppConfig['server']）+ resolveServerConfig(config)
│   │   │   ├── agent/                   # /agent 入口与控制接口（chat / resume / stop / 重连 / 快照 / run 队列）：
│   │   │   │                            #   agent-control.controller / agent-run-queue.{controller,service}；
│   │   │   │                            #   agent-catalog.service（代理 runtime 的 status / list / tools / instructions，30s 缓存）；
│   │   │   │                            #   agent-sse.{controller,bridge}（bridge 订阅 Redis PubSub → 写 SSE）
│   │   │   ├── common/security/         # 仅 main 专属访问控制：token / 身份读取 + 限流守卫 + 「任一身份」编排
│   │   │   │                            #   （横切 HTTP 构件在 @repo/kits 的 src/http/，各 app 共用）
│   │   │   └── modules/                 # 业务模块（13 个）：auth / admin / user / session / storage / share /
│   │   │                                #   stream / monitor / ops / runtime-config / ai-model / ai-usage /
│   │   │                                #   ai-admin（conversation / file / tool / capability / skill / workspace
│   │   │                                #   六个子模块 + 根级 memory.controller.ts）
│   │   │                                #   每模块 module + controller + service + index（repository / errors 按需）
│   │   └── scripts/                     # seed-admin.ts（首个管理员种子，根脚本 seed:admin 指向这里）+ copy-assets.ts
│   ├── agent-runtime/                    # agent loop（@app/agent-runtime，9990，只给 main 调）
│   │   ├── scripts/                     # backfill-subconversations.ts（历史子会话回填）+ copy-assets.ts
│   │   └── src/
│   │       ├── main.ts / root.module.ts / app-config.ts / config.ts   # 与 main 同构的装配骨架
│   │       └── modules/
│   │           # 模型配置与用量不在 runtime（模型经 model-gateway 目录，用量落 main 与 model-gateway）；
│   │           # 也没有 auth / user / storage / share 等控制面模块
│   │           ├── ai/                   # agent loop 主体
│   │           │   ├── api/              # 只暴露 /internal/agent/*（status / list / tools / instructions /
│   │           │   │                     #   chat / chat/stream / chat/resume / run stop 与重连、快照）
│   │           │   ├── agents/           # agent 声明与注册表 + 指令渲染（工具清单首轮渲染后落 system 快照）
│   │           │   ├── core/             # 工具引擎（装饰器 / 注册机 / 网关插件链 / 工具配置 / 取页）+
│   │           │   │                     #   技能加载（SkillLoader + catalog）/ 提示词（eta 模板）/ 错误与信封
│   │           │   ├── runtime/          # 上下文 / 流式与续传 / 恢复 / 子 agent / run 队列 / 模型解析 /
│   │           │   │                     #   能力目录装配（gateway-capability-catalog）与远程能力调用（remote-tool.client）
│   │           │   ├── tools/            # 只留本地编排工具：规划四件套 + 子 agent + 技能库 + 网关任务
│   │           │   ├── files/            # 入站附件的登记与物化
│   │           │   ├── memory/           # 长期记忆抽取 + 短期 thread（Redis）清理
│   │           │   ├── skills/           # 技能落盘与热加载（DB 是事实源，Redis EventBus 通知变更）
│   │           │   └── mastra/           # 唯一能 import @mastra/* 的地方（agent / stream / tool / memory 适配）
│   │           └── ops/                  # 探针（监控引擎来自 @repo/monitor）
│   ├── model-gateway/                    # 模型网关（@app/model-gateway，9992，内网）；不跑 agent loop、不碰会话 / 时间线 / 文件表
│   │   └── src/
│   │       ├── catalog/                  # 模型目录（缓存 30s）
│   │       ├── chat/ protocols/          # /v1/models/{modelId}/chat/completions（canonical OpenAI）+
│   │       │                             #   openai-compatible / deepseek / ollama / anthropic 四套适配
│   │       ├── keys/                     # 上游 key 池（冷却 / 额度）
│   │       ├── usage/                    # 用量落库（价格快照 + cost）
│   │       └── cache/ http/ health/ sync/  # 模型变更订阅（缓存失效）/ 内部 token 守卫 / 探针 / 供应商连通性测试
│   ├── capability-gateway/               # 能力目录权威（@app/capability-gateway，9993，内网）；不执行能力
│   │   └── src/
│   │       ├── registry/                 # /v1/services/*、/v1/capabilities/*、/v1/tasks/*、/v1/instances/* +
│   │       │                             #   服务登记 / 心跳 / 授权过滤 / 服务路由 / MCP client /
│   │       │                             #   tool-search（BM25）/ 内建 wait-task·cancel-task / SSRF 目标校验
│   │       ├── audit/                    # ai_tool_audit 落库
│   │       ├── gateway/                  # 探针（/healthz /readyz）
│   │       └── config/ http/             # 配置 / 内部 token 守卫 / zod 校验
│   ├── common-capability/                # 通用能力执行（@app/common-capability，9994，内网）
│   │   └── src/
│   │       ├── capabilities/             # 服务清单（一个进程 = 服务 common，能力由装饰器扫描聚合）
│   │       ├── tools/                    # memory / web / read-tool-result / 文件收发执行体（9 个能力）
│   │       ├── executors/                # 执行器注册（按能力 key 找执行方法）
│   │       ├── invoke.controller.ts      # 网关回连的 /invoke 入口
│   │       ├── task.manager.ts / active-task.counter.ts   # 长任务（mode='task'）受理、轮询与取消
│   │       └── worker.service.ts         # 启动登记 / 10s 心跳 / 停机注销
│   ├── workspace-service/                # 工作区执行面（@app/workspace-service，9995，内网）；只读 ai_workspaces，不写表、不持 provider key
│   │   └── src/
│   │       ├── workspace/                # 工作区生命周期（ensure / stop / destroy / status / exec / fs）+
│   │       │                             #   容器驱动（docker / k8s Pod）/ 本地沙箱 / 空闲回收（默认 2h，每 60s 巡检）
│   │       ├── capabilities/             # bash + 工作区文件 7 个能力的声明、登记与长任务
│   │       └── config/                   # 端口 / 内部 token / 容器后端 / 镜像 / 回收参数
│   ├── web/                             # Next.js 16 前台（@app/web，端口 9840）
│   │   └── src/
│   │       ├── actions/auth.actions.ts  # Server Actions（登录 / 注册）
│   │       ├── app/                     # /、/account（个人中心，受保护）、/account/sessions（登录设备）、
│   │       │                            #   /auth/*、/comparison、/markdown/*
│   │       │                            #   + error.tsx / not-found.tsx / loading.tsx 应用级兜底
│   │       ├── components/landing/       # 首页区块（header / hero / proof-strip / tech-marquee / ai-section /
│   │       │                            #   observability / design-showcase / maintainability / quick-start / cta / footer / reveal）
│   │       ├── lib/                     # constants / server-client（SDK 单例）/ auth-session（服务端会话探测）/ redirect（?next= 过滤）
│   │       ├── proxy.ts                 # 受保护路由守卫（无 cookie → 307 到登录页，matcher 只挂 /account/*）
│   │       ├── providers/               # QueryProvider（TanStack Query + 统一错误 toast）/ WebStorageProvider（上传）/ ThemeProvider（主题）
│   │       └── stores/                  # theme.ts（主题状态）
│   └── admin/                           # Next.js 16 管理后台（@app/admin，端口 9845）
│       └── src/
│           ├── actions/auth.actions.ts  # Server Actions（@repo/ui defineAction）
│           ├── app/
│           │   ├── (app)/              # 应用壳（登录守卫）：auth/login + main/*
│           │   ├── (share)/s/[token]/  # 免授权文件分享页（独立 root layout，不走登录守卫）
│           │   └── api/[[...route]]/   # Hono 内容接口（转发字节，浏览器看不到 OSS 地址）
│           │   # main/：dashboard / user-center / system/{users,admins}
│           │   #   / monitor/{status,live,metrics,logs,rules}
│           │   #   / ai/{models,usage,keys,skills,skills/[skillKey],memories,files,workspaces,capabilities,authorizations,audit}
│           │   #   其中会话工作台 chat（(standalone)）与技能编辑器 skills/[skillKey]（(canvas)）用沉浸式布局；
│           │   #   /ai/tools 与 /ai/chat 只是旧入口重定向
│           ├── api/                     # app.ts / share.ts（Hono 路由，挂载到 app/api/[[...route]]）
│           ├── components/              # AppHeader / AppMenu / AppSider + share-dialog / file-preview-dialog 等
│           ├── lib/                     # constants / server-client / logger / sections（顶层菜单判据）
│           ├── providers/AppProviders.tsx
│           ├── stores/                  # auth.store.tsx（Zustand + Immer）/ theme.store.ts
│           └── proxy.ts                 # 中间件路由守卫（cookie）
├── packages/
│   ├── shared/                          # @repo/shared — Zod schema 单一事实源
│   │   └── src/
│   │       ├── schema/                  # 23 个 Zod schema（base / app-config / auth / user / admin / object-storage /
│   │       │                            #   stream / monitor / session / agent / agent-run-queue / ai-model / gateway-usage /
│   │       │                            #   ai-tool / ai-tool-event / ai-skill / share / ai-memory / agent-stream-frame /
│   │       │                            #   agent-run-snapshot / capability-service / service-grant / workspace）
│   │       ├── dicts/                   # 11 个字典（app-error-code / user-status / ai / ai-tool / ai-tool-event / ai-model /
│   │       │                            #   ai-provider-endpoint / ai-capability / ai-modality / ai-skill / ai-memory）
│   │       ├── app-response.ts          # AppResponse 统一响应格式 + ResponseUtils
│   │       ├── logger.ts                # 日志工厂 createLogger（前后端共用；后端经 kits LoggerModule 包装成 AppLogger）
│   │       ├── agui/                    # AG-UI 帧编解码（流式协议）
│   │       ├── browser.ts               # 浏览器端子入口
│   │       └── utils/                   # nanoid / dayjs / md5 / tree / dict / user-agent / file-kind（文件类型判定唯一来源）
│   ├── kits/                            # @repo/kits — 后端通用能力封装（无业务实体）：17 个目录 / 23 个 @Global() 模块
│   │   └── src/
│   │       ├── foundation/              # 横切基础：command / config（env·memory·consul loader + AppConfigFacade）/
│   │       │                            #   errors / id-generation / logger / scheduler / time-wheel
│   │       ├── http/                    # 横切 HTTP：错误 / 请求上下文 / 请求日志 / 请求指标 / zod 校验 /
│   │       │                            #   响应信封 / ops-probe（各 app 共用）
│   │       ├── db/                      # Db / DbService 统一入口 + DbModule：create-db / db / db.service /
│   │       │                            #   db.config / base-entity / audit-entity / audit-subscriber /
│   │       │                            #   pagination / batch / safe-delete / sql / database.module
│   │       ├── redis/                   # RedisStore / RedisLockService / RedisListCache + RedisModule
│   │       ├── rate-limit/              # RateLimiter + RateLimitModule（复用 RedisConfig）
│   │       ├── pubsub/                  # PubSub + PubSubModule（Redis 底层广播：懒建连 / 断线重订阅 / 自回环过滤）
│   │       ├── stream/                  # StreamHub / StreamConnection + StreamHubModule（SSE，建在 PubSub 上）
│   │       ├── events/                  # EventBus + EventBusModule（events:<topic> 进程内事件总线，建在 PubSub 上）
│   │       ├── jwt/                     # TokenSigner + JwtModule（JwtConfig）
│   │       ├── session/                 # SessionStore + SessionStoreModule
│   │       ├── password/                # PasswordHasher + PasswordModule（PasswordConfig）
│   │       ├── storage/                 # ObjectStorage + ObjectStorageModule + providers/{s3,cos}
│   │       ├── workspace/               # WorkspaceRuntimeService（seatbelt / bwrap 本地沙箱、三档模式、fail closed）+
│   │       │                            #   WorkspaceConfig + WorkspaceModule（workspace-service 的 local 后端与探针仍用它）
│   │       ├── kafka/                   # KafkaService / @KafkaConsumer + KafkaModule（KAFKA_BROKERS 存在才装配）
│   │       ├── lark/                    # LarkClient + LarkModule（LarkConfig，可选装配）
│   │       ├── notification/            # Notifier + file / email / lark-notify + NotificationModule
│   │       └── telemetry/               # Telemetry + TelemetryModule
│   │       # 每个目录：provider + <name>.config.ts（如需配置）+
│   │       #   <name>.module.ts（@Global；需要配置的再给 forRoot / forRootAsync）+ index.ts
│   ├── db/                              # @repo/db — TypeORM 实体（26 个）+ 迁移（38 个）+ DB_ENTITIES / DB_MIGRATIONS（唯一来源）
│   │   # CLI 也归这里：data-source.ts + 根脚本 db:gen / db:migrate
│   ├── monitor/                         # @repo/monitor — 监控引擎（采集 / 规则 / 告警 / 通知），仅 main 与 agent-runtime 装配
│   ├── ai-data/                         # @repo/ai-data — FileService / MemoryService / 工具结果分页 / 用量（无 Nest module）
│   ├── contracts/                       # @repo/contracts — 跨 app 契约（capability / tool / workspace / registry / model-gateway）
│   ├── internal-sdk/                    # @repo/internal-sdk — 内部 HTTP 客户端 + 四个服务的 typed client
│   ├── web-runtime/                     # @repo/web-runtime — 出网 / SSRF 校验 / HTML→Markdown / 按行分页 / 反爬识别（runtime / main / common-capability 共用）
│   ├── capability/                      # @repo/capability — 能力声明机制（@CapabilityGroup / @CapabilityDecl / scanCapabilities）
│   ├── http-client/                     # @repo/http-client — 通用 HTTP + 鉴权管线（业务无关）
│   │   └── src/
│   │       ├── core/                    # http.client / credential-resolver / auth-injector / api-error
│   │       ├── stream/                  # HttpStreamClient + stream-parser / stream-transport（SSE 客户端）
│   │       ├── transport/               # HttpTransport：无凭证的原始请求 / 流（非 2xx 不抛，SSE / NDJSON 逐块消费）
│   │       ├── strategies/              # BearerToken / ApiKey / OAuth2 / HMAC
│   │       ├── managers/                # localStorage / memory / cookie / env
│   │       └── providers/               # empty-check / expires-at
│   ├── sdk/                             # @repo/sdk
│   │   └── src/
│   │       ├── server.client.ts         # ServerClient（15 个分组，继承 http-client 的 HttpClient）
│   │       └── app-clients.ts           # createAppClients：浏览器单例 / 服务端无状态客户端的装配（web、admin 共用）
│   └── ui/                               # @repo/ui — shadcn 组件（src/components/ui/*，61 个）+ 自有组件（src/components/* 平铺）
│                                         #   + ai-elements（48 个 AI 界面组件）+ 设计系统（src/globals.css，唯一定义处）
├── docker/                              # Dockerfile.base + 6 个 Nest 服务各一份 + .web / .admin + .workspace-image + init-db.sql
├── k8s/                                 # 6 个 Nest 服务的清单（Namespace / ConfigMap / Deployment / Service / PDB / HPA /
│                                        #   Ingress / Ingress-SSE / PVC + RBAC + 部署说明；内网服务不接公网 Ingress）
├── docs/                                # guide/（使用指南）/ design/（设计文档）/ dev-logs/（开发日志）
│                                        #   + pagination.md / queue.md / sdk-refactor.md / billy-pitch.md
├── scripts/                             # setup.ts（bootstrap）、kill-dev.ts、kill-ports.ts、check-*.ts 四道守卫、
│                                        #   start-standalone.ts、clean.ts、codegraph-setup.ts
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## 分层与数据流

```
浏览器 ── POST JSON ──→ Next.js（Server Actions / 客户端 SDK）── POST JSON ──→ main（9989）
                       （SSR / 免授权分享页）                                   │
                                                                                ├─ 控制面 service ──→ PostgreSQL（TypeORM）
                                                                                ├─ 控制面 service ──→ Redis / S3 / COS
                                                                                └─ /agent/* ── 内部 HTTP（token + 身份头）
                                                                                      │
                                                                                      ▼
                                                                         agent-runtime（9990）
                                                                                ├─ agent loop（Mastra）
                                                                                ├─ 模型 ──→ model-gateway（9992）──→ 上游供应商
                                                                                ├─ 工具面 ──→ capability-gateway（9993）
                                                                                │              ├─→ common-capability（9994）
                                                                                │              ├─→ workspace-service（9995）──→ 工作区容器（docker / k8s Pod）
                                                                                │              └─→ MCP 服务（HTTP）
                                                                                └─ Redis pub/sub（agent:stream:client:<clientId>）
                                                                                      ──→ main 的 AgentSseBridge ──→ 浏览器 SSE
```

分层规则：`apps/main`（公网 HTTP 适配 + 控制面业务模块）与 `apps/agent-runtime`（agent 执行面）
→ `@repo/kits`（通用能力）/ `@repo/ai-data`（AI 数据能力）→ 外部资源（DB / Redis / S3 / COS）。
四个内网服务同样只依赖 `packages/*`（各自只装用得到的 kits 模块；契约走 `@repo/contracts`，
内部调用走 `@repo/internal-sdk`，能力声明走 `@repo/capability`，数据访问可用 `@repo/ai-data`），
不反向依赖 `apps/*`：model-gateway 读模型配置并持上游 key，capability-gateway 管目录 / 授权 / 路由 / 审计，
common-capability 与 workspace-service 是真正的执行面，互调只走内网 HTTP + `x-internal-token`。

实体与迁移在 `@repo/db`（`apps/*/src/database/entities` 已不存在）；前端通过 `@repo/sdk` 调用 main，
请求 / 响应类型与后端共享 `@repo/shared` 的 Zod schema；app 间调用走 `@repo/internal-sdk`
（`AgentRuntimeClient` / `CapabilityGatewayClient` / `ModelGatewayClient` / `WorkspaceServiceClient`，
不裸拼内部地址）；能力声明与登记机制在 `@repo/capability`，跨服务契约在 `@repo/contracts`。

## 组合根与生命周期

**六个 Nest 服务各有一个组合根**：`apps/main/src/root.module.ts`、`apps/agent-runtime/src/root.module.ts`、
`apps/model-gateway/src/root.module.ts`、`apps/capability-gateway/src/root.module.ts`、
`apps/common-capability/src/root.module.ts`、`apps/workspace-service/src/root.module.ts`。
装配骨架相同（配置 → 横切中间件 → 基础设施 → 业务 / 执行模块），差异只在模块集合：内网服务不装
鉴权 / 分享 / 会话等控制面模块，只装自己用得到的 kits 基础设施（如 workspace-service 只接 DB + 日志 +
沙箱，不连 Redis / 对象存储；capability-gateway 只接 DB + Redis + 日志 + IdGeneration）。
kits 侧由「一个基础设施一个模块」分别装配，`packages/kits/src` 下 17 个能力目录、23 个 `@Global()` 模块：

- 每个基础设施一个 `@Global()` NestJS 模块，需要配置的都提供 `forRoot(options)` 与
  `forRootAsync(options)` 两种装配方式：`LoggerModule` / `DbModule` / `RedisModule` / `JwtModule` /
  `PasswordModule` / `ObjectStorageModule` / `NotificationModule` / `WorkspaceModule` / `LarkModule` /
  `KafkaModule`；`RateLimitModule` / `PubSubModule` / `StreamHubModule` / `EventBusModule` /
  `SessionStoreModule` 复用上游模块的配置 bean（RedisConfig / JwtConfig / IdGeneration），
  `IdGenerationModule` / `TelemetryModule` / `SchedulerModule` / `CommandModule` 无配置；
  请求级横切中间件模块 `RequestContextModule` / `RequestLoggerModule` / `RequestMetricsModule`
  （在 `packages/kits/src/http/`）自注册到 `forRoutes('*')`。模块内部 `Schema.parse(...)` 校验 +
  补默认值，**配置对象本身就是该模块的注入 bean**（`DbConfig` / `RedisConfig` / `JwtConfig` /
  `PasswordConfig` / `StorageConfig` / `NotifyConfig` / `WorkspaceConfig` / `LarkConfig` / `KafkaConfig`）
- **配置链路（惰性规则）**：各服务在 `NestFactory.create` **之前** `await load...AppConfig()`
  （main / runtime 是 `loadServerAppConfig()`，四个内网服务是 `loadModelGatewayAppConfig()` 等），
  `AppConfigFacade.initial({ schema, loader })` 完成「加载 → 校验 → 补默认值 → 缓存」；
  `schema` 是应用自定义的 shape（zod），`loader` 决定来源（内置 `env` / `memory` / `consul`，
  或自定义实例 / `registerConfigLoader` 注册的名字）；`AppConfigModule.forRoot()` 用
  `ConfigModule.forRoot({ isGlobal: true, load: [() => AppConfigFacade.getConfig()] })` 把它接进 Nest；
  各模块用 `forRootAsync` 的 `useFactory` 惰性取分片。**不要在 `root.module.ts` 顶层直接读配置值** ——
  ESM 下 `import { RootModule }` 的装饰器求值早于 `main()` 里的配置加载，顶层读会拿到空配置
- **按需装配**：某基础设施不 import 即视为未启用。main / runtime 的 Lark / Kafka 由环境变量决定是否装配
  （`LARK_APP_ID` + `LARK_APP_SECRET` / `KAFKA_BROKERS`）；Kafka 当前没有业务生产 / 消费方，
  流式走 Redis pub/sub，装配它只是保留能力。可选依赖用 `@Optional()` 优雅降级（未装配
  `LarkModule` 时 `LarkNotifyClient` 自动「未配置」）
- **应用级业务配置**：main / agent-runtime 的 `src/config.ts` 各自只导出 `ServerConfig` 类型
  （= `ServerAppConfig['server']`）与 `resolveServerConfig(config)`；守卫 / service / 控制器注入全局
  `ConfigService` 后调它取 `server` 分片（端口 / 鉴权开关 / 限流白名单等），**无需额外的配置 bean / 模块**。
  四个内网服务把 schema / mapEnv / loader 放在 `src/config/app-config.ts`，需要单个值时注入自己的
  Symbol token（如 `ModelGatewayConfig` / `WorkspaceServiceConfig`）
- **入口与进程生命周期**：六个服务都是 `NestFactory.create(RootModule, ...)` + `app.listen(port)`。
  main / runtime 额外做全局 Express 配置（`app.enableCors()` / 2mb 请求体上限 / `keepAliveTimeout` 75s
  与 `headersTimeout` 80s），并在 SIGINT / SIGTERM 时优雅关闭（排空超时兜底，默认 25s）；
  四个内网服务的 `main.ts` 更薄：`bufferLogs` + 日志适配器 + `enableShutdownHooks()`，生产环境下
  内部 token 仍是默认开发值时会直接拒绝启动
- 生命周期由 Nest 驱动：组件实现 `OnApplicationBootstrap` / `OnApplicationShutdown`，
  装配完成后按 providers 声明顺序启动（Db 初始化、Redis 连接、ObjectStorage 建桶 / 客户端、
  Workspace 沙箱能力探测），`app.close()` 时逆序释放资源
- 业务模块在 `root.module.ts` 的 `imports` 注册，各自的 repository / service 在自己模块的
  `providers` 声明；实体是类引用、无法来自环境变量，由组合根在 `DbModule.forRootAsync` 的
  `useFactory` 里补 `entities: [...]`（main / runtime 直接用 `DB_ENTITIES` 全量，内网服务只列用到的
  几张表；其余 `db` 配置仍来自应用配置）
- **工作区分两层**：`@repo/kits` 的 `WorkspaceModule` 是本地沙箱实现（`WorkspaceRuntimeService`，
  seatbelt / bwrap、三档模式、沙箱不可用 fail closed），workspace-service 的 `local` 后端与
  main / runtime 的探针仍用它；真正的执行面是 `apps/workspace-service`——容器 / Pod 生命周期、
  bash 与工作区文件能力都在那里

## 分页

`packages/kits/src/db/pagination.ts` 提供四种分页策略（构建在 TypeORM QueryBuilder 之上）：

- **`pageWith`** — 单表 `LIMIT/OFFSET` 页码分页，返回 `{ data, total }`（service 层再映射成
  `{ items, total, page, size }`）
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
