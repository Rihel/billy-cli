# AI 分布式架构升级（评审稿）

> **历史注记（2026-11-18）**：连接器模块已整体删除（见 `capability-gateway.md` D11），文中连接器相关内容仅作历史论证保留。

> 云端多租户、大量用户直接用 Agent。拆 5 个可独立扩缩容的 app，客户端 API 不变，保住「本地 Agent」体验。
> **状态（2026-11-14 更新）**：P3 的 main / agent-runtime 拆分与 P5 的 tool-gateway + tool-worker 已落地；
> model-gateway 未建。本文保留设计论证，**正文里的 `server` / `facade` 分别读作 `main` / `agent-runtime`**；
> 与实现不一致的地方集中在下面「0.1 落地现状」。
> 运行时细节见 `ai-agent.md` / `ai-agent-tool-engine.md` / `sse.md`。
> **一页结论**：[distributed-ai-conclusions.md](distributed-ai-conclusions.md)。

## 0.1 落地现状（2026-11-14）

| 设计项 | 设计稿 | 实际落地 | 差异 / 缺口 |
| --- | --- | --- | --- |
| 服务拆分 | `server` / `agent-runtime` / `model-gateway` / `tool-gateway` / `tool-worker` 五个 | `apps/main`（9989）/ `apps/agent-runtime`（9990）/ `apps/tool-gateway`（9993）/ `apps/tool-worker`（9994） | **model-gateway 未建**，模型调用仍由 runtime 直连供应商 |
| 命名 | 文档里的 `server`（BFF）/ `facade`（编排） | `apps/main` / `apps/agent-runtime` | 包名 `@app/main` / `@app/agent-runtime`；旧的单 `server` app 及其 `@app/…server` 包名已删除 |
| 客户端契约 | 「客户端 API 不变」 | 前端只连 main 9989，`/agent/*` 路径不变 | 非流式 `POST /agent/chat` 当前没有实现的服务端路由（SDK 里仍留着方法），见后端文档「已知缺口」 |
| runtime → main 的输出 | 设计稿是 facade → server 的**内部 SSE 中继** + offset 续读 | **Redis pub/sub 定向频道** `agent:stream:client:<clientId>`：runtime 发、main 的 `AgentSseBridge` 写 SSE；`clientId` 绑定在 Redis 进度 Hash | 2026-11-15 从 Kafka 回退（1.5M 条 / 686MB，回放能力没人用）；断线重连走 Redis 输出记录补发 |
| 停止 / 续答 | `POST /run/stop`、suspended 后 resume | **已补**：main `/agent/run/stop`、`/agent/chat/resume` 转发 runtime 内部接口 | 无 |
| 文件接口 | 归 server（数据面唯一写方） | `GET/POST /agent/file/*` 在 **main**；runtime 只有文件工具执行侧（`modules/ai/files`） | worker 侧 file 工具已直连 PG/OSS（见结论文档） |
| 控制面 → 运行面的配置变更 | 未细写 | **Redis EventBus**：`ai.skill.changed`（技能落盘 / 刷新）；**Redis + Kafka 双发**：`ai.connector.sync`（连接器同步 / 摘工具 / 刷缓存） | 都是 at-most-once / 幂等补偿；没有统一的事件目录 |
| 运行形态开关 | 一套代码两种模式：`embedded` / `distributed`（`AGENT_RUNTIME=...`） | **固定双进程**：main + runtime 同时起，没有 embedded 回退 | 本地 / 单机也不再有「server 内嵌 AI」形态；`dev:stack` 起全套 |
| 时间线写方 | facade 写 `runs` / `timelines` / `ai_memories`，server 只读 | 一致：runtime 执行期写，main 只读（`/agent/run/*`、`/agent/timeline/list`） | 无 |
| 工具执行 | 能力工具全在 worker，gateway 只做策略 | bash / web / memory / file / read-tool-result 已迁 worker（worker 直连 PG/OSS/Redis）；skill-* 不迁 worker：执行在 runtime 本地、写库在 main | `planner` / `subagent` / `ask-user-questions` 仍是 runtime 编排原语，不算工具 |

**实际链路（一次流式对话）**：

```
前端 ──POST /agent/chat/stream──> main（鉴权 + 生成 clientId）
        └──内部 HTTP（x-internal-token / x-user-id / x-admin-id / x-main-client-id）──>
              runtime POST /internal/agent/chat/stream
                └─ agent loop → 每段输出：① Redis 广播（旧路径 / 断线补发）
                                          ② Redis pub/sub：agent:stream:client:<clientId>
        main AgentSseBridge（PubSub 订阅该 clientId 频道）
          └─ 按事件 clientId 写 data: 帧；final → data: [DONE]
```

- 帧结构 `@repo/shared` 的 `AgentStreamFrameSchema`（`runId` / `chunk` / `final`；收件地址在频道名里）。
- `clientId` 由 main 在 attach 时生成并写进 runtime 的进度 Hash（`agent:run:<runId>`），
  重连落在别的副本上也能把实时片段发给新连接；发布失败只记日志，不阻断模型流。
- 配置文件与命令：main `AGENT_RUNTIME_URL` / `AGENT_INTERNAL_TOKEN` / `KAFKA_BROKERS`；
  runtime `PORT=9990` / `AGENT_INTERNAL_TOKEN` / `KAFKA_BROKERS`。

## 0. 摘要

- 目标拆 `server` / `agent-runtime` / `model-gateway` / `tool-gateway` / `tool-worker` 五个无状态服务；
  截至 2026-11-14 已落地 **main（原 server）+ agent-runtime + tool-gateway + tool-worker**，
  model-gateway 未建。
- **先容量止血，再拆分**：拆分不解决 512Mi、无准入、本地工作区。
- 状态只放 PG / Redis / S3；本地盘只做可丢弃缓存；不依赖 sticky。
- 工作区以 S3 为真相 + 临时目录 hydrate/回写；L3 长驻进程/预览不做。
- 时间线归 facade 写；模型网关只做原生协议透传；**能力工具全在 worker，gateway 只做策略**。
- 运行状态机与心跳沿用现有语义；跨进程用**条件 UPDATE + 租约**保证同一时刻只有一个执行者。
- 组件保活分四层：连接 keepalive / 心跳 / 租约 / 探针；liveness 不探依赖，readiness 只探本 Pod 依赖。
- 可观测：指标（Prometheus）+ 链路（OTel）+ 日志（pino/Loki）；技术告警走 Alertmanager，业务告警留在现有 MonitorEngine。
- Mastra 只留在 agent-runtime：gateway / worker / main 不 import `@mastra/*`，升级爆炸半径收在一个 app。
- 两种运行形态一套代码：`embedded`（本地/单机，server 内含 AI）与 `distributed`（5 app），环境变量切换。
  **未实现**：实际固定 main + runtime 双进程，没有 embedded 回退（见 0.1）。
