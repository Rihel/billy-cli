# Kafka 承载 AI 会话输出（runtime → main SSE）

> 查证优先级：抽核 —— 路由 / topic 名改过再核。
> 整体拆分边界与已知缺口见 [main-runtime-split](main-runtime-split.md)。

## 链路（2026-11-14）

- main `POST /agent/chat/stream` 生成 `clientId`，调 runtime `POST /internal/agent/chat/stream`
  （转发 authorization/cookie，带 `x-main-client-id`）。
- runtime `AgentChatService.chatStream` 调 `AgentStreamStore.bindClient(runId, clientId, ...)`；
  `publishChunk` **按传输分流**：装了 Kafka 只发 `agent.run.events`（不再广播 Redis），
  未装 Kafka（直连模式）才走 Redis 频道 `agent:stream:<runId>:chunk`。
- topic 实际名 `app.agent.run.events`（前缀 `KAFKA_TOPIC_PREFIX`），3 分区，key=runId。
- main `AgentSseBridge` 用 `@KafkaConsumer('agent.run.events','main-sse')` 消费，
  按 `clientId` 写 SSE `data:`；`final` 写 `[DONE]`。
- 事件结构：`@repo/shared` 的 `AgentRunEventSchema`。

## 注意

- Kafka 未配置时 runtime 不发事件（`KafkaService` 可选），main 的 SSE 会空等；本地必须起
  `docker compose --profile kafka up -d` 并建 topic。
- 建 topic：`scripts/kafka-create-topics.sh`。
- Kafka 发布失败只记 `ai.kafka.publish_failed`，不阻断模型流。
- 断线重连：补发用 `forwardChunk`（只发 Kafka），Kafka 模式补发完即结束、**不再订阅 Redis**；
  直连模式才订阅频道。**坑**：订阅回调里再 `publishChunk` 会自己发自己收，一次重连每秒上万条
  并全量转发 Kafka，把 kafkajs 请求队列堆到 GB 级打 OOM（2026-11-15 实测）。
- 多副本前提：`kafkaMeta` 是进程内 Map，重连请求与生产 run 不在同一副本时实时片段会发给旧
  `clientId`；要支持多副本需把这份绑定外置到 Redis。
- 启动预热：`AgentStreamStore.onApplicationBootstrap` 调
  `KafkaService.warmup(['agent.run.events'])`（不 await，失败只记日志并进冷却）。

## 依据 / 失效信号

- 依据：`apps/agent-runtime/src/modules/ai/runtime/stream-store.service.ts` 的
  `publishChunk` / `forwardChunk`、`chat.service.ts` 的 `resumeRun`。
- 失效信号：传输再改（如补发改走 Redis Stream）、`kafkaMeta` 外置、或 main 改回直连转发。
