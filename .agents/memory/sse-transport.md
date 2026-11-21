# SSE 输出传输（runtime → main）

> 查证优先级：抽核 —— 频道名 / 绑定字段 / 传输选型 / 帧率口径改过再核。

## 结论（2026-11-17 起 AG-UI 载荷；2026-11-22 起帧合并 + 出口心跳）

- **频道按连接定向**：`agent:stream:client:<clientId>`（`@repo/shared` 的 `agentStreamChannel`）。
  runtime 发、持有那条 SSE 连接的 main 实例收，其它副本零流量。
- **绑定在 Redis**：`clientId` 写进进度 Hash `agent:run:<runId>` 的 `clientId` 字段（TTL 6h），
  `publishEvent` **每条现读**、不做进程内缓存 —— 重连落到别的副本也能把实时事件发给新连接。
- **载荷是 AG-UI 事件**（帧 v2 `{version:2, runId, event, final}`）；协议与快照口径见
  [agui-protocol](agui-protocol.md)。
- **帧率已合并**：`text-delta` / `reasoning-delta` / `data-sub-agent-delta` 在
  `runtime/stream-deltas.ts` 攒 100ms（或 2k 字）发一帧，其它块先 flush 再立即发。
  一帧 = 一次 `appendEvents`（`INCRBY n` + `RPUSH 多值`）→ 一次 `publishEvents`（pipeline）。
  合并前是每 token 约 10 次 Redis 往返（2×闸门 `EXISTS` + 6×append + `HGET` + `PUBLISH`），
  **别把闸门加回增量路径**（增量不落时间线，不需要）。
- **心跳两段**：runtime 响应体（执行服务 → 网关）15s 注释帧；main 的 `AgentSseBridge`
  **空闲** 15s（网关 → 浏览器，`deferred` 阶段不发、`detach`/`fail` 清表）。
  `/sse/subscribe` 那条由 `StreamConnection` 负责，别混。
- **补发**：`agent:stream:<runId>` List 存 `{rev,event}`，内存进度记 `rev`（`INCR`），
  重连按 `sinceRev` 读；已闭合内容给快照，不再整轮重放。
- **停止信号**：`agent:stream:<runId>:stop` 也走 pub/sub，订阅方在 runtime（`subscribeStop`）。
- **连接数**：每进程就 2 条（`PubSub` 的 pub + sub，所有频道复用）。不要再走
  `RedisStore.subscribe`（每次调用 `raw.duplicate()`，一条流一条连接）。
- **Kafka**：连接器模块删除（2026-11-18）后没有业务 topic 依赖；AI 流式对话与它无关。

## 事故与实测（2026-11-15）

- 旧实现走 Kafka `app.agent.run.events`（3 分区，key=runId）：18 小时写出
  **1,536,196 条 / 686MB**（topic 段文件实测），可读 71,860 条里信封占 233B/条（59%）。
- **自激回环**：断线重连既 `publish` 到频道、又订阅同一条频道，回调里再转发 → 每秒上万条、
  kafkajs 请求队列堆到 GB 级 → runtime 4GB 堆 OOM。现在重连**只发不订阅**。
- 跨副本丢帧：旧 `kafkaMeta` 是进程内 Map，重连换副本后实时帧仍发给旧 clientId（已由 Redis 绑定修掉）。
- 消费组泄漏：旧组名 `main-sse-${HOSTNAME ?? pid}` 在 macOS 上退化成 pid，12 小时泄漏 13 个组。

## 核对

```bash
grep -n "STREAM_DELTA_FLUSH_MS\|STREAM_DELTA_MAX_CHARS" apps/agent-runtime/src/modules/ai/runtime/chat.service.ts
grep -n "SSE_HEARTBEAT_MS\|HEARTBEAT_FRAME\|clearHeartbeat" apps/main/src/agent/agent-sse.bridge.ts
grep -n "appendEvents\|rpushMany" apps/agent-runtime/src/modules/ai/runtime/stream-store.service.ts
grep -n "subscribeAsync" apps/main/src/agent/agent-sse.bridge.ts packages/kits/src/pubsub/pubsub.ts
```

## 依据 / 失效信号

- 依据：`stream-store.service.ts`、`agent-sse.bridge.ts`、`pubsub.ts` 的 `subscribeAsync`；
  `docs/design/ai-agent.md` 第 0 节与第 7 节。
- 失效信号：改回 Kafka / 内部 SSE 中继、频道改按 runId、绑定挪回进程内、`RedisStore.subscribe`
  重新用于 SSE、增量退回逐 token 发射、心跳改回只在一段写。