- 服务发现：无状态服务靠平台 DNS / 环境变量；**只有 tool-worker 自注册**（能力、负载、租约）。
- 所有 app 间调用统一走 `@repo/internal-sdk` 的 typed client，业务代码不直接 fetch 内部地址。

## 1. 背景、目标与非目标

### 1.1 场景

云端 SaaS，多租户共享集群，峰值流量是常态；成本主要是模型 token，工具执行次之。

### 1.2 目标（可验收）

- 五个 app 可独立部署、扩缩容；杀任意 Pod 不丢跨请求状态、不需要 sticky。
- 客户端 API 与前端零改动；停止/重连/崩溃恢复/子 agent 明细行为不变。
- 300 并发轮次不 OOM、不 502；首 token 与中继延迟达 SLO。
- worker 无主库凭据、无 provider key；跨会话工作区不可见。

### 1.3 非目标

- L3 长驻进程 / 预览 URL（需要会话级沙箱，违背全无状态）。
- 拆数据库、跨服务事务、用 MQ 做同步执行链路。
- 多区域（本期单区域多 AZ）。

### 1.4 约束

- **全无状态**：跨请求状态一律外置；本地盘只放可重建的缓存。
- 共享 PG，**每张表一个写方**；不做物理外键。
- 多租户隔离：命令/文件/凭据不能跨会话。

## 2. 现状与瓶颈

- 单进程：AI 模块 159 文件 / 26,420 行，Mastra、工具、SSE、业务 API 同进程。
- 六个卡点（2026-11-14）：512Mi 无 HPA、AI 接口无准入、工作区在 Pod 本地盘、
  Redis 每 run 缓冲 2 万条无字节上限、DB 池 10/实例、时间线无分区。
- 三条矛盾：**有状态**（工作区/分页/文件锁在进程）、**无上限**（可开无限会话）、
  **共享资源**（PG / Redis / 供应商 key）。
- 拆分只缓解「共享资源」的一部分；前两条不先处理，拆完只是复制问题。

## 3. 方案总览

### 3.1 架构（设计目标，标注落地状态）

```
client ──> main（BFF，SSE 中继）──> agent-runtime（编排）──> model-gateway ✗未建 ──> 供应商
                                      └──> tool-gateway ──> tool-worker（所有能力工具）
                                                                ├─ 数据 API ──> main（file / skill / memory）
                                                                └─ 对象存储 / 临时工作区
runtime 内部：planner / subagent / ask（编排原语，不经 worker）
输出回传（实际实现）：runtime ──Redis pub/sub(agent:stream:client:<clientId>)──> main 的 AgentSseBridge ──SSE──> client
状态：PG（真相）/ Redis（流、锁、配额）/ S3（工作区）
```

> 实际链路与上图差异：没有 model-gateway（runtime 直连供应商）；runtime → main 的输出不是内部 SSE
> 中继，而是 Redis pub/sub 的定向频道 `agent:stream:client:<clientId>`；断线重连走 runtime 的 Redis 输出记录补发。

### 3.2 app 清单（原设计五个，当前四个）

| app | 职责 | 写表 | 扩容指标 | 状态 |
| --- | --- | --- | --- | --- |
| `main`（原 `server`） | 客户端 API、鉴权、会话/文件/配置、AI 全量 CRUD、SSE 中继、用量 rollup、工作区清单与 GC | `conversations`、`ai_files`、配置表、`ai_usage_*` | 连接数 / CPU | 已落地（9989） |
| `agent-runtime` | 上下文、提示词、记忆、技能、规划、子 agent、准入、run 状态机/心跳/租约、durable 恢复；**唯一持有 Mastra** | `runs`、`timelines`、`ai_memories` | active runs / 内存 | 已落地（9990，只给 main 调） |
| `model-gateway` | 供应商原生透传、key 池、租户配额、排队降级、用量 | `model_gateway_usage` | 并发流 / RPS | **未建** |
| `tool-gateway` | 工具目录、插件链、审计、路由、分页句柄（**不执行工具**） | `ai_tool_audit` | QPS / P95 | 已落地（9993） |
| `tool-worker` | **所有能力工具**（bash/web/file/skill/memory/connector）；按会话 hydrate；自注册能力/负载 | 无 | 队列深度 | 已落地（9994） |

### 3.3 数据归属

| 表 | 写 | 读 |
| --- | --- | --- |
| `conversations` / `ai_files`（`ai_workspaces` 未建） | main | runtime（只读附件） |
| `runs` / `timelines` / `ai_memories` | agent-runtime | main |
| `ai_providers` / `ai_models` | main（配置） | runtime（元数据；model-gateway 未建） |
| `ai_tools` / `ai_connectors` / `ai_skills*` | main（配置） | tool-gateway / runtime |
| `ai_tool_audit` | tool-gateway | main |
| `model_gateway_usage` | model-gateway（未建） | main（对账，未建） |
| `ai_usage_daily*` | runtime 采集 / main 查询与 rollup | main |

保留：`timelines` 按月分区、热 90 天；`runs` 180 天、终态 7 天后清 `snapshot`；审计 90 天。

## 4. 关键决策

### D1 全无状态

**决策**：任何副本可服务任何请求；跨请求状态只放 PG / Redis / S3；本地盘只做可丢弃缓存。
**理由**：扩缩容/故障切换不受实例影响。**代价**：工作区要同步、分页/锁/计数全部 Redis 化。
允许执行期局部状态（run 循环、abort、planner）；run 用 Redis 租约 + DB 心跳，实例死了标
`interrupted`，可从 durable 快照恢复。

### D2 时间线归 facade 写

