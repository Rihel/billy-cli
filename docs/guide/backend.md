# 后端（NestJS）

> 本文主线是 **`apps/main`**（公网 BFF，9989）与 **`apps/agent-runtime`**（agent loop，9990）。
> 另有四个**只在内网、只认内部令牌**的服务：**`apps/model-gateway`**（9992，模型网关）、
> **`apps/capability-gateway`**（9993，能力目录与调用路由）、**`apps/common-capability`**（9994，
> 通用能力执行）、**`apps/workspace-service`**（9995，工作区执行面）。
> 本文写六个服务的分工、main / runtime 的边界、模块、鉴权、API、流式链路、内网服务，以及日志与监控。
> 通用能力封装见 [packages.md](./packages.md)，部署见 [deployment.md](./deployment.md)。

## 六服务分工

| 服务 | 端口 | 对外 | 职责 |
| --- | --- | --- | --- |
| `apps/main`（`@app/main`） | 9989 | **是**（前端 / SDK / 分享页 / 探针都连它） | 公网 BFF + 业务控制面：鉴权、业务控制面 CRUD、全部 AI 配置与管理 HTTP、`/agent/*`（对话入口 + SSE 桥 + 队列）、工作区控制面、模型网关用量页；**不跑 agent loop、不执行能力** |
| `apps/agent-runtime`（`@app/agent-runtime`） | 9990 | 否（只给 main 调） | 只跑 agent loop：agents / 会话编排 / 工具面装配 / 提示词 / 技能加载 / 子 agent / run 队列 / 崩溃恢复；只暴露 `/internal/agent/*` 与探针 |
| `apps/model-gateway`（`@app/model-gateway`） | 9992 | 内网 | 内部模型网关：canonical OpenAI 协议、四套上游协议适配、模型目录、上游 key 池、用量落库；runtime 不持供应商 key |
| `apps/capability-gateway`（`@app/capability-gateway`） | 9993 | 内网 | 能力目录权威：服务登记 / 心跳 / 能力目录 / 授权过滤 / 调用路由 / 限流与入参校验 / MCP client / 审计；**不执行能力** |
| `apps/common-capability`（`@app/common-capability`） | 9994 | 内网 | 通用能力执行：登记服务 `common`，执行 memory / web / read-tool-result / 文件收发 9 个能力 |
| `apps/workspace-service`（`@app/workspace-service`） | 9995 | 内网 | 工作区执行面：工作区生命周期（ensure / stop / destroy / status / exec / fs）、docker / k8s 驱动、空闲回收；执行 `bash` 与 7 个工作区文件能力 |

- 端口约定：9840（web）/ 9845（admin）/ 9989 / 9990 / 9992 / 9993 / 9994 / 9995（9991 未使用）。
- 内部令牌：`AGENT_INTERNAL_TOKEN`（main ↔ runtime）、`MODEL_INTERNAL_TOKEN`（网关校验）与
  `MODEL_GATEWAY_TOKEN`（runtime / main 调用侧）、`TOOL_INTERNAL_TOKEN`（能力网关 / common-capability 校验；
  runtime / main / workspace-service 登记时携带）、`WORKSPACE_INTERNAL_TOKEN`（workspace-service 校验；
  main / common-capability 调用时携带）。
  内网服务之间只走内网 HTTP + `x-internal-token`，都在同一份 `.env` / compose 锚点 / k8s Secret 里对齐同值。
- 分享另有一个密钥：`SHARE_INTERNAL_SECRET`（main 与 admin 两端一致；空 = 分享内容一律 404）。

三条硬边界：

1. **前端只连 main**；runtime 与四个内网服务都没有 public controller，也不发 CORS。main 校验身份后把
   `x-user-id` / `x-admin-id` / `x-main-client-id` / `x-internal-token` 传给 runtime；内网服务只认内部令牌，
   不认用户 JWT。
2. **main 不做 agent 执行**：不 import Mastra 的业务编排、不跑工具循环、不执行能力；它只做请求转发、
   pub/sub→SSE 桥、以及所有控制面 CRUD。
3. **runtime 不做控制面 CRUD、也不执行能力**：技能库 / 工具配置 / 工作区 / 能力服务由 main 写入；
   `bash`、文件、联网、记忆等执行在 `capability-gateway` 路由到的 `common-capability` / `workspace-service`；
   runtime 只做编排、工具面装配与目录消费。

## main — NestJS 12 HTTP 边界

`apps/main` 只做四件事：接收请求、Zod 校验、调用业务 service、映射错误。业务逻辑位于
`apps/main/src/modules/`，实体与迁移**唯一来源是 `@repo/db`**（没有 `src/database/entities`，
组合根直接 `entities: [...DB_ENTITIES]`），通用能力位于 `@repo/kits`。

- **配置链路**：`src/app-config.ts` 的 `serverAppConfigSchema` **直接复用 kits / monitor 各模块的配置
  schema**，每个 app 只声明自己消费的分片 —— main 15 个命名空间（`server` / `db` / `redis` / `jwt` /
  `password` / `storage` / `logger` / `notify` / `monitor` / `share` / `lark?` / `kafka?` / `workspace` /
  `aiModel` / `modelGateway`），runtime 12 个（`server` / `db` / `redis` / `storage` / `logger` / `notify` /
  `monitor` / `lark?` / `kafka?` / `workspace` / `agent` / `modelGateway`；runtime 不读鉴权 / 分享 / 模型种子）。
  `mapServerEnv(env)` 负责环境变量 → 嵌套配置；`main.ts` 的 `program()` 与 `seed-admin.ts` 都在启动 Nest
  **之前** `await loadServerAppConfig()` 完成加载 + 校验 + 补默认值（`AppConfigFacade` 缓存）。该函数内部只声明
  **来源**：`AppConfigFacade.initial({ schema: serverAppConfigSchema, loader: envConfigLoader({ envFileName: '.env', mapEnv: mapServerEnv }) })`
  —— 换来源（如 Consul / Nacos）只改 `loader` 这一项，配置 shape 与各模块装配完全不变。
  除「可选模块是否装配」的两个开关（`LARK_APP_ID` / `KAFKA_BROKERS`）与少量运行时判断
  （如 `NODE_ENV`、从链接导入技能用的 `GITHUB_TOKEN`、`AGENT_RUNTIME_URL` / `TOOL_GATEWAY_URL` 等下游地址）外，
  配置统一走这份 schema，不在各处散读 `process.env`。各变量的默认值、必填项与归属见
  [环境变量指南](./env.md)。
- **组合根**：`root.module.ts` 是 main 的唯一组合根，装配顺序有硬约束：
  1. `AppConfigModule.forRoot()`（把已加载配置接进 Nest：全局 `ConfigService` + `AppConfig` bean）；
  2. 请求级横切中间件 `RequestContextModule` → `RequestLoggerModule` → `RequestMetricsModule`
     （**顺序硬约束**：后两者要在请求结束时从 ALS 读 `requestId` / `userId` / `adminId`）；
  3. 无配置的基础能力 `IdGenerationModule` / `TelemetryModule` / `SchedulerModule` / `CommandModule`；
  4. `WorkspaceModule`（kits 的工作区运行时：沙箱探测与执行环境选择）与 `LoggerModule`；
  5. `DbModule`（`entities: [...DB_ENTITIES]` + `subscribers: [AuditSubscriber]`，审计操作人由 `main.ts` 的
     `setAuditUserProvider` 接请求上下文）；
  6. `RedisModule` → `RateLimitModule` / `PubSubModule` / `StreamHubModule` / `EventBusModule`；
  7. `JwtModule` / `SessionStoreModule` / `PasswordModule` / `ObjectStorageModule` / `NotificationModule`；
  8. 可选模块 `LarkModule`（`LARK_APP_ID` + `LARK_APP_SECRET`）/ `KafkaModule`（`KAFKA_BROKERS`），
     用展开语法按 env 是否存在决定；
  9. `OpsModule`（根路径探针）→ 各业务模块（见下）。
  需要配置的基础设施一律用
  `forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config) => config.get('<命名空间>') })`
  **惰性**取自己的分片（模块装饰器求值早于配置加载，不能顶层直读）；无自有配置的直接引模块。
- **业务模块**：`root.module.ts` 的 `imports` 里注册 17 个（`OpsModule` + 16 个业务模块）：
  `AuthModule` / `AdminModule` / `UserModule` / `AiModelModule` / `AiSkillAdminModule` /
  `CapabilityServiceAdminModule` / `AiToolAdminModule` / `AiAdminConversationModule` / `AiFileAdminModule` /
  `WorkspaceAdminModule` / `StorageModule` / `StreamModule` / `SessionModule` / `ShareModule` /
  `MonitorModule` / `RuntimeConfigModule`（`AiUsageModule` 由 conversation 模块间接装配）。
  `providers` 里除 `APP_PIPE` / `APP_FILTER` / `APP_INTERCEPTOR` 三个全局构件外，还注册
  `AgentRunQueueService` / `AgentSseBridge` / `MemoryRepository` + `MemoryService`（来自 `@repo/ai-data`）与
  `ERROR_ALERT_HOOK`（把 `MonitorEngine` 适配成 common 层告警钩子 token，避免 HTTP 边界层反向依赖业务模块）。
  `/agent` 的四个控制器（`AgentSseController` / `AgentControlController` / `AgentRunQueueController` /
  `MemoryController`）直接写在组合根的 `controllers` 里。
- **入口**：`main.ts` 用 `NestFactory.create<NestExpressApplication>(RootModule, { bodyParser: false, bufferLogs: true })`
  启动，`app.useLogger(app.get(NestLoggerAdapter))` 接管框架日志后做全局 Express 配置
  （`enableCors()`、关闭 `x-powered-by`、请求体上限 2mb、`keepAliveTimeout` 75s / `headersTimeout` 80s
  取 `server` 分片）；监听成功后注册进程级异常告警（`uncaughtException` 记录后 `exit(1)`、
  `unhandledRejection` 记录不退出，都汇入 `MonitorEngine.ingestError`）。
