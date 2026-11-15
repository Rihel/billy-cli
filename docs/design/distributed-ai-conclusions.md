# AI 分布式架构：讨论结论（2026-11-14）

> 一页结论，详细论证见 [distributed-ai-architecture.md](distributed-ai-architecture.md)。
> 状态标记：**已定** = 本轮明确；**建议** = 我给出方案待你确认；**待拍板** = 需要你选。
> **2026-11-14 更新**：P3 拆分与 P5 工具网关已落地；文档里的 `server` = `apps/main`，
> `facade` = `apps/agent-runtime`。实际链路与设计稿的差异见「0. 落地现状」。

## 0. 落地现状（2026-11-14）

| 结论 / 设计项 | 实际 |
| --- | --- |
| 五服务 | 已落地 4 个：`apps/main`（9989，公网 BFF）/ `apps/agent-runtime`（9990，只跑 agent loop）/ `apps/tool-gateway`（9993）/ `apps/tool-worker`（9994）；**model-gateway 未建** |
| model-gateway | **未建**；细化设计（接口 / 流 / 产物 / 计量 / key 池）见 [model-gateway.md](model-gateway.md)（评审稿） |
| 客户端契约 | 前端只连 main；`/agent/*` 路径不变。**非流式 `POST /agent/chat` 没有服务端路由**（SDK 方法还在），调用 404 |
| runtime → main 输出 | **Redis pub/sub 定向频道** `agent:stream:client:<clientId>`：runtime 每段 chunk 发频道，持有该连接的 main 实例 `AgentSseBridge` 按序写 SSE，final → `[DONE]`。`clientId` 绑定存 Redis 进度 Hash（跨副本可读）。2026-11-15 起从 Kafka `app.agent.run.events` 回退：实测 1.5M 条 / 686MB，而 Kafka 的回放能力从未被使用（补发走 Redis 输出记录） |
| 停止 / 续答 / 重连 | 已补：main `/agent/run/stop`、`/agent/chat/resume`、`GET /agent/run/stream`、`GET /agent/run/:runId/stream` 全部转发 runtime 内部接口；重连从 runtime 的 Redis 输出记录按 offset 补发（**不经 broker**） |
| file 接口 | 在 **main**（`/agent/file/*` 的清单 / 预览 / 后台列表 / workspace-content）；runtime 只有文件工具执行侧 |
| 配置变更事件 | `ai.skill.changed` 走 Redis EventBus（at-most-once + 启动全量 sync 兜底）；`ai.connector.sync` 走 Redis + Kafka 双发（消费方按 `connectorId + requestedAt` 幂等） |
| 运行形态 | 固定 main + runtime 双进程；`AGENT_RUNTIME=embedded` / `packages/ai-runtime` **未实现** |

## 1. 已定（用户明确）

1. **五个无状态服务**（目标）：`server`（现 `main`）/ `agent-runtime` / `model-gateway` / `tool-gateway` / `tool-worker`；
   不依赖 sticky，本地盘只做可丢弃缓存，真相在 PG / Redis / S3。当前 4 个，model-gateway 未建。
2. **执行边界**：所有**能力工具**在 `tool-worker` 执行；`tool-gateway` 只做策略/路由/审计；
   `server` 的 `ToolGateway` 与插件链最终删除。
3. **内部调用统一 SDK**：所有 app 间 HTTP 调用走 `@repo/internal-sdk` 的 typed client；
   业务代码不直接 fetch 内部地址。
4. **Redis 访问统一入口**：app 层禁止 `redis.raw`，缺能力就加 `RedisStore` 方法；
   `pnpm check:redis-raw` 已接进 `verify`。

## 1.5 方案建议（待确认）

- **运行形态**：一套代码两种模式，`embedded`（本地/单机）与 `distributed`（5 app），不依赖 k8s。
  **未实现**，实际固定双进程。
- **Mastra 只在 agent-runtime**：网关 / worker / main 禁止 import `@mastra/*`（已由 `check:mastra` 守住）。
- **插件机制**：gateway 上静态编译的策略管道（enabled → scope → rate-limit → validate →
  precheck → audit → redact → paginate），代码定义，DB 只存开关/阈值。
- **数据与流**：`timelines` 归 facade 写；工作区 S3 真相 + 临时目录；model-gateway 只做原生透传。
- **服务发现**：4 个无状态服务靠平台 DNS / 环境变量 + LB；只有 `tool-worker` 自注册。
- **可观测**：Prometheus + OTel + pino/Loki；技术告警走 Alertmanager，业务告警留在 `MonitorEngine`。

## 2. 工具边界（建议）

| 执行方 | 内容 | 说明 |
| --- | --- | --- |
| `tool-worker` | bash / web / memory-* / file-* / read-tool-result 已迁；skill-* 属 main 控制面 | worker 直连 PG/Redis/S3（受限 DB 角色 `TOOL_WORKER_DB_URL`）；worker→server 数据 API 已删 |
| `agent-runtime` | planner / subagent / ask-user-questions | **编排原语，不算工具**；需要 run 状态与客户端交互 |
| `tool-gateway` | 目录、策略、凭据、路由、审计、分页句柄 | **不执行工具**；目录/配置/策略已闭环 |
| `main` | 配置 CRUD、file HTTP、skill 控制面、会话/文件/用量、SSE 中继 | 控制面与数据面的唯一写方 |