**决策**：`runs` / `timelines` / `ai_memories` 由 facade 写，server 只读；server 只做 BFF 与 SSE 中继。
**理由**：时间线是编排过程的产物，main 崩了不能丢事件。**代价**：main 的用量 rollup 依赖 runtime 写入。

### D3 工作区：S3 真相 + 临时目录

**决策**：`ws/<conversationId>/` + `ai_workspace_files` 清单 + 每次执行临时目录。
**理由**：满足全无状态，任意 worker 可执行、重启不丢。**代价**：首次命令要 hydrate（目标 1–2s）；
配额 500MB / 2,000 文件；闲置 30 天 GC。

### D4 模型网关只透传

**决策**：按 `providerKind` 暴露原生路径，只做鉴权/配额/透传；facade 用官方 SDK + `baseURL` 指向网关。
**理由**：翻译层会丢 `reasoning_content` / 多模态字段。**代价**：新增供应商要加路径与官方适配；
provider key 只留在 gateway。

### D5 工具执行：能力工具全在 worker

**决策**：所有**有副作用的工具**（bash / web / file / skill / memory / connector）都在 `tool-worker`
执行；`tool-gateway` 只做策略（enabled/scope/限流/校验/脱敏/分页/审计）与路由；`server` 的
`ToolGateway` 与插件链最终**删除**。

**编排原语不算工具**：`planner` / `subagent` / `ask-user-questions` 需要 agent loop / 客户端交互，
留在 facade 作为内部能力；`read-tool-result` 的分页结果放 Redis，由 worker 取页。

**数据访问**：worker 不连主库；file / skill / memory 通过 server 内部 API（SDK + scoped token）
读写，worker 只碰对象存储 / 临时工作区。新增数据接口必须先加 contracts + SDK。

**已实施（bash 控制面）**：gateway 提供 `/v1/tools/list` 静态 manifest；scope / validate /
rate-limit 在 gateway；每次调用写 `ai_tool_audit`；server 命中 allowlist 时**不再跑本地插件链**，
策略只有 gateway 一份。`web-fetch` / `web-request` / `web-search` / `memory-*` / `skill-*` / `file-*` / `read-tool-result` 已迁 worker；静态能力工具已全部迁完。

**Nest 生命周期分工**：`InternalTokenGuard`（令牌）→ `ToolCallInterceptor`（策略 pre 可短路 +
handler + 审计 post）→ `ZodBodyPipe`（契约校验）→ controller。策略步骤仍是 DI 的域服务，
由 interceptor 托管；这样既用上 Nest 的 Guard/Pipe/Interceptor，又保留按工具短路与统一结论。

**元数据权威**：工具定义（参数 / 描述 / scope）唯一来源是 `@repo/tool-catalog`；server 的
`@ToolDecl` 与 gateway 的 `/v1/tools/list` 共用；DB `ai_tools` 只存 enabled / limits / config /
secrets；worker 只注册 executor key / 版本，不报 schema。server 的 `resolveTools` 已消费
`/v1/tools/list` 做运行时工具面过滤（未配置 / 抖动 fail-open）。gateway 已读 `ai_tools`（5s 缓存），
把 enabled / scope / limits / config / secrets 合并进 `ToolInvokeRequest.settings`；停用/越权在
策略层拒绝，secrets 只走内部请求，不进审计。

**理由**：执行集中在一个数据面，隔离与资源限制只有一处；gateway 只做治理。
**代价**：worker 需要一组 scoped 数据 API；策略迁 gateway 是一次性重构。

### D6 准入与排队

**决策**：单用户 1 轮（Redis 锁，120s + 看门狗）、单 Pod 120 并发（满了 429）、
租户 RPM/TPM/日 token 配额（model-gateway）；标题/记忆抽取走低优先级 lane。
**理由**：供应商、PG、Redis 都有硬上限，先过载保护再谈扩容。**代价**：高峰会排队或 429。

### D7 共享 PG + 表所有权

**决策**：先不拆库，按表授权写方；跨服务只经 API/只读账号。实体/迁移统一收在 `@repo/db`，
server 用 `DB_ENTITIES` 装配，gateway 只注册自己写的审计实体。
**理由**：会话/时间线强关联查询多，拆库成本高。**代价**：库级耦合仍在，后续再评估分片。

#### 当前写方清单（2026-11-22）

| 表 | 写方 | 状态 |
| --- | --- | --- |
| `runs` | agent-runtime（执行 / 取消 / 看门狗）；main 只读 | 已收口；main 删会话改调 runtime 取消接口 |
| `timelines` | agent-runtime（执行事件 / 快照 / 控制面状态事件）；main 只读 | 已收口：rename / fileAccess 走 runtime `timeline/status` 内部接口 |
| `conversation_run_queue` | agent-runtime（claim / 状态转移 / 用户排队项编辑 / 删除）；main 只读列表 | 已收口：main 的 update / remove 走 runtime 内部接口 |
| `conversations` | main（CRUD / 标题 / 权限 / 软删）+ agent-runtime（子会话创建 / 无 conversationId 的非流式 chat） | 例外：需要定「谁创建、谁只改元数据」 |
| `ai_workspaces` / `ai_skills` / 凭据 | main 写；workspace-service 只读 | 清晰 |
| `model_gateway_usage` | model-gateway | 清晰 |
| `ai_tool_audit` | capability-gateway | 清晰 |
| `run_ownership` | agent-runtime（Mastra run fencing） | 清晰 |

结论：**不是"已经每表一个写方"，而是"已知例外并收口了大半"**。剩余例外只剩
`conversations`（main 与 runtime 都能创建），不拆库。

### D8 Mastra 只在 facade

**决策**：保留 Mastra，但只放在 `agent-runtime`；`model-gateway` / `tool-gateway` / `tool-worker` /
`server`（P3 后）禁止 import `@mastra/*`。

**理由**：agent loop、durable 恢复、memory thread、skills、UI stream 适配已经在 Mastra 上跑通，
重写风险高、收益低；拆分后真正要自研的是边界（状态机、租约、工具路由），不是循环本身。
只有 facade 需要它，升级/替换的爆炸半径从整个 server 缩到一个 app。

**代价**：facade 冷启动与内存更重；Mastra 的 durable / registry 与我们的状态机有重叠，
必须明确「谁说了算」。