- **业务模块目录**：`modules/<业务>/{module,controller,service,repository,errors,index}.ts`；
  controller 只做 HTTP 边界（Zod 校验 + 调 service + 返回数据），业务逻辑仍在 service / repository。
  `modules/` 下 13 个目录：`auth` / `admin` / `user` / `session` / `storage` / `stream` / `share` /
  `monitor` / `ops` / `runtime-config` / `ai-model` / `ai-usage` / `ai-admin`。其中 `ai-admin` 有 6 个子模块
  （conversation / file / tool / capability / skill / workspace）+ 根级 `memory.controller.ts`；
  `agent/` 不是 module，是 `/agent` 的流式入口、控制接口、队列与 SSE 桥（6 个文件）。
- **`/agent` 目录（`apps/main/src/agent/`）**：`agent-catalog.service.ts`（经 `AgentRuntimeClient`
  代理 runtime 的 status / list / instructions，清单缓存 30s、超时 5s）、`agent-sse.controller.ts`
  （`POST /agent/chat/stream`）、`agent-sse.bridge.ts`（PubSub → SSE 桥）、`agent-control.controller.ts`
  （`POST /agent/chat`、`/agent/chat/resume`、`/agent/run/stop` 与 4 个重连 GET）、
  `agent-run-queue.controller.ts` + `.service.ts`（用户待执行队列的 list / update / remove）。
- **校验与响应**：请求体用 `@Body({ schema: Schema })` 参数装饰器校验，控制器只返回业务数据，由
  `ResponseEnvelopeInterceptor` 统一包成 `{ code: 0, data }`，异常统一由 `AppExceptionFilter` 处理；
  全部**业务**路由 POST 且显式标注 `@HttpCode(200)`（Nest 对 POST 默认 201）；GET 只留给运维探针、
  AI 运行重连 / 快照与工作区文件流（见「API 设计」的 GET 例外）。
  唯一不做 Zod 校验的是 main 的 `/agent` 流式入口：`POST /agent/chat` / `chat/stream` / `chat/resume` /
  `run/stop` 在 main 这一层**body 原样转发**，真正的 `AgentChatSchema` / `AgentChatResumeSchema` /
  `AgentRunStopSchema` 校验在 runtime 的 `AgentInternalController`。
- **守卫**：`UserAuthGuard` / `AdminAuthGuard` / `AnyAuthGuard`（任一身份通过，基于
  `common/security/any-of-guards.ts`（main 专属））/ `RateLimitGuard`（配合 `@RateLimit({ scope })`
  方法装饰器，超限抛 `BoundaryError` 并带 `Retry-After` 响应头）。`common/security/authentication.ts`
  提供 `extractToken` / `AccessToken` / `currentUserId` / `currentAdminId`。
- **SSE 推流**：`modules/stream/stream.controller.ts` 的 `StreamController` 暴露 `POST /sse/subscribe`
  长连接（Bearer / cookie 认证），`SSE_ROUTE_OPTIONS` 当前配 `auth: 'both'`（前台用户订阅 `user:{userId}`、
  管理员订阅 `admin:{adminId}` 并自动叠加 `admin:all` 广播，另按身份派生 `ai:owner:{id}`），业务模块经
  `StreamHub.publish(channel, event)` 推流，多实例经 kits 的 `PubSub`（Redis pub/sub）跨实例广播
  （[sse.md](../design/sse.md) 设计文档，客户端为 `@repo/http-client` 的 `HttpStreamClient`）。
- **请求上下文 / 请求日志**：`@repo/kits` 的 `http/request-context/request-context.ts` 基于 `AsyncLocalStorage`，
  跨中间件与业务调用传递 `userId` / `adminId`（登录时另把 `ip` / `userAgent` 写进会话元数据，供登录设备列表展示），
  避免参数透传；中间件生成 `requestId` 并写入 `X-Request-Id` 响应头。
  请求日志由 **`@repo/kits` 的 `RequestLoggerMiddleware` 记录**
  （method / url / statusCode / durationMs / requestId / userId / adminId），按状态码分级
  （<400 info / 4xx warn / 5xx error），日志 `requestId` 与响应头同值；业务侧不要自写请求日志。
- **下游客户端**：`AgentRuntimeClient`（status / list / tools / instructions）、`CapabilityGatewayClient`
  （services list / register / status / deregister、mcp/list、capabilities/list）、`ModelGatewayClient`
  （providers list-models / test）、`WorkspaceServiceClient`（workspaces ensure / stop / destroy / status / fs）；
  `chat` / `chat/stream` / `chat/resume` / `run/stop` / `run/stream` / `run/:runId/stream` /
  `run/snapshot` / `run/:runId/snapshot` 因为要透传 body、query、身份头与 SSE 流，直接用 `fetch` 转发。
- **优雅关闭**：`main.ts` 监听 SIGINT / SIGTERM，`await app.close()`（`StreamHub` 先推 `stream.shutdown`
  并关闭全部 SSE 长连接，Express 适配器再排空在途请求，最后执行 `OnApplicationShutdown` 释放 DB / Redis 等连接）；
  超过 `server.shutdownTimeoutMs`（默认 25s）强制退出，避免进程挂到 `terminationGracePeriodSeconds`
  被 SIGKILL 而留不下日志。

## agent-runtime — agent loop

`apps/agent-runtime/src/` 与 main 同构（`app-config.ts` / `config.ts` / `root.module.ts` / `main.ts`），
但模块集合只有执行侧：`AiModule`（业务主体）+ `@repo/monitor` 的 `MonitorModule.forRootAsync(...)` +
`OpsModule`。`root.module.ts` 里没有 `AuthModule` / `UserModule` / `StorageModule` / `ShareModule` /
`JwtModule` / `SessionStoreModule` 等控制面模块，也**没有任何业务 controller**——唯一控制器是
`modules/ai/api/agent-internal.controller.ts`，加根路径探针 `OpsController`。
runtime 同样没有 `ai-model` / `ai-usage` / `monitoring` 模块：模型全部经 `model-gateway` 目录，
用量由 main 与 model-gateway 记录，监控引擎来自 `@repo/monitor`。

```
apps/agent-runtime/src/modules/ai/
├── api/            # AgentInternalController：/internal/agent/*（唯一的对外 HTTP）
├── agents/         # agent 声明与登记（提示词模板、工具授权清单、状态 / 清单 / 工具 / 指令查询）
├── runtime/        # 会话编排：chat / context / run / timeline / recovery / usage / stream-store /
│                   #   stream-resume / run-snapshot / run-queue / agent-runner（子 agent）/ remote-tool /
│                   #   gateway-capability-catalog / model-gateway.catalog / live-usage / title
├── core/           # config / envelope / errors / model-decision / prompts（eta 模板）/
│                   #   skills（loader / materializer / paths）/ tools（注册机 / 网关 / 插件链 / 声明 DSL）
├── tools/          # 本地编排工具：planner/、subagent.tool、task.tool、definitions（技能库 / 网关任务参数）
├── files/          # 仅 re-export @repo/ai-data 的 FileRepository / FileService
├── memory/         # 仅 re-export @repo/ai-data 的仓储与服务 + 记忆抽取 / thread 清理
├── skills/         # 技能库落盘 + ai.skill.changed 订阅者（SkillLibraryService）
├── mastra/         # Mastra 适配器（agent / tools / skills / memory / stream / summarizer），Mastra 只在这里出现
└── ai.module.ts
apps/agent-runtime/src/modules/ops/   # 根路径探针（与 main 同一套实现）
```

runtime 不再有本地能力执行体：bash / web / file / memory / read-tool-result 的执行在
`workspace-service` 与 `common-capability`，runtime 只保留「本地编排工具（规划 / 子 agent / 技能库 /
网关任务）+ 能力目录装配」。

**内部接口（只给 main 调）**：

| 路由 | 说明 |
| --- | --- |
| `POST /internal/agent/status` | 能力状态（可用模型 + agent 数）；main 的 `/agent/status` 代理它 |
| `POST /internal/agent/list` | agent 清单（`skills: ['*']` 按当前技能库现算）；main 的 `/agent/list` 代理它 |
| `POST /internal/agent/tools` | 运行时内建工具清单（main 的 `ToolAdminCatalog` 用它渲染后台「运行时工具」区块；元数据来自代码声明，main 不再存快照） |
| `POST /internal/agent/instructions` | 静态系统指令原文；main 只在会话没有快照时用它 |
| `POST /internal/agent/chat` | 非流式跑一轮（`AgentChatSchema`）；main 的 `/agent/chat` 转发到它 |
| `POST /internal/agent/chat/stream` | 流式起一轮对话；把输出经 Redis pub/sub 发回 main（见「流式输出链路」） |
| `POST /internal/agent/chat/resume` | 回答挂起中的一轮（`ask-user-questions` 后续跑） |
| `POST /internal/agent/run/stop` | 停止某一轮（`AgentRunStopSchema`）；跨副本经 Redis 转发 |
| `GET /internal/agent/run/stream` | 重连当前运行（`sinceRev` 增量 + 快照；没有进行中的流回 204） |
| `GET /internal/agent/run/:runId/stream` | 重连指定运行（同上） |
| `GET /internal/agent/run/snapshot` | 当前进行中那一轮的快照（已闭合 part + 增量起点 `sinceRev`；没有回 204） |
| `GET /internal/agent/run/:runId/snapshot` | 指定 run 的快照（同上） |
| `GET /healthz` / `GET /readyz` / `GET /info` | 与 main 同一套 `OpsModule` 探针实现（`/readyz` 探 DB + Redis） |

- **响应格式**：内部业务 JSON 统一 `{ code: 0, data }`（runtime 全局 `ResponseEnvelopeInterceptor`；
  capability-gateway / common-capability / workspace-service / model-gateway 的业务路由同约定）。
  `/healthz`、`/readyz`、`/info` 探针与 `/v1/**` 模型协议、SSE/NDJSON 流式响应保持裸格式。
- **身份**：`requireToken` 校验 `x-internal-token === AGENT_INTERNAL_TOKEN`（目录类查询到此为止）；
  会话类接口再经 `requireOwner` 从 `x-user-id` / `x-admin-id` 取调用者，缺失即 401，只允许本人的 run。
  runtime 不签发 token，也不做用户鉴权（鉴权与会话归属都在 main）。
