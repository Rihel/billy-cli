# AI 运行时：会话 / 运行 / 时间线 / 流式 / 恢复

> 本文件是 `develop-ai-agent` skill 的组成部分。权威设计见 `docs/design/ai-agent.md` §3–§5。

## 1. 三张表与三种状态

| 表 | 一行是什么 | 关键列 | 可删？ |
| --- | --- | --- | --- |
| `conversations` | 一个对话窗口 | `user_id` / `agent_key` / `turn_count` / `total_tokens` / `last_active_at` | **只能软删**（`deleted_at`） |
| `runs` | 一次执行（根 = 一轮问答；子 = 子 agent） | `parent_run_id` / `depth` / `tool_call_id` / `status` / `usage` / `error_*` / `heartbeat_at` | **永不删** |
| `timelines` | 会话里发生的一件事（一行一个 part） | `seq`（排序权威）/ `run_id` / `message_id` / `kind` / `tool_call_id` / `payload`（全量） | **永不删** |

- **根 run 与子 run 同表**：`parent_run_id IS NULL` 才是"一轮"；
- 并发保护靠部分唯一索引 `uk_run_active_conversation (conversation_id) WHERE parent_run_id IS NULL AND status IN ('pending','running')`
  → 同一会话同时只允许一次进行中的**根**运行（子 run 与父 run 同时跑是正常状态）；
- 幂等键 `uk_run_tool_call (parent_run_id, tool_call_id)`。

**进度放 Redis、结果放 Postgres**：运行中的 step / 当前动作 / offset / 心跳在 Redis（`agent:run:{runId}`，TTL 6h），
跑完删；终态、消耗、统计落 `runs`（长期保留）。看门狗按 `heartbeat_at` 与总时长判超时
（`markTimeout` 的判据必须与 `findStale` **完全一致**，否则会出现"心跳还在跳但超时"处置不掉的 bug）。

## 2. 上下文策略（按模型窗口比例，不拍脑袋）

`AgentConfig` 的四个比例：触发 0.7 → 裁剪到 0.5 → 压缩到 0.4，最近 3 轮永不裁，
单条工具结果给模型的视图上限 0.1（**落库仍是完整原文**）。窗口来自 `tokenlens`，查不到用兜底值。

**组装上下文只看根 run 的事件**（`listSince(..., { rootOnly: true })`）：子 agent 的内部过程是审计资料，
回灌给主模型既费窗口又污染上下文。压缩产物是 `kind='summary'` 的事件（原文保留，摘要只是"给模型的新起点"）。

## 3. SSE 流式协议（AI SDK v6 UI Message Stream）

- 端点：`POST /agent/chat/stream`（建流，**不套业务信封**）、`GET /agent/run/:runId/stream?offset=N`
  （知道 runId 时续流）、`GET /agent/run/stream?offset=N`（**不知道 runId 时续流**：服务端按登录用户找
  当前进行中的那一轮，没有回 204）、`POST /agent/run/stop`（停止）；两条续流都必须是 GET —— AI SDK 的
  `reconnectToStream` 固定发 GET，指到 POST-only 的建流地址会 **404**（踩过）；
- 帧格式 `data: {json}\n\n`，结束 `data: [DONE]\n\n`；响应头有 `x-vercel-ai-ui-message-stream: v1`、
  `x-accel-buffering: no`；心跳是 SSE 注释帧 `: ping\n\n`（自写，15s）；
- **`[DONE]` 在收尾落库之后才发** —— 客户端见到它就代表终态已写库；
- 每个片段同时落三处：时间线（真相）/ Redis 输出记录（补发）/ pub/sub（跨副本）；
- **`data-*` 块**（前端渲染的细节都在这）：`data-run`（本轮身份，**第一个块**，不带 id）/
  `data-sub-agent`（子助手状态快照，**带 id = 子 run id，同 id 覆盖**）/
  `data-sub-agent-delta`（子助手增量，**不带 id，一块一个**）。
  ⚠️ AI SDK 的 data part 按 id 归并 —— 增量绝不能用固定 id，否则只会剩最后一块。

## 4. 停止与重连（两处官方语义坑）

1. **`useChat().stop()` 只断本地连接，不取消服务端生成** → 停止必须再调 `POST /agent/run/stop`
   （服务端本进程直接 abort；不在本进程则经 Redis 停止频道广播给持有者）；
2. **重连靠 `useChat({ resume: true })`**，不要在 `useEffect` 里手调 `resumeStream()`（StrictMode 下会重复）；
   前端用 `prepareReconnectToStreamRequest` 把 runId 换成我们的续流地址。

## 5. 崩溃恢复（三档，代价要说清）

- 开启 `AGENT_DURABLE_ENABLED`（默认 true）后 agent 逐步落快照到**我们的表**（`AgentMastraStore`，
  只实现 workflows 域 9 个方法）；boot 时取 Redis 租约 → `recoverAllDurableAgents()`；
- **恢复会重发模型调用、重跑工具**（官方语义，钱会重复花一次）：`recovery_count` 上限 1，
  工具靠 `tool_call_id` upsert 去重；子 agent 不做 durable（父重跑 spawn 工具 → 命中幂等复用）；
- 恢复不了就标 `interrupted`（前端提示可重试），不要假装成功。