**边界**：

- 运行状态机 / 心跳 / 租约以 DB + Redis 为准；Mastra durable 只是续跑机制，不是真相。
- 模型解析走 `ModelClient` → model-gateway；不让 Mastra 决定 provider 端点。
- 工具执行走 `ToolInvoker` → tool-gateway / worker；Mastra 只看到代理工具。

**退出条件**（任一满足就换成 AI SDK 直接写循环，`TurnEngine` 端口保证可替换）：

- Mastra 升级连续破坏 durable / stream 契约；
- durable 与我们的租约/状态机冲突，无法收敛；
- 单轮内存或冷启动成为容量瓶颈，且拆进程解决不了。

**守卫**：`check:mastra` 从「core/tools 禁止」扩成「除 facade 外全仓禁止」；
facade 内继续只允许 `mastra/**` + 现有 allowlist，且 allowlist 只减不增。

### D9 内部 API 调用统一走 SDK

**决策**：所有 app 间 HTTP 调用必须经 `@repo/internal-sdk` 的 typed client；业务代码不直接 fetch
内部地址、不自己拼超时 / 令牌 / 错误映射。

**理由**：契约单源（`@repo/contracts` + SDK）、令牌与超时只实现一次、错误分类统一；
将来换 transport（HTTP → gRPC / 队列）只改 SDK，调用方不动。

**代价**：新增一个包；每加一个内部端点要同步 contracts、SDK 方法、测试三处。

**规则**：新增内部端点 → 先加 `@repo/contracts` schema → 再加 SDK 方法 → 最后才允许调用方使用。
`@repo/sdk` 是给前端 / 外部用的业务 SDK，不混内部服务客户端。

**现状（2026-11-24）**：`@repo/internal-sdk` 覆盖全部 app 间调用 ——
`AgentRuntimeClient`（runtime：目录查询、取消会话、队列项、时间线状态，以及对话执行的
`chat` / `stopRun` / 运行快照 / `openStream` SSE 透传）、`WorkspaceServiceClient`、`CapabilityGatewayClient`、
`ModelGatewayClient`、`MainInternalClient`（workspace-service → main 的 `credentials/resolve`、
`credentials/import`）。main 的 `/agent/*` 中转不再直接 fetch：JSON 走 typed client，
SSE 用 `openStream` 拿原始流再交给 pub/sub 桥接。早先的 `ToolGatewayClient` / `ToolWorkerClient`
随 tool-gateway / tool-worker 下线已删除。

### D10 子 agent = 子会话

**决策**：子 agent 不再复用父会话 id，而是建一条 `kind='subagent'` 的子会话；子 run / timeline
挂在子会话上，工作区 / 文件仍指向父（根）会话。

**已实施（第一版）**：`conversations` 六个字段 + 迁移；`ConversationRepository.ensureSubagent`
幂等建子会话；`AgentRunner` 用子会话 id 建 run / 写 timeline，信封带 `workspaceConversationId`；
bash / file 工具按根会话工作；会话列表过滤子会话；删父级联软删子会话；`run-sub-agent` 结论带
`conversationId`。

**未做**：子会话单独 resume / 分享、自己的 memory thread 与抽取、UI 打开入口、历史回填。

## 5. 运行生命周期

### 5.1 状态

| 状态 | 含义 | 活跃 | 说明 |
| --- | --- | --- | --- |
| `pending` | 已接单、尚未起跑 | 是 | 看门狗也扫（`COALESCE(started_at, created_at)`），防止永久卡住 |
| `running` | 模型 / 工具执行中 | 是 | 每 15s 续 DB 心跳 |
| `suspended` | 等用户回答（`ask-user-questions`） | 是 | 占会话、不占运行槽；看门狗**不扫**；保留 `engine_run_id` 与快照 |
| `succeeded` | 正常完成 | 否 | 终态 |
| `failed` | 模型 / 工具 / 超时失败 | 否 | `error_stage` 区分环节 |
| `canceled` | 用户停止或放弃 | 否 | 终态 |
| `interrupted` | 进程中断、未恢复 | 否 | 重试 = 新建一轮；子 run 可原地重启 |

```
新建 ──> pending ──起跑──> running ──完成──> succeeded
           │                 │ ├─错误──> failed
           │                 │ ├─停止──> canceled
           │                 │ └─挂起──> suspended ──resume──> running
           ├─看门狗─────────> failed(timeout)
           └─启动清理───────> interrupted
```

**不变式**

- 排队不是 run 状态：拿到准入槽位前不建 run；事件里的 `queued` 只是 UI 反馈。
- 同一会话最多一个活跃**根** run：部分唯一索引 `uk_run_active_conversation`
  （`parent_run_id IS NULL AND status IN ('pending','running','suspended')`）。
- 终态不再转移；`suspended` 不是终态，也不是失败。
- 子 run 有独立状态，不改变会话的运行灯。

### 5.2 转移

| 从 | 到 | 触发 | 守卫 / 副作用 |
| --- | --- | --- | --- |
| 新建 | `pending` | facade 接单 | 唯一索引挡住同会话并发 |
| `pending` | `running` | 调模型前 | 写 `started_at` / `heartbeat_at` / `engine_run_id` |
| `running` | `suspended` | 工具挂起 | 保留快照与 engine id；释放用户槽；灯灭 |
| `suspended` | `running` | 用户 resume | 必须有 `engine_run_id`；先占回会话 |
| `running` | `succeeded` | 正常结束 | 写 usage / 步数 / 耗时 |
| `running` | `failed` | 模型 / 工具错误 | 写 `error_stage` / `error_code` |
| `pending` / `running` | `canceled` | 用户 stop / 删会话 | 先 abort，再落终态 |
| `pending` / `running` | `failed`（timeout） | 看门狗 | 条件 UPDATE；`reason` = `stale_heartbeat` / `run_timeout` |
| `pending` / `running` | `interrupted` | 启动清理 / 恢复失败 | 单副本按 `bootedAt`；多副本交给看门狗 |
| `suspended` | `canceled` | 放弃回答 | 释放会话 |

### 5.3 并发与恢复

- **所有转移都是条件 UPDATE**（`WHERE id = ? AND status IN (...)`）：影响行数 1 的副本才算赢，
  多副本天然幂等，不需要分布式锁。