- **静态声明只在 runtime**：agent 规格 / 提示词模板 / 工具面 / 技能类型不复制到 main；
  main 的 `/agent/{status,list,instructions}` 经 `@repo/internal-sdk` 的 `AgentRuntimeClient` 代理，
  清单在 main 侧缓存 30s（`apps/main/src/agent/agent-catalog.service.ts`）；内建工具元数据由 main 的
  `ToolAdminCatalog` 直接问 `/internal/agent/tools`，**不对外暴露 `/agent/tools`**。
- **配置感知**：技能库由 main 写库并发事件（见「配置变更事件」），runtime 订阅后落盘 / 同步；
  能力目录靠 5s TTL，模型目录靠 30s TTL（无配置表可读）。

**工具面**：runtime 的模型面 = 本地注册机（4 组、18 个 key）∪ 能力目录里 `source='code'` 的能力。

| 工具组（类） | key | 说明 |
| --- | --- | --- |
| `PlannerTools` | `plan-create` / `plan-reorder` / `plan-complete` / `plan-delete` | 规划清单，4 个工具都返回完整清单 |
| `RunSubAgentTool` 等（子 agent 配套） | `run-sub-agent` / `sub-agent-list` / `wait-sub-agent` / `cancel-sub-agent` | `run-sub-agent` 始终异步；配套查询 / 等待 / 取消 |
| `TaskTool` | `wait-task` / `cancel-task` / `tool-search` | 网关内建能力的本地入口；**未配 `TOOL_GATEWAY_URL` 时装配期整组摘掉** |
| `SkillTools` | `skill-list` / `skill-save` / `skill-file-save` / `skill-file-append` / `skill-import` / `skill-delete` / `skill-enable` | 技能库维护，作用域 `admin` |

- **能力目录**：runtime 每 5s 从网关 `POST /v1/capabilities/list` 取目录（按身份缓存，key 形如
  `user:<userId>:<agentKey>` / `admin:<userId>:<agentKey>`），网关不可用时 fail-open 返回空
  （不影响本地工具）；目录里
  `source='code'` 的能力**随工具面下发**（与本地注册机 key 去重，模型面工具名 = 扁平 key），
  `source='manual'`（MCP / 手工登记的外部服务）**不随工具面下发**。
- **外部服务发现**：模型先调 `tool-search`（网关内建，BM25，只搜当前身份可见目录），命中 key 写入
  Redis `ai:tool:discovered:<conversationId>`（TTL 7 天、每会话最多 50 个），**下一轮**由 `resolveTools`
  补进工具面；子 agent 的工具面不含外部服务。
- **授权只剩 key / `'*'`**：授权清单支持具体 key 或 `ALL_TOOLS='*'`；装配期按调用身份过滤 `scope`
  （`all` / `admin` / `user` / `agent` + `allowedAgents`），开关（`enabled`）留到调用期由插件链判。
  更早的「按类别选择 / 外部工具白名单」已整体删除（历史回退：2026-11 前授权支持选择器形态，
  现在只认 key 与 `'*'`，写错工具名在编译期就报错）。
- **工具网关插件链（顺序）**：`Enabled → Scope → RateLimit → Validate → Precheck → AuditStart →
  Redact → AuditEnd`；命中远程能力（`TOOL_GATEWAY_URL` + 目录）时**跳过本地插件链**，直接经网关执行
  （审计由能力网关落 `ai_tool_audit`）。
- **工具配置**：`ai_tools` 只存 enabled / limits / config / secrets（启动时对账补声明，`source='manual'`
  行不覆盖）。工具元数据（title / description / 参数 schema）不再由 main 存快照——内建工具问 runtime
  `POST /internal/agent/tools`，服务能力问网关 `/v1/capabilities/list`，main 的 `ToolAdminCatalog`
  缓存 5s、任一侧不可用只降级。
- **提示词里的工具清单是渲染出来的**：首轮由 `renderAgentInstructions` 渲染（本地注册机 `describe()` +
  目录里 `source='code'` 的能力），落 `system` 快照后逐字复用；`/agent/instructions` 预览与对话首轮共用同一份。

**模型链路**：runtime 只持 `ModelGatewayCatalogService`——向 model-gateway 要目录（进程内缓存 30s），
把目录条目转成 Mastra 的模型实例（`apiKey` 为空串，真实 key 只在网关侧），请求头带归因
`x-billy-run-id` / `x-billy-conversation-id` / `x-billy-identity-*`。目录为空抛「还没有配置可用的模型」类错误（3406 口径），
指定模型不在目录抛 3402。runtime 不读 `ai_providers` / `ai_models`、不持供应商 key。

**run 生命周期**：`chat.service.ts` 负责读写 `runs` / `timelines` / Redis 进度（`agent:run:<runId>`）
与 durable 恢复；跑完后进度删掉、内容落 Postgres。进程崩溃由启动清理 + 看门狗兜底
（详见 [distributed-ai-architecture.md](../design/distributed-ai-architecture.md) 第 5–6 节）：
- 启动时上一进程遗留的进行中 run 标 `interrupted`；durable 快照存在时由持 Redis 租约的副本
  `recoverAllDurableAgents()` 续跑（会重发模型调用 / 重跑工具，`recovery_count` 有上限）；
  子 run 不是 durable，先标中断、留待父 run 恢复时「原地重启」。
- 看门狗按固定间隔（`watchdogIntervalMs`）巡检心跳超时的 run。

**run 队列**：`ai:run-queue:dispatch:<conversationId>` 是每会话 15s 的调度锁，同会话排队上限 50；
dispatcher 每秒 tick 一次原子领取队首（`user` 优先、同优先级 FIFO），把排队消息变成一次真正的 run。
main 的 `/agent/queue/{list,update,remove}` 只读写当前用户自己的、`source=user` 且仍 `queued` 的项。

**子 agent**：`run-sub-agent` 始终异步，提示词由主 agent 现场写；子工具面 = 父授权 ∩ 全部工具 −
委派类工具 − `child:'deny'`（所以子 agent 不能再造子 agent，深度天然为 1）。结论落工作区
`subagents/<name>-<subRunId>.md`（写失败只 warn，唤醒通知退回「摘要 + 子会话」），子 agent 完成即唤醒父
run（已被 `wait-sub-agent` 消费过的不再唤醒）。`ask-user-questions` 是 Mastra 原生工具（挂主 agent，
用 Mastra 的挂起 / 续跑控制流，不走工具 DSL）。

**上下文压缩**：按 token 预算分三档（触发比例 / 裁剪目标 / 压缩目标，另有最近 N 轮不裁、单条与整轮
工具结果占窗口比例上限、未知模型保守窗口、按模型覆盖窗口）；工具结果超出时先裁剪，触发压缩时用
**临时压缩 agent**（无工具 / 技能 / 记忆）生成摘要，用量记进本轮账。长期记忆落 `ai_memories`
（service / repository 已下沉 `@repo/ai-data`），短期 thread 用 `@mastra/redis`；runtime 保留记忆抽取与
thread 清理。技能库 DB `ai_skills` 是事实源（main 写库），runtime 落盘 `~/.billy/skills` 并加载。

## 流式输出链路（pub/sub → SSE）

```
前端 ──POST /agent/chat/stream──> main（AnyAuthGuard，生成 clientId）
                                   │  先挂 PubSub 订阅，再带 x-internal-token + 身份头 + x-main-client-id 触发 runtime
                                   └──> runtime POST /internal/agent/chat/stream
                                          │  跑 agent loop，逐段 appendEvent（rev）→ publishEvent
                                          └─ Redis pub/sub 频道 agent:stream:client:<clientId>
main（AgentSseBridge，PubSub.subscribeAsync 订阅该频道）
  └─ 把帧里的 AG-UI 事件原样写成 data:；final / RUN_FINISHED 帧直接 end()（**不写 [DONE]**）
  └─ 同时持续读掉 runtime 的 SSE 响应体（只用于维持运行与快速失败，不解析内容）
```

- **频道**：`agent:stream:client:<clientId>`（`@repo/shared` 的 `agentStreamChannel`）。只有挂着这条
  SSE 连接的 main 实例收到，其它副本零流量。
- **收件地址**：`clientId` 由 main 在 attach 时生成，runtime 用 `bindClient` 写进 Redis 进度 Hash
  （`agent:run:<runId>` 的 `clientId` 字段），**重连落在别的副本上也能被找回来**；每次发布现读，
  不做进程内缓存。
- **帧结构 v2**：`AgentStreamFrameSchema`（`version: 2` / `runId` / `event` / `final` / `createdAt`，
  `AGENT_STREAM_FRAME_VERSION = 2`）。版本 1 → 2 的语义变化是「载荷从 AI SDK chunk 改为 **AG-UI 1.0 事件**」，
  版本号顺带挡住新旧进程互串（旧 main 解析不了 `event` 字段会丢帧，而不是把事件当 chunk 写出去造成错乱）。
- **出口协议**：默认 `agui`（原样透传事件，收尾 `RUN_FINISHED` + `end()`）；`?protocol=ai` 时
  `AgentSseBridge` 把事件逆映射回旧 chunk 并写 `data: [DONE]`（灰度 / 止血口，老前端零改动）。
  **默认协议下绝不能写 `[DONE]`**：AG-UI 官方客户端会对 `[DONE]` 做 `JSON.parse`，抛错后整条流被 error 掉。
- **背压与容错**：main 会持续读掉 runtime 的 SSE 响应体（`drain`），但内容以 pub/sub 为准；
  发布失败只记日志，不阻断模型流。订阅必须**先于**触发 runtime（`attach` 内部 await 订阅生效）：
  晚一步首帧 `RUN_STARTED` 就丢了，前端整轮渲染都会错。
- **断线重连**不是 broker 回放：`GET /agent/run/stream?sinceRev=N`（不报 runId，按当前用户 / 指定会话找
  进行中的那一轮）与 `GET /agent/run/:runId/stream?sinceRev=N` 由 main 先挂订阅、再代理到 runtime；
  runtime 从 Redis 输出记录按 `sinceRev` 补发（不重跑、不重复扣费），补完即 `end`——之后的实时事件由
  「已改绑到新 `clientId`」的频道继续送。不报 `sinceRev`（刷新 / 换设备）时连快照内容一起补；
  独立的 `GET /agent/run/snapshot` / `/agent/run/:runId/snapshot` 只回「已闭合 part + 增量起点」，
  前端先渲染快照、再按起点接流。补发帧与实时帧走同一条频道，补发期间用 Redis 闸门
  （`agent:stream:<runId>:replay`，TTL 30s）挡住实时事件，避免乱序。
