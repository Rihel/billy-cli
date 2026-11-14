# Kafka 承载 AI 会话输出（runtime → main SSE）

> 查证优先级：抽核 —— 路由 / topic 名改过再核。
> 整体拆分边界与已知缺口见 [main-runtime-split](main-runtime-split.md)。

## 链路（2026-11-14）

- main `POST /agent/chat/stream` 生成 `clientId`，调 runtime `POST /internal/agent/chat/stream`
  （转发 authorization/cookie，带 `x-main-client-id`）。
- runtime `AgentChatService.chatStream` 调 `AgentStreamStore.bindClient(runId, clientId, ...)`；
  每个 `publishChunk` 在保留 Redis 广播的同时发 Kafka `agent.run.events`。
- topic 实际名 `app.agent.run.events`（前缀 `KAFKA_TOPIC_PREFIX`），3 分区，key=runId。
- main `AgentSseBridge` 用 `@KafkaConsumer('agent.run.events','main-sse')` 消费，
  按 `clientId` 写 SSE `data:`；`final` 写 `[DONE]`。
- 事件结构：`@repo/shared` 的 `AgentRunEventSchema`。

## 注意

- Kafka 未配置时 runtime 不发事件（`KafkaService` 可选），main 的 SSE 会空等；本地必须起
  `docker compose --profile kafka up -d` 并建 topic。
- 建 topic：`scripts/kafka-create-topics.sh`。
- Kafka 发布失败只记 `ai.kafka.publish_failed`，不阻断模型流。
- 断线重连仍走 runtime 旧 Redis/SSE 接口，尚未改成 Kafka 回放。