- **唯一索引是并发底线**；应用层的 run 租约只防「双跑」，不替代 DB 状态。
- 目标态加 **run 租约**：`SET NX PX 60s`，每 15s 续；租约丢失 → 立即 abort + 条件更新，
  避免脑裂时两个 facade 同时跑同一轮。
- 崩溃恢复：启动抢 `agent:recovery:lease`（600s）→ `recoverAllDurableAgents()` →
  清理孤儿（单副本才按启动时间；多副本跳过）→ 看门狗兜底。多副本必须
  `AGENT_MULTI_INSTANCE=true`，否则滚动更新会误杀别的副本。
- durable 快照 + Redis memory thread 让续跑不依赖原进程；根 run 的重试 = 新 run，
  挂起中的 continue = 原 run。

## 6. 心跳、保活与超时

先分清四件事，别混：

- **keepalive**：保连接（SSE 注释帧、HTTP keep-alive），不代表任务在跑；
- **heartbeat**：证明执行者还活着（DB `heartbeat_at`），失效 = 可能没人管；
- **lease**：有期限的所有权（Redis TTL），丢失即让位；
- **probe**：k8s 决定是否接流量（`/healthz` / `/readyz`）。
超时是第五件：请求级 deadline。四层各管各的，不能拿一层替代另一层。

### 6.1 运行心跳

| 心跳 | 间隔 | 存哪 | 作用 | 丢了会怎样 |
| --- | --- | --- | --- | --- |
| SSE 注释帧 `: ping` | 15s | 连接 | 保客户端 / 网关连接 | 客户端重连；不影响 run |
| facade → server 内部流心跳 | 15s | 连接 | 保中继连接 | server 重连续读；facade 继续跑 |
| DB `runs.heartbeat_at` | 15s（子 run 1s） | PG | 证明「还有人在管」 | 60s 后看门狗判 `stale_heartbeat` |
| Redis 进度 `heartbeatAt` | 15s | Redis | 重连 / 观测 | 只降级实时性，不影响正确性（TTL 6h） |
| run 租约（目标态） | TTL 60s / 续 15s | Redis | 防双跑 | 丢失即自我中止 |
| 恢复租约 | TTL 600s | Redis | 多副本只让一个做启动恢复 | 过期后别的副本可接手；真正的 per-run 互斥由 `run_ownership` fencing 兜底 |

### 6.2 组件保活矩阵

| 链路 / 组件 | 保活机制 | 间隔 / 超时 | 断了怎么办 |
| --- | --- | --- | --- |
| client ↔ server | SSE 注释帧；ingress 长连接 | 15s；网关空闲 75s、读 3600s | 客户端抖动重连（0–3s）；**不 abort run** |
| server ↔ facade | facade 写注释帧；server 读空闲超时 | 15s；空闲 60s | facade 死：server 发 error；server 死：facade 继续写时间线/Redis |
| facade ↔ model-gateway | HTTP keep-alive + 首字节超时 | keep-alive 30s；连接 5s、首字节 120s、空闲 180s | 首字节前可重试 2 次；有字节后不重试；客户端断则 abort 上游 |
| facade ↔ tool-gateway | 每次 invoke 带 deadline；progress 帧 | progress 10s；deadline = 工具配置时长 + 传输余量（bash 默认 5 分钟 + 10 秒） | 超时/断：工具失败结论；回调型不重试；取消沿连接传播 |
| tool-gateway ↔ worker | worker 注册心跳 + 任务租约 | 注册 10s / TTL 30s；租约 30s / 续 10s | worker 失联：任务失败；仅 `idempotent` 重试；无 worker → 503 |
| 所有 app ↔ PG | 连接池 keepalive + readiness `SELECT 1` | 探活 2s；语句超时按查询设 | 池自动重连/退避；readiness 503 摘流 |
| 所有 app ↔ Redis | ioredis 自动重连 + readiness `PING` | 探活 2s；重连指数退避 | 准入 fail-open；停止广播/续传降级；租约失效 |
| server / worker ↔ S3 | 连接 / 总超时 + 幂等重试 | 连接 3s、总计 10s、重试 2 次 | 文件/工具返回明确失败；不拖住进程 |
| 平台 → app | k8s 探针 / Compose healthcheck / systemd | 启动 60s；liveness 10s；readiness 3s | **liveness 不探依赖**，避免依赖抖动引发全量重启 |
| app → app 发现 | k8s Service DNS，或非 k8s 的环境变量 + 内网 DNS + LB | — | 5xx/超时熔断 10–30s，半开探测；不要求 sticky |

### 6.3 每个 app 的探针

| app | liveness | readiness 探什么 | 停机 |
| --- | --- | --- | --- |
| `server` | `/healthz`（仅进程） | PG + Redis | preStop 8s；排空 ≤25s；SSE 发结束帧 |
| `agent-runtime` | `/healthz` | PG + Redis（**不探 gateway**，避免级联摘流） | 停止接新 turn；在跑 run 给宽限；租约 TTL 自愈 |
| `model-gateway` | `/healthz` | Redis + 模型配置已加载（**不探供应商**） | abort 上游流；不接新请求 |
| `tool-gateway` | `/healthz` | PG + Redis（worker 可用性按调用返回 503，不摘整个 Pod） | 停止派发；在跑任务等租约到期 |
| `tool-worker` | `/healthz` | 沙箱探测 + Redis（任务租约）+ 临时盘可写 | SIGTERM 后 3s 强杀子进程 |

> readiness 只探「本 Pod 能否工作」；下游故障用熔断/降级处理，不把全集群一起摘流。

### 6.4 看门狗

- 每 30s 扫一次：`pending` / `running` 中 `heartbeat < now-60s` 或 `started < now-600s` 的行。
- 条件 UPDATE 抢处置权 → 从时间线回填步数 / 工具数 → 写 `failed(timeout)` →
  追加 status 事件 → 通知前端灭灯。抢不到说明别的副本已处理，直接跳过。
- `pending` 必须一起扫，且用 `COALESCE(started_at, created_at)`；否则建 run 时崩溃会永久占会话。
- `suspended` 不扫：它本来就没有执行者，等用户回答。

### 6.5 超时矩阵