- **暂停 / 续答**：`POST /agent/run/stop`、`POST /agent/chat/resume` 由 main 转发到 runtime；
  停止请求带 `x-user-id` / `x-admin-id`，runtime 只允许本人的 run。停止跨副本时经 Redis
  `agent:stream:<runId>:stop` 频道广播，持有运行的那一侧收到后 abort。
- **为什么是 pub/sub 而不是消息队列**（历史回退，2026-11-15）：这条链路只需要「把某一轮的输出送到
  持有那条 SSE 连接的那个 main 实例」，不需要积压、多消费方或 broker 回放——补发靠 runtime 的 Redis
  输出记录按 rev 读，所以持久化在这里是纯成本。**Kafka 现状**：`KAFKA_BROKERS` 存在时才装配
  `KafkaModule`（main / runtime 都是条件装配），但**当前没有任何业务生产 / 消费方**；流式对话不依赖 Kafka，
  只依赖 Redis。`scripts/kafka-create-topics.sh` 建的是 `app.ai.connector.sync` 主题，无代码引用
  （历史残留），不要再按「流式必须起 Kafka」部署。

## 配置变更事件（main → 下游）

main 是配置的唯一写方，下游需要感知两类变化（没有事件的部分靠 TTL 兜底）：

| 事件 | 传输 | 生产方 | 消费方 | 语义 |
| --- | --- | --- | --- | --- |
| `ai.skill.changed` | Redis Pub/Sub（kits `EventBus`，频道 `events:ai.skill.changed`） | main `modules/ai-admin/skill`（`SKILL_CHANGE_TOPIC`） | runtime `skills/skill-change.subscriber.ts` | at-most-once；runtime 收到后从 DB 读全量文件并落盘 / 刷新 loader；漏事件由启动 `syncAll` 自愈 |
| `ai.model.changed` | Redis Pub/Sub（`AI_MODEL_CHANGED_TOPIC`） | main `modules/ai-model`（供应商 / 模型 / key 变更） | model-gateway `cache/model-change.subscriber.ts` | 失效网关的目录 / key 缓存；漏事件由 30s TTL 自愈 |

- 事件体都是**只读契约**（字段只增不改）；skill 事件带 `action`（`upsert` / `remove`）/ `version`。
- **能力目录没有变更事件**：runtime 用 5s TTL 拉取，后台停用 / 启用一个能力最多 5s 反映到工具面。
- 工具配置（`ai_tools`）由 runtime 读库，不依赖事件；main 的「运行时工具」区块每次查询都现场问
  runtime / 网关，也不持快照。

## 内网服务

四个内网服务共用同一套约定：只暴露内网端口、不做用户鉴权（`x-internal-token`）、业务失败也按
`{ code: 0, data }` / 能力协议的 `{ ok, reason, message }` 返回、探针是根路径 GET。

### capability-gateway（9993）

**能力目录的权威**：服务登记 / 心跳 / 能力目录 / 授权过滤 / 调用路由 / 治理 / 审计都在这一个进程，
它**不执行能力**（没有 Mastra、没有工具实现，不碰会话）。

- **组合根**：`AppConfigModule` + Logger + Redis + DB（只挂 `ai_tool_audit` / `ai_tools` /
  `ai_capability_services` / `ai_service_grants` 四张表的实体）+ `ToolGatewayModule`；不连主业务表、
  不装 Mastra、不装工具实现。
- **接口**（一律 POST + JSON body，无路径参数；只有探针是 GET）：

| 路由 | 说明 |
| --- | --- |
| `POST /v1/services/register` | 服务登记（内部服务每个实例启动时调一次；幂等，清单没变即 no-op） |
| `POST /v1/services/deregister` | 服务退役（整条记录删掉，能力从目录消失） |
| `POST /v1/instances/heartbeat` | 实例心跳（只刷 `active`；返回 `known=false` 表示客户端应重发 register） |
| `POST /v1/instances/deregister` | 实例摘除（优雅停机：只摘流量，能力保留） |
| `POST /v1/capabilities/list` | 能力目录（给 runtime / 模型：规范 key + 模型面名字 + schema + 授权过滤） |
| `POST /v1/capabilities/invoke` | 调一次能力：治理 → 路由 → 审计，统一结论出 |
| `POST /v1/services/list` | 后台：服务列表（不返回凭据，只给 `hasCredential`） |
| `POST /v1/services/status` | 后台：启停一个服务 |
| `POST /v1/services/mcp/list` | 后台：MCP server 握手 + `tools/list`（不落库，供登记表单同步） |
| `POST /v1/tasks/get` | 长轮询查任务（按 taskId 回到发起它的实例） |
| `POST /v1/tasks/cancel` | 取消任务（幂等，终态返回当前快照） |
| `POST /v1/tasks/cancel-run` | 停止一轮对话：级联取消本轮发起的 session 任务 |
| `GET /healthz` / `GET /readyz` | 探针 |

- **登记与心跳**：服务启动时 `POST /v1/services/register` 上报清单（能力 key 扁平，如 `bash` /
  `file-list`；跨服务重名 409），之后每 10s 心跳（带 `active` 并发数），失败 5s 退避重试，
  停机注销本实例；超过 30s 没心跳的实例不再被选路。能力声明来自服务侧执行器类上的
  `@CapabilityGroup` + 方法级 `@CapabilityDecl`（`@repo/capability` 的 `scanCapabilities` 扫描绑定，
  `@repo/internal-sdk` 的 `CapabilityGatewayClient` 只负责 HTTP）。
- **目录与授权过滤**：`listFor` 按调用身份过滤——`scope`（all / admin / user / agent+`allowedAgents`）、
  服务启用状态、实例在线情况；`ai_service_grants`（principal × 服务名）**只作用于 `source='manual'`
  外部 / MCP 服务**，`source='code'` 服务默认全部可用（授权结果缓存 5s）。
- **调用路由**：`invoke` 先查注册表找能力 → 校验调用方有该服务授权 → 跑治理（enabled / scope /
  入参按声明里的 JSON Schema 校验 / 限流）→ 按 `active / maxConcurrency` 选最闲实例转发到
  common-capability / workspace-service；外部 `source='manual'` 服务只有一个 `baseUrl`，不做负载均衡。
  长任务（`mode='task'`，如 bash）先受理返回任务句柄，上游再用 `wait-task` 轮询；任务索引
  （`taskId → 实例`）由网关持有，`cancel-run` 按 runId 级联取消。
- **限流**：用户（无用户时按会话）+ 规范 key + 分钟窗口，Redis 计数，默认 60 次 / 分（可被
  `ai_tools.limits.rateLimitPerMinute` 覆盖）；Redis 抖动 fail-open。
- **MCP**：网关做 HTTP 型 client（兼容 2025 initialize 会话版与无状态版；**不支持 stdio**），
  只负责握手 / 发现 / 路由，工具名归一成扁平 key。
- **SSRF**：登记 / 探活 / 调用三处都校验目标地址（默认 https，`http` 需登记时显式勾选，
  默认拒绝回环 / 内网 / 元数据地址；生产 `allowPrivateNetwork=false`，DNS rebinding 也挡）。
- **审计**：每次 invoke 落一行 `ai_tool_audit`（网关是唯一写方；写失败不阻断结论）。
- **内建 3 个工具**：`wait-task` / `cancel-task` / `tool-search` 由网关进程内处理，不登记给任何服务，
  也不允许服务占用这些 key。`tool-search` 在**当前身份可见目录**里跑 BM25，只回 key / title / 说明 / 风险。
- **事实源**：登记记录落 DB `ai_capability_services`（整条快照 upsert，退役的服务删行），
  Redis 的 `ai:capability:registry` 只是运行时共享 / 重启恢复用的快照；读路径优先 DB、DB 为空才回退
  Redis（迁移窗口），Redis 只做多副本共享与重启恢复。

### common-capability（9994）

**通用能力执行**：一个进程登记一个服务 `common`，实际登记 **9 个能力**（能力从执行器的
`@CapabilityDecl` 扫描聚合，不再手工维护 key 列表）：

| 分组 | 能力 key | 说明 |
| --- | --- | --- |
| memory（3） | `memory-save` / `memory-search` / `memory-forget` | 长期记忆读写删（`ai_memories`，service / repository 来自 `@repo/ai-data`） |
| web（3） | `web-search` / `web-fetch` / `web-request` | 出网：搜索 / 抓正文转 Markdown / 任意 HTTP（共用 `@repo/web-runtime` 的出网预算与 SSRF 校验） |
| 工具结果（1） | `read-tool-result` | 读某个工具结果的后续页（大返回分页的回取通道） |
| 文件收发（2） | `file-submit` / `file-download` | 会话文件入对象存储 / 从对象存储取回 |

- **bash 与工作区文件不在这里登记**：它们声明为 `execution.where = 'workspace'`，由 workspace-service
  登记；common 的清单按 `decl.execution?.where !== 'workspace'` 过滤，避免跨服务重名 409。
- **接口**：`POST /invoke`（网关调；内部令牌）+ `POST /tasks/get` / `POST /tasks/cancel`（本 worker 上的
  长任务轮询 / 取消）+ `GET /healthz` / `GET /readyz`。返回能力协议
  `{ version, requestId, capability, service, instanceId, durationMs, task?, outcome }`；未注册的工具返回
  `unsupported-tool` 结论，不抛异常。
- **登记**：启动时若配了 `CAPABILITY_GATEWAY_URL`（或 `TOOL_GATEWAY_URL`）就登记，否则只记一条 warn
  跳过（本地单跑不受影响）；之后 10s 心跳（带并发数），停机注销实例。
- **执行编排**：只有 `ToolWorkerService` 按 key 找执行器；授权 / 限流 / 审计都在网关，执行器自己做
  入参校验与隔离执行；并发上限默认 8（`TOOL_WORKER_MAX_CONCURRENCY`），心跳把 active 数报给网关做选路。
- **工作区文件系统端口**：本进程把 `WorkspaceFsPort` 接到 `WorkspaceServiceClient`（`/v1/workspaces/fs`），
  供 `@repo/ai-data` 的文件服务在容器工作区里读写（`file-submit` / `file-download` 走这条端口）；
  真正对外登记的工作区文件能力（`file-list` / `read-file` 等 7 个）在 workspace-service，不在这里。

