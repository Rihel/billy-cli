# 异步子 agent 的会话 run 队列

- **查证**：抽核（队列表 / 调度器 / wake 改动后重核）
- **依据**：`packages/db/src/entities/conversation-run-queue-entity.ts`、`apps/agent-runtime/src/modules/ai/runtime/run-queue.service.ts`、`apps/agent-runtime/src/modules/ai/runtime/run-queue.dispatcher.ts`、`apps/agent-runtime/src/modules/ai/runtime/chat.service.ts`、`docs/design/async-subagent.md`

结论（2026-11-15 方案定稿，链路已跑通）：

- 子 agent 的身份 = **子会话**：`subAgentId = conversationId`，一次执行 = `subRunId`；
- 父会话用新表 `conversation_run_queue` 串行 root run：
  `source=user`（priority 0）优先于 `source=subagent`（priority 1），同优先级 FIFO；
- 子 agent 完成入队，`dedupe_key = subRunId`；`wait-sub-agent` 消费队列项后不再唤醒；
- 唤醒 run 是 `parent_run_id IS NULL` 的 root run，`runs.origin='subagent'`；时间线先写
  `status=subagent_completed` 系统卡，给模型的收尾消息是 **system 内部通知**（不冒充用户）；
- 子 agent 可以使用 planner，父子 plan 按 run 独立；
- 队列项 done/canceled 保留 7 天后可清理（`runs`/`timelines` 仍不删）。

已落地（2026-11-15）：表 / `runs.origin` 迁移、`ConversationRunQueue`、`ConversationRunQueueDispatcher`
（1s 轮询 + Redis 锁 + 条件 UPDATE 的原子 claim；用户优先；同会话串行；对账卡死项）、
`chatStream` 忙时入队（回 `data-queue`，不再 3306）、`ChatService.startQueuedTurn` 无头执行、
`conversation.run.started`（前端自动续流）、`origin=subagent` 系统卡与前端最小卡片、
stop / 父失败 / 删会话 / 看门狗的级联取消；Kafka 模式下排队应答走 `AgentStreamStore.publishControl`
（先 chunk 再单独 final，main 的桥只认后者写 `[DONE]`）。

已知未做：非流式 `chat()` 忙时仍 3306（只改了 `chatStream`）；队列 done/canceled 的 7 天清理任务；
队列深度 / 等待时长指标；`run-queue-dispatcher.test.ts` 已覆盖 dispatcher / 优先级 / dedupe / 排队 / 级联。

核对命令：`rg -n "origin|startQueuedTurn|run.started" apps/agent-runtime/src packages/db/src`；
`pnpm --filter @app/agent-runtime exec vitest run test/run-queue-dispatcher.test.ts test/run-queue.test.ts`。

失效信号：调度器改为多表 / 事件队列、队列优先级规则变化、`runs.origin` 被别的语义复用。