| 场景 | 判据 | 结果 |
| --- | --- | --- |
| 模型不吐字 | 首 token 120s | `failed` 3314（不是运行超时） |
| 一轮跑太久 | 单轮 600s | `failed` 3310（`run_timeout`） |
| 进程 / 网络没了 | 心跳 60s 未续 | `failed` 3310（`stale_heartbeat`）；多副本由看门狗处置 |
| 用户停止 | `POST /run/stop` | `canceled` |
| 客户端断开 | 连接关闭 | **不 abort**，facade 继续跑完，可重连 |
| server 副本死 | 中继连接断 | **不 abort**，facade 继续写时间线 / Redis |
| 工具超时 | 工具配置的时长上限（bash 默认 5 分钟） | 工具失败结论，整轮继续 |
| 用户未回答 | `suspended` | 不判超时；等 resume / 放弃 |

### 6.6 边界

- **心跳丢 ≠ 取消**：只有显式 stop / 墙钟超时才 abort；网络抖动不能让在跑的轮次白死。
- 首 token 计时从发起模型调用开始，收到第一段输出（文本 / 推理 / 工具入参）就撤。
- SSE 心跳 15s 必须显著小于网关空闲超时（部署 75s）；否则长思考会被网关掐断。
- 模型网关上游空闲 180s；provider 长时间不吐字由首 token 120s 兜底，不靠连接心跳。
- 租约用 Redis TTL（Redis 时钟）；心跳超时用应用/DB 时间。节点必须 NTP，跨时钟比较尽量同源。
- Redis 主从切换：客户端自动重连；锁/租约可能短暂失效，**以 DB 条件更新兜底**，不靠锁保正确性。
- DB 抖动：单次心跳写失败不中止 run（`touchHeartbeat` 吞错）；连续超过心跳阈值才由看门狗处置。
- 状态变化统一走 `RunStatusStream` 广播；前端运行灯与 DB 终态同源。

## 7. 关键流程

### 7.1 一次回合

**设计稿**（未按此实现，保留作契约目标）：

```
client → server：鉴权、建流
server → facade：POST /turns（SSE）
facade：准入 → 抢 run 租约 → 读上下文/技能/记忆 → 模型 → 工具 → 写 timelines + Redis 缓冲
facade → server：best-effort 推事件；server 转发 SSE
server 挂/客户端断：facade 继续跑完；只有 stop/超时才 abort
重连：任意 server 副本按 offset 从 Redis 续读
```

**实际实现（2026-11-14）**：

```
client → main：POST /agent/chat/stream（AnyAuthGuard；生成 clientId）
main → runtime：POST /internal/agent/chat/stream（x-internal-token + 身份头 + x-main-client-id）
runtime：agent loop → 每段 publishChunk：
         ├─ Redis 广播（旧 SSE 路径 / 断线补发）
         └─ Redis pub/sub：agent:stream:client:<clientId>
main：AgentSseBridge（订阅该 clientId 频道）按序写 data: 帧，final → [DONE]
停止 / 续答：main /agent/run/stop、/agent/chat/resume 转发 runtime 内部接口
断线重连：main 代理 runtime 的 GET /internal/agent/run/stream，从 Redis 进度补发 offset
```

契约：`AgentStreamFrameSchema`（`runId` / `chunk` / `final`，`clientId` 体现在频道名）；
设计稿里的 `TurnCommand` / `TurnEvent` 尚未实现。

### 7.2 工作区一次执行

1. gateway 拿 Redis 锁 `ws:<conversationId>`。
2. worker 按清单/快照 hydrate 到临时目录（同 worker 缓存命中则跳过）。
3. 沙箱执行（只 bind 本会话临时目录，出网默认 deny）。
4. 上传变更对象，返回变更清单。
5. gateway 调 server 提交清单（配额 + CAS），释放锁。

## 8. 可观测与告警

### 8.1 三支柱 + 业务事件

- **指标**：每个 app 暴露 `/metrics`（Prometheus 文本），标签有界；基础设施看 RED/USE，
  业务看 run / token / 工具。
- **链路**：OTel，`traceparent` 贯穿 server → facade → model-gateway / tool-gateway → worker → 供应商；
  span 覆盖 `turn` / `model.call` / `tool.invoke` / `workspace.sync`。
- **日志**：pino JSON，统一字段 `service / instance / requestId / runId / toolCallId`；
  不记 prompt、工具出参、密钥（脱敏后只留摘要）。
- **业务告警**：沿用现有 `MonitorEngine`（规则 / 静默 / 恢复 / 管理页）+ `Notifier`
  （file / email / lark）；Prometheus Alertmanager 通过 webhook 把技术告警灌进同一套告警表与通道，
  不另起第二套告警系统。
- **看板**：每服务 RED/USE、AI 业务总览（活跃 run / 首 token / token / 工具成功率 / 队列）、
  依赖（PG / Redis / 供应商 / S3）、租户 Top-N 用量。

### 8.2 指标清单

| 域 | 关键指标 | 用途 |
| --- | --- | --- |
| 服务 RED | 请求量、5xx 率、P50/P95/P99 | 可用性与延迟 |
| 饱和 | active runs、队列深度 / 等待、准入拒绝、Pod CPU/内存、重启/OOMKill、HPA 到顶、PG 连接、Redis 内存、worker 并发 | 扩容与过载保护 |
| AI | 首 token、每轮 token、run 成功率、失败 stage、模型 429/5xx、降级率、缓存命中 | 成本与质量 |
| 工具 | 按 tool 的成功率 / P95、worker 在线数、沙箱失败、出网拦截、幂等重试 | 工具治理 |
| 流 | SSE 连接数、重连率、中继延迟、缓冲截断、首 token 超时 | 体验 |
| 正确性 | 看门狗处置数、租约丢失、卡 running、timeline/audit 写失败、usage 对账差异 | 数据可信 |
| 租户 | Top-N token / 工具 / 存储用量 | 配额与账单；**不把 tenant 做成指标标签** |

### 8.3 告警分级与路由

| 级别 | 触发示例 | 路由 |
| --- | --- | --- |
| critical | 5xx > 1%（5m）、DB/Redis 不可用、跨租户访问、卡 running > 90s | Lark + 邮件 + 值班 |
| error | provider 429 > 5%、无可用 worker、队列等待 P95 > 10s、内存 > 85% | Lark |
| warn | 首 token 超 SLO、重连率 > 5%、降级率 > 10%、对账差异 > 1% | 文件 / 邮件，日汇总 |