### workspace-service（9995）

**工作区的执行面**：按 `ai_workspaces` 的配置起环境、执行命令、读写文件；运行态只在内存 + 容器标签里，
**不写回 DB**（配置 / `desired_status` 的写方是 main，工作区页面上的启动 / 停止由 main 转发过来）。

- **生命周期接口**（内部令牌，业务失败 HTTP 200 + `ok:false`）：

| 路由 | 说明 |
| --- | --- |
| `POST /v1/workspaces/ensure` | 确保工作区可用（按需拉起容器 / 本地沙箱） |
| `POST /v1/workspaces/stop` | 停止工作区（保留数据） |
| `POST /v1/workspaces/destroy` | 销毁工作区（容器 / 工作目录） |
| `POST /v1/workspaces/status` | 实时运行态（running / stopped / unknown） |
| `POST /v1/workspaces/exec` | 在工作区里执行命令（返回退出码 / stdout / stderr / 实际 runtime） |
| `POST /v1/workspaces/fs` | 统一文件原语（list / read / write / append / replace / stat / remove / search，byte 级读写走 base64） |
| `GET /healthz` / `GET /readyz` | 探针 |

- **后端驱动**：`local`（复用 kits 的 L1 沙箱，自托管单租户）/ `container`（docker 或 k8s）/
  `microvm`（预留未实现）。容器名为 `billy-ws-<workspaceId>`，容器内固定工作目录 `/workspace`；
  镜像约定见 `docker/Dockerfile.workspace-image`（python:3.13-slim + node 26 + pnpm，tag
  `billy-workspace:2026.11.0`）。
- **工作区目录（`local` 后端）**：工作区就是宿主机上的一个目录。没配 `location.root` 用默认
  `<WORKSPACE_LOCAL_ROOT>/<workspaceId>`（约定 `~/.billy/workspaces/<id>`）；配了就指向宿主上已存在的
  绝对路径，让 AI 直接读写本机项目目录（`bash` / 7 个文件能力都在它上面工作）。配了之后有三道闸：必须落在
  `WORKSPACE_LOCAL_ALLOWED_ROOTS` 内（不配 = 禁用）、不能覆盖凭据 denylist（`.ssh` / `.aws` 等）、
  要求 `AGENT_WORKSPACE_SANDBOX=true`；并且**不跑初始化**（不写 `.billy/` / `.agents/`、不装全局 CLI、
  不注入凭据环境变量）。容器后端不参与（不挂宿主卷）。见 `docs/design/workspace.md` §3.1.1。
- **docker 驱动**：dockerode 直连 Engine API（`DOCKER_SOCKET`，默认 `/var/run/docker.sock`），按镜像 /
  内存 / CPU / pids 限制创建容器，exec 走容器 API。**云端多租户不能用 docker 后端**（挂 docker.sock
  等于把宿主 daemon 交出去），必须用 k8s 后端。
- **k8s 驱动**：workspace = 一个 Pod（`emptyDir` 挂 `/workspace`，`restartPolicy: Never`），用
  `kubectl apply` 创建、`kubectl exec` 执行；Deployment 以 `billy-workspace-service` ServiceAccount 运行，
  RBAC 只授 pods 的 get/list/watch/create/delete 与 `pods/exec`（不授其它资源；工作区 Pod 带
  `app=billy-workspace` 标签，见 `k8s/16-rbac-workspace-service.yaml`）。
- **空闲回收**：`WorkspaceReaper` 每 60s 巡检一次，超过 `idleTimeoutMs`（默认 2h、`0` = 不回收）的
  工作区停掉；这是实际状态变化，不回写 `desired_status`，用户下次执行时 `ensure` 重新拉起。
- **能力登记（11 个）**：登记服务 `workspace`——`bash`（`mode='task'`，先受理再轮询 `/tasks/get`，
  owner=session，yield 45s，最长 30min）+ 7 个工作区文件能力（`file-list` / `read-file` / `write-file` /
  `append-file` / `replace-file` / `file-search` / `workspace-files`）+ 3 个凭据能力
  （`credential-candidates` / `credential-import` / `credential-save`，直接返回）。服务侧另有
  `POST /invoke` / `POST /tasks/get` / `POST /tasks/cancel` 接收网关转发。
- **文件权限**：工作区自身配置两档（`read-only` / `write`），`local` 后端映射到 kits 沙箱的三档
  （`read-only` / `workspace-write` / `danger-full-access`）：前两档由工作区配置决定，
  `danger-full-access` 是**部署级**能力（`AGENT_WORKSPACE_SANDBOX=false` 才放开，默认 `enforce`，
  沙箱不可用 fail closed）；容器后端本身即隔离，没有再按文件权限做只读约束。
  会话级 `file_access` 当前没有传到执行面（见「已知缺口」第 5 条）。
- **部署约束**：k8s 可多副本（2 副本，跨副本 lifecycle / exec / fs 锁与 lastUsed 走 Redis；任意副本都能处理任意工作区）；Docker 跨宿主 / local 后端仍只允许单副本，启动自检会拒绝。

### model-gateway（9992）

**内部模型网关**：运行时的模型调用全部经它，main 不直连供应商。它只读 `ai_providers` / `ai_models` /
`ai_provider_keys` 配置表（写方是 main），写 `model_gateway_usage` 用量流水，不碰会话 / 时间线 / 文件。
结构见 [model-gateway.md](../design/model-gateway.md)。

- **canonical 路由**：`POST /v1/models/{modelId}/chat/completions`（只在私有网络，由 runtime 调；路径里带
  `modelId`，网关不必解析请求体来路由）。请求头带归因 `x-billy-run-id` / `x-billy-conversation-id` / `x-billy-identity-*`。
- **四套协议适配**：`openai-compatible` / `deepseek` / `anthropic` / `ollama`（`ProtocolRegistry`，加协议才
  改这里，加厂商只改画像表）；canonical 请求体经适配器转成上游格式，响应流原样回给 runtime
  （含 SSE → 前端）。首字节超时默认 120s、流中空闲超时 180s。
- **目录**：`GET /internal/catalog` 给 runtime 的目录（不含密钥 / 上游地址），进程内缓存 30s，
  `ai.model.changed` 事件即时失效；目录只含启用的供应商 + 模型。
- **key 池**：`ai_provider_keys`，选 `status=active` → 未冷却 → 未超 rpm / 日 token / 日成本额度 →
  权重降序、最近最少用；选中后 `INCR` 分钟计数预占。429 → 冷却 30s；401/403 → 冷却 300s + 失败计数，
  连续 3 次置 `disabled`（人工恢复）；没有 key 行时回落到 `ai_providers.api_key`（兼容旧配置）。
  首字节前 429/401/5xx 可换 key 重试一次，写头之后不再重试。
- **用量**：每次上游尝试落一条 `model_gateway_usage`（provider / model / keyId / 流式 / 状态 / tokens /
  ttft / 时长 / 价格快照 + `cost_micros`，`usageMissing` 标记上游没给用量）；写失败只记日志，
  不影响模型响应。main 提供 `/agent/usage/gateway/{list,summary,reconcile}` 与后台「网关用量」页，
  reconcile 与 `runs` 的逐轮用量对账。
- **探活 / 测试代理**：`POST /internal/providers/list-models` / `POST /internal/providers/test` 只给 main 的
  「模型管理 / 上游 Key」页做同步与测试。**main 只做供应商 / 模型 / Key 池的配置 CRUD 与这两个代理**：
  写库归 main，真正使用 key、调上游只在网关。

## main 业务模块

业务三层（module + controller + service + repository + errors）位于
`apps/main/src/modules/`（13 个目录）：

```
modules/                       # 业务领域（每个模块同目录：module + controller + service + repository + errors + index）
├── auth/           # auth.service.ts（register/login/logout/forgot/reset/change-password/getMe/verifyToken）
│                   #   + auth.controller.ts + user-auth.guard.ts + user-auth.decorator/errors
├── admin/          # admin.service.ts（后台管理员 login/logout/getMe/CRUD/resetPassword/changePassword/verifyToken）
│                   #   + admin.repository.ts + admin.controller.ts + admin-auth.guard.ts
│                   #   token 带 type='admin'，与前台用户隔离
├── user/           # user.service.ts + user.repository.ts + user.controller.ts + errors
├── monitor/        # 控制面 HTTP：api/ MonitorController + MonitorHealthController（免鉴权 /monitor/health）
│                   #   引擎（definitions / engine / metrics / rules / sources）在 @repo/monitor，
│                   #   main 与 agent-runtime 各装配一份 forRootAsync，只有 main 提供 HTTP API
├── storage/        # storage.controller.ts（预签名 URL / STS 临时凭证）+ storage-key.ts（key 前缀策略）
├── stream/         # stream.controller.ts + stream-auth.guard.ts + stream.options.ts（SSE_ROUTE_OPTIONS）
├── share/          # 文件免授权分享（create/list/revoke + 公开 meta + 内部 resolve）+ share.token.ts
├── ops/            # OpsController（根路径 GET /healthz、/readyz、/info，运维探针的 GET 例外）+ OpsModule
├── session/        # 多设备会话管理（登录设备列表 / 踢下线）
├── ai-admin/       # AI 控制面 HTTP（6 个子模块 + 根级 memory.controller）：
│                   #   conversation（会话 / 运行 / 时间线 / 用量）· file（/agent/file/*）·
│                   #   tool（/ai-tool/*）· capability（/ai-capability/* + 服务级授权）·
│                   #   skill（/ai-skill/*）· workspace（/ai-workspace/*）·
│                   #   memory.controller.ts（/ai-memory/*，MemoryService 来自 @repo/ai-data）
├── ai-model/       # 供应商 / 模型 / 上游 Key 配置（ai-model.controller + ai-provider-key.controller）
├── ai-usage/       # 每日用量汇总 + 定时 rollup + 网关用量（gateway-usage.controller）
└── runtime-config/ # RuntimeConfigController（公开 POST /config/get）+ RuntimeConfigModule
                    #   目录名与类名刻意区别于 kits 的 AppConfigModule
common/security/               # main 专属访问控制（横切 HTTP 构件已并入 @repo/kits 的 http/）
├── authentication.ts   # token 提取 / 当前身份读取（AccessToken · currentUserId · currentAdminId）
├── any-of-guards.ts    # 「任一身份通过即可」守卫编排
└── rate-limit.guard.ts # @RateLimit + RateLimitGuard（依赖应用级 ServerConfig，故不进 kits）
agent/                         # /agent 的流式入口、控制接口、队列与 SSE 桥
├── agent-sse.controller.ts    # POST /agent/chat/stream（main 起流，转发 runtime）
├── agent-control.controller.ts# POST /agent/chat、/agent/chat/resume、/agent/run/stop
│                              #   + GET /agent/run/stream|snapshot、/agent/run/:runId/stream|snapshot
├── agent-sse.bridge.ts        # PubSub → 按 clientId 写 SSE（AG-UI 帧；不写 [DONE]）
├── agent-catalog.service.ts   # runtime status / list / instructions 代理（30s 缓存）
├── agent-run-queue.controller.ts  # POST /agent/queue/{list,update,remove}
└── agent-run-queue.service.ts     # 只读 / 改 / 删自己会话里 source=user 且仍 queued 的项
```