- file / memory 的执行在 worker，worker 直连 PG/OSS/Redis；skill 的写库在 main（`ai-admin/skill`），
  runtime 收到 `ai.skill.changed` 后落盘 / 刷新 loader。
- 如果坚持“所有工具字面意义上都在 worker”，`ask-user-questions` 必须从模型工具面移除，
  改成 facade 内部步骤；不推荐，会改变模型行为。

## 3. 连接器（建议 / 待定）

- **元数据 / 动态工具清单 / 策略 / 凭据 / 审计在 gateway**；**执行不在 gateway**。
- 执行放 **connector worker 池**：同一个 `apps/tool-worker` 镜像，
  `TOOL_WORKER_ROLE=connector`，独立 Deployment / 出网策略；注册 `connector:sql|redis|lark-cli`。
- main 仍是 `ai_connectors` / `auth_state` 的写方；连接器变更经 `ai.connector.sync`（Redis + Kafka）通知 runtime；gateway 按需取一次性凭据，worker 不落盘。
- lark 刷新 token：worker 返回新 state → gateway → main 回写；同一 connector 用 Redis 锁串行化。
- 第三方扩展优先 MCP / 独立集成服务；gateway 只注册元数据，执行由 worker 的 MCP 客户端做。
- **待拍板**：连接器是否保留？SQL/Redis 是否只做只读代理？哪些连接器是真实租户在用？

## 4. planner / ask / memory（建议）

- **planner**：facade-native，状态放 Redis + timeline 兜底；根会话有，子会话没有。
- **ask-user-questions**：facade-native；只有根会话能问；子会话把问题作为工具结论交回父。
- **memory**：
  - 短期 thread：facade + Redis，按会话隔离；子会话有自己的 thread 或不挂 memory。
  - 长期记忆：用户级；子会话可读，**写只允许根会话**；抽取只在根会话轮后跑。
  - memory 读写已由 worker 直连 DB（受限角色 `TOOL_WORKER_DB_URL`）；注入 / 抽取仍在 agent-runtime。

## 5. 子 agent = 子会话（已实施第一版）

- `conversations` 已加 `parent_conversation_id` / `root_conversation_id` / `kind` / `depth` /
  `origin_run_id` / `origin_tool_call_id`；`runs` 保留 `parent_run_id` / `tool_call_id`。
- **工作区共享**：信封带 `workspaceConversationId`，bash / file 工具按根会话路径工作；子会话不另起文件。
- **执行内联**：同一个 facade 内跑子 run，不另发 HTTP；保留低延迟与幂等。
- **用量**：rollup 仍只统计 `parent_run_id IS NULL`；父 run 的 `usage.subAgents` 汇总子 run。
- **列表 / 删除**：会话列表只出根会话；删父会话级联软删子会话，工作区只清理一次。
- **工具返回值**：`run-sub-agent` 的结论新增 `conversationId`，前端可据此打开子会话。
- **未做**：子会话单独 resume / 分享、子会话自己的 memory thread 与抽取、UI 打开入口、历史子 run 回填。

## 6. 迁移顺序

1. `@repo/contracts` + `@repo/internal-sdk` —— 已落地
2. `RedisStore` 方法 + `check:redis-raw` —— 已落地
3. `tool-worker` bash + 注册心跳 + `tool-gateway` 路由 —— 已落地
   - 追加：`/v1/tools/list` 目录、scope/validate/rate-limit、`ai_tool_audit`、runtime 命中远程 allowlist 时跳过本地插件链
4. `web` 工具迁 worker
5. `file / skill / memory` 的执行迁 worker（✅ 已完成，worker 直连 PG/OSS；skill 控制面留 main）
6. 插件链 / 工具配置 / 审计迁 gateway（✅ 策略已闭环）；runtime 的本地 `ToolGateway` 仍在（承载未迁 worker 的工具与编排原语），尚未删
7. 连接器（若保留）：gateway 控制面 + connector worker
8. 子会话（第一版已落地；UI / resume / 回填待做）
9. facade 拆分（✅ main / runtime 已拆，pub/sub SSE）/ 可观测 / 多租户配额 / 硬化（进行中）

## 7. 待拍板清单

1. 规模：DAU、每人每天轮次、单轮时长（或峰值并发）。
2. 连接器：保留哪些？SQL/Redis 是否只读？是否改 MCP？
3. `planner` / `ask` 是否接受“编排原语、不算 worker 工具”？
4. memory 长期写入是否只允许根会话？
5. 子会话：是否开放单独 resume / 分享？历史子 run 是否回填？
6. tool-gateway 插件链切换：一次切完还是按工具灰度？