- 去重按 `(rule, subject)`；静默 5–30min；恢复通知可配；告警正文带 runbook 链接。
- 黑盒探针：外部每分钟打 `/healthz` 与一条最小 chat（可选），覆盖「集群内看着正常、公网不可用」。
- 按**症状**告警（SLO burn / 用户可见错误），不按每个 Pod 的抖动；多窗口（1h + 5m）燃烧率。
- 业务错误（run 失败、工具失败、配额）继续走 `MonitorEngine` 的规则与静默，不迁到 Alertmanager。

### 8.4 追踪与日志

- span 属性只放有界、低敏字段：`service`、`model`、`tool`、`status`、`error_code`、`tokens`；
  **不放** prompt、工具入参/出参、用户 id。
- 采样：默认 10%；错误与 >5s 的慢请求 100%；日志不在 token 级打点，只在边界与状态变化打。
- 日志里 `requestId / runId / toolCallId` 必须能串起一条完整链路；Loki 标签只用 service/level（低基数）。

### 8.5 基数与成本

- **禁止**把 `runId / userId / conversationId` 放进指标标签；这些走 trace / 日志。
- 指标保留 30 天、trace 7 天、日志 14 天；高基数维度先聚合再入库。
- 现有 `monitor_metric_samples`（PG）只保留低频业务规则；**不要**把每请求指标写 PG。

### 8.6 与现有 monitor 的关系

- 管理页、规则、静默、恢复、`Notifier` 通道全部复用；新增 `/internal/alerts/prometheus` webhook 接
  Alertmanager，写入 `monitor_alerts` 并走现有通知。
- 现有 `Telemetry` 继续做进程内业务计数；需要跨实例聚合的指标导出到 `/metrics`，不再靠 PG 轮询。

## 9. 容量与 SLO

```
峰值并发 = (DAU × 轮次/人/日 × 峰值占比 / 3600) × 单轮时长 × 突发系数
```

| DAU | 轮次/人/日 | 单轮 60s、峰值 15%、突发 1.5 | facade 副本（120/副本） |
| --- | --- | --- | --- |
| 1 万 | 10 | ~375 并发 | 4 |
| 10 万 | 10 | ~3,750 并发 | 32 |
| 100 万 | 10 | ~37,500 并发 | 313 |

单 Pod 假设（待压测校准）：server 3–5k SSE 连接；facade 100–150 并发轮次；gateway 500–1k 路流；
worker 10–30 并发命令。SLO：首 token ≤ 供应商 TTFT + 300ms；中继额外延迟 P95 ≤ 50ms；
排队 P95 ≤ 10s；可用性 99.9%。

## 10. 运行形态：本地 / 非 k8s / k8s

### 10.1 两种模式（设计目标，**未实现**）

| 模式 | 组成 | 用途 | 开关 |
| --- | --- | --- | --- |
| `embedded` | server 内含 AI runtime + PG / Redis / S3 | 本地开发、单机小部署、拆分回滚 | 设计为 `AGENT_RUNTIME=embedded` |
| `distributed` | server + facade + model-gateway + tool-gateway + tool-worker | 生产主路径 | 设计为 `AGENT_RUNTIME=distributed` |

- 共用 `packages/ai-runtime`，不是 fork；server 只决定把一轮交给进程内还是 facade。
- **现状**：没有 `AGENT_RUNTIME` 开关、也没有 `packages/ai-runtime`；实际固定 main + runtime 双进程，
  本地用 `pnpm dev:stack`，没有 embedded 回退。若要保留单进程形态，需要另做（见 0.1）。

### 10.2 本地开发（非 k8s）

- 最小：`docker compose up -d postgres redis minio` + `pnpm dev:stack`（main 9989 + runtime 9990 + gateway 9993 + worker 9994）。
- 流式对话另需 `docker compose --profile kafka up -d` + `scripts/kafka-create-topics.sh`。
- 端口：main 9989 / agent-runtime 9990 / tool-gateway 9993 / worker 9994（model-gateway 9992 未建）。
- 服务发现：`AGENT_RUNTIME_URL` / `TOOL_GATEWAY_URL` / `TOOL_WORKER_URL`；
  默认 `localhost`，Compose 内用服务名；不用 ConfigMap / Service。
- 迁移：`pnpm db:migrate` 一次；facade / gateway 不跑迁移。
- 工作区：MinIO 当 S3；临时目录本地；不需要 RWX。
- 沙箱：Linux bwrap / macOS sandbox-exec；Windows 默认禁用命令；
  本地单租户可 `AGENT_WORKSPACE_SANDBOX=false`（多租户禁止）。
- 模型：真实 key，或 Ollama / vLLM 的 OpenAI 兼容端点经 model-gateway。
- 观测：stdout 日志即可；Prometheus / Loki 可选。

### 10.3 非 k8s 部署（VM / Compose / systemd）

- 5 个进程/容器 + 共享 PG / Redis / S3；环境变量或内网 DNS 发现；多实例前面放 nginx / traefik。
- 没有 HPA / PDB / ConfigMap / NetworkPolicy：用 Compose `depends_on` + healthcheck、systemd `Restart=`、
  反向代理健康检查替代；`/healthz` / `/readyz` 仍是 HTTP，任何平台都能用。
- 迁移：一次性 job / 手工执行；应用启动不自动迁移。
- 扩容：固定副本 + LB；不要求 sticky；run 租约保证只有一个执行者。
- 告警：有 Prometheus 就接，没有先用 `/metrics` + 现有 `MonitorEngine`。
- 资源起步：facade 2C/4Gi、server 1C/2Gi、model-gateway 1C/1Gi、tool-gateway 1C/1Gi、
  worker 1C/2Gi；没有 HPA 就人工盯 active runs / 队列。

### 10.4 k8s（生产增强）

- HPA / PDB / NetworkPolicy / 探针是生产增强，不是本地前提。
- 代码不依赖 k8s API：只依赖环境变量 + HTTP 探针，保证 Compose / VM / k8s 同一套镜像。

### 10.5 服务发现与注册

**原则：静态服务不注册，动态 worker 才注册。**