**使用方式（应用组合根 `apps/main/src/root.module.ts`）：**

> 下面只给骨架，省略了完整 imports 列表与全部实体；实际装配以
> `apps/main/src/root.module.ts` 为准。顺序约束（请求上下文 → 请求日志 → 请求指标、Db 的实体来自
> `@repo/db`、可选模块按 env 装配）是硬规定，见 [architecture.md](./architecture.md) 的「组合根与生命周期」。

```ts
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import {
  AppConfigModule, AppExceptionFilter, AuditSubscriber, CommandModule, DbModule, ERROR_ALERT_HOOK,
  EventBusModule, IdGenerationModule, JwtModule, KafkaModule, LarkModule, LoggerModule,
  NotificationModule, ObjectStorageModule, PasswordModule, PubSubModule, RateLimitModule, RedisModule,
  RequestContextModule, RequestLoggerModule, RequestMetricsModule, ResponseEnvelopeInterceptor,
  SchedulerModule, SessionStoreModule, StreamHubModule, TelemetryModule, WorkspaceModule,
  createZodValidationPipe, type DbModuleOptions, type ErrorAlertHook,
} from '@repo/kits'
import { DB_ENTITIES } from '@repo/db'
import { MemoryRepository, MemoryService } from '@repo/ai-data'
import { MonitorEngine } from '@repo/monitor'
import { AuthModule } from './modules/auth/index.js'
// …其余业务模块
import { OpsModule } from './modules/ops/index.js'
import { AgentSseController } from './agent/agent-sse.controller.js'
import { AgentControlController } from './agent/agent-control.controller.js'
import { AgentRunQueueController } from './agent/agent-run-queue.controller.js'
import { AgentSseBridge } from './agent/agent-sse.bridge.js'
import { AgentRunQueueService } from './agent/agent-run-queue.service.js'
import { MemoryController } from './modules/ai-admin/memory.controller.js'

@Module({
  controllers: [AgentSseController, AgentControlController, AgentRunQueueController, MemoryController],
  imports: [
    // 应用配置：bootstrap 已 await loadServerAppConfig()，这里接进 Nest（全局 ConfigService + AppConfig bean）
    AppConfigModule.forRoot(),
    // 请求级横切中间件（顺序硬约束：Context 必须在前，后两者在请求结束时从 ALS 读身份）
    RequestContextModule,
    RequestLoggerModule,
    RequestMetricsModule,
    // 基础能力（无配置）
    IdGenerationModule,
    TelemetryModule,
    SchedulerModule,
    CommandModule,
    // 工作区运行时（沙箱探测与执行环境选择）
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
        ...config.get<DbModuleOptions>('db'),
        // 实体是类引用，无法来自环境变量，由组合根补上
        entities: [...DB_ENTITIES],
        subscribers: [AuditSubscriber],
      }),
    }),
    // Redis / RateLimit / PubSub / StreamHub / EventBus / Jwt / SessionStore / Password /
    // ObjectStorage / Notification：需要配置的用 forRootAsync 惰性取分片，无自有配置的直接引模块
    RateLimitModule,
    PubSubModule,
    StreamHubModule,
    EventBusModule,
    // 可选模块：env 存在才装配
    ...(process.env.LARK_APP_ID && process.env.LARK_APP_SECRET
      ? [
          LarkModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => config.get('lark')!,
          }),
        ]
      : []),
    ...(process.env.KAFKA_BROKERS
      ? [
          KafkaModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => config.get('kafka')!,
          }),
        ]
      : []),
    // 运维探针（根路径 GET）
    OpsModule,
    // 业务模块：Auth / Admin / User / AiModel / AiSkillAdmin / CapabilityServiceAdmin / AiToolAdmin /
    // AiAdminConversation / AiFileAdmin / WorkspaceAdmin / Storage / Stream / Session / Share /
    // Monitor / RuntimeConfig
    AuthModule,
  ],
  providers: [
    AgentRunQueueService,
    AgentSseBridge,
    MemoryRepository,
    MemoryService,
    // 技术错误告警钩子：把 MonitorEngine 适配为 common 层 token（避免 HTTP 边界层反向依赖业务模块）
    {
      provide: ERROR_ALERT_HOOK,
      inject: [MonitorEngine],
      useFactory:
        (engine: MonitorEngine): ErrorAlertHook =>
        (error, context) =>
          engine.ingestError(error, context),
    },
    // 全局 Zod 校验 / 统一响应信封 / 统一异常处理
    { provide: APP_PIPE, useFactory: createZodValidationPipe },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class RootModule {}
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
- **开发态必须用 `node --import tsx/esm`**（`pnpm dev:main` / `pnpm dev:runtime` 已内置）：`tsx` CLI 会同时挂 CJS 钩子，导致 CJS 依赖（如 `pino`、`pg`）`require('@nestjs/core')` 与 ESM `import` 拿到**两份模块实例**，`ApplicationConfig` 这类跨包 class token 对不上而启动失败；只挂 ESM 加载器即与 `node dist/main.js` 行为一致
- 例外：kits 内部对带可选数值参数的构造器（如 `Telemetry`）用 `useFactory` 显式装配；`RateLimitGuard` 用 `Reflect.getMetadata` 直接读方法元数据而不注入 `Reflector`

**设计原则：**

- 通用能力（基础设施 / 横切基础 / 数据访问）归 `@repo/kits`，业务模块归 `apps/main`（控制面）与 `apps/agent-runtime`（运行面），能力执行归 `apps/capability-gateway` / `apps/common-capability` / `apps/workspace-service`，实体 / 迁移归 `@repo/db`
- 统一用 `@nestjs/common` 的 `@Injectable` / `@Inject`，所有能力与业务服务都是构造器注入依赖的 class
- 错误以 `Error` 子类抛出并携带 `code`，`AppExceptionFilter` 按 `code` 映射 HTTP 错误码与文案
- DTO / Zod 校验与 HTTP 错误转换只存在于 main 的 HTTP 边界（`/internal/agent/*` 的内部契约校验在 runtime）
- 业务模块不 import HTTP 框架（controller / 守卫等 HTTP 构件只出现在 HTTP 边界）
- 业务错误保持原义，不包装成统一 `AppError`
- 基础设施服务隔离数据库、Redis、JWT 与对象存储等技术细节，业务层不感知具体实现
- 无装饰器反射之外的魔法，兼容 Node type-stripping / esbuild / tsdown

## 认证

鉴权**只在 main**（runtime 与四个内网服务没有用户鉴权，只认内部令牌）。

- JWT token，通过 `Authorization: Bearer` 或身份对应的 cookie 传递（前台 `access-token` / 后台
  `admin-access-token`，两者名不同以免同域部署时互相覆盖）；payload 带
  `jti`（唯一 id，`TokenSigner.sign` 显式写入）—— 否则同一秒内重复登录会签出**逐字节相同**的
  token，服务端会话按 `sha256(token)` 主键会把两台设备合并成一条
- `UserAuthGuard`（`modules/auth/user-auth.guard.ts`）与 `AdminAuthGuard`
  （`modules/admin/admin-auth.guard.ts`）调用业务 `verifyToken`，校验通过后把 `userId` /
  `adminId` 写入 AsyncLocalStorage 请求上下文（管理员 token payload 带 `type: 'admin'`）；
  `AnyAuthGuard` 编排在 `common/security/any-of-guards.ts`（main 专属），依次尝试两个守卫，
  任一通过即放行，用于「双端都要开放」的能力
- 两类 token 的**身份体系**严格隔离（用户 token 不会获得管理员身份、反之亦然），但接口鉴权分四类：
  - **仅管理员**（`AdminAuthGuard`）：`/admin/*` 除 login / logout、`/user/*`、`/monitor/*`、
    `/ai-model/*`（含 `provider-key/*`）、`/ai-tool/*`、`/ai-capability/*`、`/ai-skill/*`、
    `/ai-memory/*`、`/ai-workspace/*`、`/agent/usage/summary|rollup`、`/agent/usage/gateway/*`、
    `/agent/file/admin/*`
  - **仅前台用户**（`UserAuthGuard`）：`/auth/get-me`、`/auth/update-info`、`/auth/change-password`
  - **任一身份**（`AnyAuthGuard`）：`/storage/*`、`/session/*`、`/sse/subscribe`、
    `/share/{create,list,revoke}`、`/agent/*` 的其余接口（含 `/agent/chat`、`/agent/chat/stream`、
    `/agent/chat/resume`、`/agent/run/*`、`/agent/conversation/*`、`/agent/file/{workspace,preview,workspace-link}`、
    `/agent/queue/*`）；`/storage/get-temporary-credentials` 在控制器里额外拒绝前台身份
  - **内部密钥**：只有 `POST /share/resolve`（给 Next 内容路由调，靠 `x-share-internal` 头里的
    `SHARE_INTERNAL_SECRET`，而不是用户 token）；内网服务之间另有一套 `x-internal-token`，与用户
    鉴权完全无关
- 公开接口（注册 / 登录 / 登出 / 忘记密码 / 重置密码 / 管理员登录与登出 / `POST /config/get` /
  `POST /monitor/health` / `POST /share/meta`）不加 Guard
- `/agent/*` 通过 main 的 Guard 后，身份以 `x-user-id` / `x-admin-id` 头传给 runtime；
  runtime 侧只校验 `x-internal-token`，并据此认定调用者（不重新验 JWT）
- Admin SSR 侧：`components/AdminAuthBoundary.tsx`（`main` 与 `(standalone)` 两棵布局共用）用 cookie
  调 `getMe()`，失败 `redirect()`；`proxy.ts` 中间件做首屏路由守卫（`api` 与分享页 `s/` 在 matcher 排除名单里）
- Web 侧：Server Actions 用 `@repo/ui/action` 的 `defineAction` 统一 `{ ok, data | error }` 结果约定（两个前端同一套）
- Admin 客户端：token 存 localStorage，同时写 httpOnly cookie 供 SSR 守卫使用
- **登录设备（会话管理）**：会话写入 Redis 时带 `sessionId` / `ip` / `userAgent` / 时间；
  `POST /session/list`（标出 `current`）与 `POST /session/remove`（按 `sessionId` 幂等下线），
  前台用户与管理员共用（`AnyAuthGuard`）。入口：web `/account/sessions`、admin 个人中心。
  设计见 [docs/design/session-management.md](../design/session-management.md)

## API 设计

所有**业务**接口均为 `POST`（每条路由显式 `@HttpCode(200)` 固定，Nest 对 POST 默认 201），
请求体由 Zod schema 校验，响应统一包装为 `AppResponse<T>`：

> **GET 例外共 8 个，分三类**：
> 1. 运维探针 `GET /healthz`、`GET /readyz`、`GET /info` —— k8s 的 `httpGet` 探针**只会发 GET**，
>    业务路由全 POST 会让探针 404、pod 永远不就绪，故为探针开放 GET（main 与 runtime 各有一套）；
> 2. AI 运行重连与快照 `GET /agent/run/stream`、`GET /agent/run/snapshot`、
>    `GET /agent/run/:runId/stream`、`GET /agent/run/:runId/snapshot` —— 浏览器 `EventSource`
>    只能发 GET（首次对话仍走 `POST /agent/chat/stream`）；快照是纯查询，走 GET 便于 SDK 复用
>    `HttpClient.get` 的鉴权 / 401 刷新，并把 204 归一成 `data: null`；
> 3. `GET /agent/file/workspace-content` —— 浏览器直取工作区文件流：`<img>` / `<video>` / `<iframe>`
>    带不上 `Authorization`，改按身份读 cookie；实现 Range 分段（206）与 `Content-Disposition`。
> 两个周期性探针路径（`/healthz`、`/readyz`）会被请求日志与请求指标跳过
> （`@repo/kits` 的 `http/ops-probe.ts`）：否则每 3s 一条日志刷屏，并把探针自身的 503 算进
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

**main 的路由表**（25 个 controller、约 129 个 POST + 8 个 GET；同组路由用 `{...}` 合并展示）：

| 路由 | 说明 | 鉴权 |
| --- | --- | --- |
| `POST /auth/register` | 注册 | 否 |
| `POST /auth/login` | 登录 | 否 |
| `POST /auth/logout` | 登出（幂等，无 token 也成功） | 否 |
| `POST /auth/forgot-password` | 忘记密码 | 否 |
| `POST /auth/reset-password` | 重置密码 | 否 |
| `POST /auth/get-me` | 获取当前用户 | 用户 |
| `POST /auth/update-info` | 更新个人信息 | 用户 |
| `POST /auth/change-password` | 修改密码 | 用户 |
| `POST /admin/login` / `POST /admin/logout` | 管理员登录 / 登出 | 否 |
| `POST /admin/{get-me,update-info,change-password,create,page-query,detail,update,remove,reset-password}` | 管理员自助与 CRUD | 管理员 |
| `POST /user/{create,page-query,detail,update,remove,reset-password}` | 前台用户管理 | 管理员 |
| `POST /storage/get-presigned-url` | 获取上传预签名 URL（前台用户 key 被改写进 `user/{userId}/`） | 用户 / 管理员 |
| `POST /storage/get-download-url` | 获取下载预签名 URL（前台用户仅限自己前缀，越界 403） | 用户 / 管理员 |
| `POST /storage/get-temporary-credentials` | 获取 STS 临时凭证（整桶权限，前台身份在控制器内拒绝） | 管理员 |
| `POST /session/list` | 登录设备列表（含 `current` 标记） | 用户 / 管理员 |
| `POST /session/remove` | 下线指定设备（按 `sessionId`，幂等） | 用户 / 管理员 |
| `POST /sse/subscribe` | SSE 订阅（长连接推流，body `{ channels: [...] }`） | 是 |
| `GET /healthz` | 存活探针（livenessProbe，**不探外部依赖**，进程活着即 200） | 否 |
| `GET /readyz` | 就绪探针（readinessProbe，探 DB / Redis，不可用返回 **503** + `code: 5002` 主动摘流） | 否 |
| `GET /info` | 运行信息（版本 / 运行时 / 已生效的长连接超时 / 工作区执行环境与沙箱能力） | 否 |
| `POST /monitor/health` | 健康检查（DB / Redis 探活，容器 / 云平台探针） | 否 |
| `POST /monitor/{rule/definitions,rule/list,rule/update,rule/reset,alert/page-query,alert/detail,metric/definitions,metric/series,metric/latest,engine/status,log/page-query,test}` | 监控 12 个接口：规则定义 / 实例 / 告警 / 指标时序 / 引擎状态 / 发送记录 / 测试通知 | 管理员 |
| `POST /config/get` | 公开运行配置（返回 `authEnabled`） | 否 |
| `POST /share/{create,list,revoke}` | 文件分享：生成链接（token 只存哈希）/ 历史记录（不含 token）/ 撤销 | 用户 / 管理员 |
| `POST /share/meta` | 公共分享元信息（分享页 SSR 用，按 token + 限流） | 否 |
| `POST /share/resolve` | 内部解析 token 换预签名地址（仅 Next 内容路由调用） | 内部密钥 |
| `POST /agent/status` | AI 能力状态（可用性 / 默认模型 / 模型数 / agent 数） | 用户 / 管理员 |
| `POST /agent/list` | agent 清单（`skills: ['*']` 由执行面按当前技能库现算） | 用户 / 管理员 |
| `POST /agent/instructions` | 系统指令原文（带 `conversationId` 取会话快照，否则取静态定义） | 用户 / 管理员 |
| `POST /agent/models` | 本轮可选模型（只回供应商 + 模型都启用的） | 用户 / 管理员 |
| `POST /agent/chat` | 非流式跑一轮（转发 runtime 的 `/internal/agent/chat`） | 用户 / 管理员 |
| `POST /agent/chat/stream` | 发起一轮对话（SSE 流式，唯一不套信封的对话接口；转发 runtime，输出经 Redis pub/sub 回写） | 用户 / 管理员 |
| `POST /agent/chat/resume` | 回答挂起中的一轮（`ask-user-questions` 后续跑，SSE；转发 runtime） | 用户 / 管理员 |
| `POST /agent/run/stop` | 停止某一轮（转发 runtime，由 runtime abort，跨副本经 Redis 广播） | 用户 / 管理员 |
| `GET /agent/run/stream` | 重连当前运行（SSE，`EventSource` 只能 GET；转发 runtime 的快照 + `sinceRev` 补发） | 用户 / 管理员 |
| `GET /agent/run/snapshot` | 当前进行中那一轮的快照（没有回 204，前端据此不点亮「恢复中」） | 用户 / 管理员 |
| `GET /agent/run/:runId/stream` | 重连指定运行（SSE） | 用户 / 管理员 |
| `GET /agent/run/:runId/snapshot` | 指定 run 的快照 | 用户 / 管理员 |
| `POST /agent/conversation/create` | 新建会话 | 用户 / 管理员 |
| `POST /agent/conversation/list` | 会话列表 | 用户 / 管理员 |
| `POST /agent/conversation/detail` | 会话详情 | 用户 / 管理员 |
| `POST /agent/conversation/rename` | 会话重命名（记一条时间线事件） | 用户 / 管理员 |
| `POST /agent/conversation/file-access` | 切换会话文件权限（只读 / 可写） | 用户 / 管理员 |
| `POST /agent/conversation/remove` | 软删会话（唯一的删除入口） | 用户 / 管理员 |
| `POST /agent/run/list` | 运行列表（含子 agent，审计与复盘） | 用户 / 管理员 |
| `POST /agent/run/detail` | 运行详情（输入快照 / 上游错误 / 子 agent） | 用户 / 管理员 |
| `POST /agent/timeline/list` | 会话时间线查询 | 用户 / 管理员 |
| `POST /agent/usage/summary` | 用量汇总（按模型 / 按 agent） | 管理员 |
| `POST /agent/usage/rollup` | 手动触发用量 rollup | 管理员 |
| `POST /agent/usage/gateway/list` | 模型网关调用账明细 | 管理员 |
| `POST /agent/usage/gateway/summary` | 模型网关调用账汇总 | 管理员 |
| `POST /agent/usage/gateway/reconcile` | 网关用量与 `runs` 逐轮用量对账 | 管理员 |
| `POST /agent/queue/list` | 会话输入框上方的待执行队列 | 用户 / 管理员 |
| `POST /agent/queue/update` | 修改排队中的用户消息 | 用户 / 管理员 |
| `POST /agent/queue/remove` | 删除排队中的用户消息（软取消） | 用户 / 管理员 |
| `POST /agent/file/workspace-link` | 工作区文件换临时 OSS 链接（前端直取，不经后端转发） | 用户 / 管理员 |
| `POST /agent/file/workspace` | 右栏工作区文件清单（不含内容） | 用户 / 管理员 |
| `POST /agent/file/preview` | 文本 / HTML 预览（会话文件或工作区文件） | 用户 / 管理员 |
| `GET /agent/file/workspace-content` | 工作区内容流（图片 / PDF / 音视频 / 下载，cookie 身份 + Range） | 用户 / 管理员 |
| `POST /agent/file/admin/list` | 后台文件页：跨会话全量列表 | 管理员 |
| `POST /agent/file/admin/preview` | 后台文件页：任意会话的文本预览 | 管理员 |
| `POST /agent/file/admin/stats` | 后台文件页：文件量统计 | 管理员 |
| `POST /ai-model/provider/{list,create,detail,update,remove,sync,test}` | 模型供应商配置（`sync` / `test` 经 model-gateway 代理） | 管理员 |
| `POST /ai-model/model/{list,create,update,remove}` | 模型配置 | 管理员 |
| `POST /ai-model/provider-key/{list,create,update,remove}` | 上游 key 池（列表不回明文，新增 / 轮换 / 停用 / 删除） | 管理员 |
| `POST /ai-tool/{list,detail,update,reset}` | 工具配置（开关 / 限额 / 配置值 / 密钥；作用域由代码声明决定、后台只读展示）；元数据问 runtime + 能力目录 | 管理员 |
| `POST /ai-tool/workspace` | 执行环境能力（只读探测：沙箱是否可用 / 允许哪些文件权限） | 管理员 |
| `POST /ai-capability/list` | 能力服务列表（来自能力网关，不返回凭据） | 管理员 |
| `POST /ai-capability/save` | 登记 / 更新 `source='manual'` 外部服务（保存即自动连通性 + 冒烟自检） | 管理员 |
| `POST /ai-capability/remove` | 删除外部服务 | 管理员 |
| `POST /ai-capability/status` | 启停一个能力服务 | 管理员 |
| `POST /ai-capability/test` | 只测连通，不登记 | 管理员 |
| `POST /ai-capability/grants/list` | 服务级授权全部授权行 | 管理员 |
| `POST /ai-capability/grants/set` | 覆盖式设置管理员可用的外部服务 / MCP | 管理员 |
| `POST /ai-capability/pull-mcp` | 从 MCP server 拉工具清单（网关注册表握手） | 管理员 |
| `POST /ai-capability/pull-manifest` | 拉对方清单（`POST {baseUrl}/manifest`）供页面确认 | 管理员 |
| `POST /ai-workspace/{list,create,update,remove,start,stop}` | 工作区控制面（CRUD + `desired_status` 写表；启停 / 销毁转发 workspace-service） | 管理员 |
| `POST /ai-skill/{list,detail,create,update,remove}` | 技能库增删改查（DB 为事实源，落盘给 runtime） | 管理员 |
| `POST /ai-skill/file/{read,save,remove}` | 技能文件读写删（`SKILL.md` 不允许删） | 管理员 |
| `POST /ai-skill/import/preview` | 导入预览（链接里有哪些技能、哪些已存在） | 管理员 |
| `POST /ai-skill/import` | 从链接导入技能（skills.sh / GitHub / Markdown） | 管理员 |
| `POST /ai-memory/{list,update,remove}` | 长期记忆后台管理 | 管理员 |

> 鉴权列：**管理员** = `AdminAuthGuard`（后台管理员令牌；`/admin/*` 的受保护路由、`/user/*`、
> `/monitor/*`、`/ai-model/*`、`/ai-tool/*`、`/ai-capability/*`、`/ai-skill/*`、`/ai-memory/*`、
> `/ai-workspace/*`、`/agent/usage/*`、`/agent/file/admin/*` 都是它；
> `/storage/get-temporary-credentials` 走 `AnyAuthGuard`，再由控制器要求管理员身份（发整桶凭证，
> 前台身份与鉴权关闭时的无身份请求都拒绝）；
> **用户** = `UserAuthGuard`（前台用户令牌，只用在 `/auth/get-me`、`/auth/update-info`、
> `/auth/change-password`）；**用户 / 管理员** = `AnyAuthGuard`（两套身份任一通过，身份分域由
> 调用方读请求上下文自行判断）；**内部密钥** = `/share/resolve` 的 `x-share-internal`。
> 前三种身份都从 Bearer / 对应 cookie 取令牌。
> `/sse/subscribe` 标「是」指 SSE 专用的 `StreamAuthGuard`（Bearer / cookie，按通过的身份订阅
> `user:{id}` / `admin:{id}` 并叠加 `admin:all` 广播频道与 `ai:owner:{id}` 派生频道）。

> runtime 的内部路由**不在这张表里**（不对外）：见上文「agent-runtime — agent loop」的内部接口表。
> 四个内网服务的路由见「内网服务」各自的表。

> SSE 事件通过 `StreamHub.publish(channel, event)` 推送：业务模块 `@Inject(StreamHub)` 后
> `publish('task:42', { event: 'progress', data: {...} })`；身份频道 `user:{userId}` / `admin:{adminId}`
> 自动订阅，业务频道需在 `modules/stream/stream.module.ts` 的 `SSE_ROUTE_OPTIONS`
> （`{ auth, broadcastChannels, derivedChannels, allowChannel }`）注入白名单校验（当前 `allowChannel`
> 全拒，只放行身份频道、`admin:all` 与按身份派生的 `ai:owner:{id}`）。

**监控告警**：监控引擎在 `@repo/monitor`——**main 既装配引擎也提供 HTTP API**（12 个 POST + 免鉴权
`/monitor/health`），runtime 只装配引擎（技术错误也进同一套告警表 / 通道，但没有 HTTP API）。
后台「运维监控」有 status / live / metrics / logs / rules 五个页面。

- **架构：定义（代码）→ 采集（槽位）→ 样本落库 → 规则评估 → 告警生命周期 + 通知**。
- **定义在代码、配置在库**：指标与规则都由代码注册（`MetricRegistry` / `RuleRegistry`；系统指标与规则
  在 `@repo/monitor`，main 的 `modules/monitor/ai-usage` 注册 `ai.usage.*` 等业务定义）；启动时
  `SeedService` 按 `ruleKey` 对账写入 `monitor_rules`（新建 / 恢复 / 更新元数据与定义版本哈希，
  代码里删掉的标 `deprecated` 并收掉在途告警），**不覆盖用户改过的 `config` / `enabled`**。
  因此后台只能改参数、开关、级别与通道，不能凭空新增规则。
- **埋点**（`@repo/kits` 的 `Telemetry`，一行埋点即可）：Counter / Gauge / 对数桶直方图（近似 P50/P95/P99）；
  框架由 `RequestMetricsMiddleware` 自动埋请求指标（`request.*`），业务自定义指标由业务方自行埋点
  并注册定义（AI 用量指标即走这条路径），样本按实例带 `instanceId`。
- **指标采集**：`MonitorTimeline` 按定义声明的评估周期分槽触发；每个实例采集本实例 raw 指标
  （`request.count` / `request.duration.count` / `request.duration.sum` / `request.error` /
  `request.p95` / `request.p99` / `process.memory.total` / `process.memory.used`，源为 telemetry / process），
  leader 额外采集 `scope: global` 指标；raw 采到后同一窗口计算 derived 指标（`request.qps` /
  `request.avgDuration` / `request.errorRate` / `process.memoryRatio`，只允许依赖 raw）；样本落
  `monitor_metric_samples`，按 `retentionDays`（默认 30 天）保留，由 leader 每 10 分钟清理一次。
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
方法装饰器开启限流；AI 对话的两个入口 `/agent/chat` 与 `/agent/chat/stream` 各带一条
`scope: 'agent-chat'`、10 次 / 60s、按用户的限流。runtime 侧没有额外的并发准入（见「已知缺口」）。

## 日志

后端日志是**自建 logger**（`@repo/shared` 的 `createLogger`，**不再依赖 nestjs-pino**），六个 Nest
服务各建一个实例、共用同一套实现：

- **唯一 pino 实例**：`LoggerModule` 用 `createLogger(prefix, pretty, level, { redact, transport })`
  建一个实例并以 `LOGGER_INSTANCE` 暴露。pino 的 `transport` 会为每个实例拉起 worker 线程，
  所以**只能建一次**；需要带 context 的日志一律 `child(context)` 派生；
- **框架日志与业务日志同通道**：`main.ts` 用 `NestFactory.create(RootModule, { bufferLogs: true })`
  缓冲启动期日志，随后 `app.useLogger(app.get(NestLoggerAdapter))` 接管，Nest 自身的 InstanceLoader /
  RoutesResolver 等日志经适配器落到同一个 pino 实例；
- **业务类构造器注入** `AppLogger`（`Scope.TRANSIENT` + `INQUIRER`，自动以宿主类名作 `context`）：
  `logger.log('<域>.<动作>', { id })`。不要再使用 `@Logger()` 装饰器（已删除）；
- **请求日志由 `@repo/kits` 的 `RequestLoggerMiddleware` 记录**：method / url / statusCode /
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

## 已知缺口

以下是**已核对代码**、文档必须如实写出的现状，不是设计目标：

1. **断线重连仍是 Redis 补发，不可回放**：`/agent/run/stream` / `/agent/run/:runId/stream` 走 runtime 的
   Redis 输出记录（`agent:stream:<runId>` 每小时过期、最多 2 万帧 / 32MB，超出从头部裁剪）；
   runtime 重启或 Redis 丢键 / 裁剪后，正在跑的流不可续——快照只能补「仍未闭合 part」，历史内容走
   `timelines`。
2. **AI 对话 runtime 侧无准入**：main 的两个对话入口有 `scope: 'agent-chat'` 的 10 次 / 60s 限流，
   但 runtime 内部接口没有并发上限 / 排队准入（用户消息队列只消化「同一会话的并发输入」，不是全局
   容量控制）；能力调用侧只有能力网关的每用户每能力每分钟限流。容量风险与压测口径见
   `.agents/memory/ai-scale-bottlenecks.md`。
3. **会话级 `file_access` 没有传到执行面**：`conversations.file_access`（只读 / 可写）只在 runtime 的
   执行信封与本地工具入参里；bash / 工作区文件走能力网关，`POST /v1/capabilities/invoke` 协议里没有
   这个字段，workspace-service 按 `ai_workspaces.file_access` 决定 `local` 后端的沙箱权限，
   容器后端本身即隔离、没有再按文件权限做只读约束。切档位要生效，当前必须改工作区配置，而不是只改会话。
4. **k8s 下的 kubectl 凭据不在清单里**：workspace-service 的 k8s 后端靠 `kubectl` 创建 / exec 工作区
   Pod，但清单只提供 ServiceAccount / Role（`16-rbac-workspace-service.yaml`），没有把
   `KUBECONFIG` / in-cluster 凭据注入 Pod（kubectl 不会自动使用 ServiceAccount token）；上线前需由
   运行环境补齐（或改用 in-cluster API 客户端）。