| 服务 | 发现方式 | 自注册 | 健康判定 |
| --- | --- | --- | --- |
| `server` | k8s Service / Compose DNS / 环境变量 + LB | 否 | `/readyz` |
| `agent-runtime` | 同上 | 否 | `/readyz` |
| `model-gateway` | 同上 | 否 | `/readyz` |
| `tool-gateway` | 同上 | 否 | `/readyz` |
| `tool-worker` | Redis 注册表（可选再加 Service） | **是** | 心跳 + 任务租约 |

**为什么只给 worker 做注册**

- 前四个是无状态、同质的，平台 DNS + LB 就够；自注册只会多一套需要维护的一致性。
- worker 是**异构、短生命周期**的池：能力不同（bash/web/连接器）、沙箱模式不同、负载不同，
  gateway 必须知道「谁能跑这个工具、现在忙不忙、在哪个可用区」。
- Redis 已经在依赖里，注册表不用引入 Consul / Eureka。

**worker 注册表**

- 键：`ai:worker:<id>`（Hash）+ `ai:workers:alive`（ZSET，score = 最后心跳时间）。
- 字段：`endpoint`、`version`、`zone`、`executors`、`tools`、`sandboxMode`、`maxConcurrency`、
  `active`、`draining`、`startedAt`。
- 注册：启动写 Hash + ZADD；心跳 10s 更新 score / active；TTL 30s；优雅停机先置 `draining=true`，
  等在跑任务结束再删除。
- 选择：gateway 先按 score 剪掉 >30s 的；再按 `executor/tool/version/zone` 过滤；
  在候选里按 `active / maxConcurrency` 选最闲；同可用区优先；可选按 `conversationId` 哈希提高
  临时目录缓存命中（不是正确性要求）。
- 任务租约与注册分开：注册证明「worker 活着」，租约 `ai:job:<id>`（30s / 续 10s）证明
  「这次任务还有人管」。worker 死了，注册过期 + 租约过期，任务失败/按幂等重试。
- 注册表是**缓存不是真相**：worker 自己也要限并发，超了返回 busy；gateway 换一个 worker 重试。
- 安全：注册/注销要内部服务令牌；注册表只在私有 Redis，不暴露公网；gateway 只信任内网 endpoint。

**非 k8s 的发现**

- 固定副本：环境变量列多个上游 + nginx / traefik 做 LB 与主动健康检查，不需要注册中心。
- Compose：服务名 DNS + healthcheck。
- 需要动态扩缩容 / 多集群：再上 Consul 或 mesh，不在本期。

## 11. 落地计划

| 期 | 内容 | 估算 |
| --- | --- | --- |
| P0 | 契约 `@repo/contracts` + `@repo/internal-sdk` + 三个端口（TurnEngine / ModelClient / ToolInvoker），行为不变 | 3–5d |
| P1 | **容量止血**：资源 2C/4Gi + HPA、DB 池可配、单副本/单用户准入、背景 lane、Redis 缓冲字节上限、`/metrics` + 可用性/容量告警 | 5–8d |
| P2 | **工作区外部化**：S3 + 清单 + 临时目录、Redis 锁、配额/GC | 8–12d |
| P3 | **facade 拆分**：AI runtime 迁出、server 变 BFF、run 状态机/心跳/租约迁到 facade、SSE 中继、trace 贯通、Mastra 只进 facade + `check:mastra` 收紧 | 15–20d |
| P3 现状 | ✅ main/runtime 拆分已落地（9989 / 9990，pub/sub SSE）；⏳ trace 贯通、租约仍未做；`check:mastra` 已收紧到「只有 runtime 可 import」 | — |
| P4 | **模型网关**：key 池、租户配额、降级、用量对账 | 8–12d（**未开始**，无 `apps/model-gateway`） |
| P5 | **工具网关 + worker**：bash 控制面已落地；继续迁 web/file/skill/memory、插件链全量、删 runtime 本地 ToolGateway | 15–20d |
| P5 现状 | ✅ bash / web / memory / file / read-tool-result 已迁 worker（worker 直连 PG/OSS/Redis）；skill-* 留在 main；gateway 策略闭环 | — |
| P6 | 硬化：多 AZ、KEDA、混沌演练、SLO burn / 成本看板 | 5–8d |

P1+P2 是最小可上线集（3–4 周）；完整 9–13 周。P3 已按「固定双进程」落地（没有 `AGENT_RUNTIME` 开关）；
P4 的网关直连回退、P5 的 ToolGateway 双路径均未实现（P5 已一次性切到 gateway）。

### 验收

- 客户端零改动；杀任意 Pod / 换副本，不丢跨请求状态、不需要 sticky。
- 状态机：每个转移都有条件 UPDATE 覆盖；多副本并发转移只有一个赢；看门狗不误杀 suspended。
- 心跳：进程被杀 60s 内灭灯；客户端断 / server 死不影响 run 跑完；重连不重跑。
- 故障注入：杀 facade、断 gateway、worker OOM、server 滚动更新、对象存储抖动。
- 压测 300 / 1,000 并发轮次：不 OOM、不 502、排队可见；延迟达 SLO。
- 对账：工具审计条数 vs 时间线工具块；网关 usage vs `runs.usage`；跨会话工作区不可见。

## 12. 待拍板

1. **规模**：DAU、每人每天轮次、单轮平均时长（或峰值并发）。
2. **L3**：长驻 dev server / 预览 URL 是否产品必须？必须的话单独一套有状态沙箱。
3. **云环境**：托管 k8s？对象存储 + 临时盘是否就绪？沙箱能否用 gVisor / 专用节点池？
4. **租户模型**：租户 = 用户 / 组织 / 应用？配额按哪个维度计。
5. **心跳超时语义**：现在判 `failed(timeout)`（用户重试 = 新 run）；若要自动续跑，得改成
   `interrupted` + 启动恢复接管。选哪个？
6. **服务网格**：熔断 / mTLS / outlier 检测用 mesh（Istio/Linkerd）还是应用内最小实现？
   本期先应用内超时 + 熔断，mesh 可选。
7. **监控栈**：现成有 Prometheus / OTel / Loki 吗？没有的话 P1 只做 `/metrics` + 基础告警，
   trace 放 P3 之后。
