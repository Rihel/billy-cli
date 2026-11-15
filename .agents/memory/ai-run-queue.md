# 异步子 agent 的会话 run 队列

- **查证**：抽核（队列表 / 调度器 / wake 改动后重核）
- **依据**：`packages/db/src/entities/conversation-run-queue-entity.ts`、`apps/agent-runtime/src/modules/ai/runtime/run-queue.service.ts`、`apps/agent-runtime/src/modules/ai/runtime/run-queue.dispatcher.ts`、`apps/agent-runtime/src/modules/ai/runtime/chat.service.ts`、`docs/design/async-subagent.md`

结论（2026-11-15 方案定稿，链路已跑通）：

- 子 agent 的身份 = **子会话**：`subAgentId = conversationId`，一次执行 = `subRunId`；
- 父会话用新表 `conversation_run_queue` 串行 root run：
  `source=user`（priority 0）优先于 `source=subagent`（priority 1），同优先级 FIFO；
- 子 agent 完成入队，`dedupe_key = subRunId`；`wait-sub-agent` 消费队列项后不再唤醒；
- 唤醒 run 是 `parent_run_id IS NULL` 的 root run，`runs.origin='subagent'`；时间线先写
  `status=subagent_completed` 系统卡，给模型的收尾消息是**内部系统通知**；
  **角色是 `user` 不是 `system`**（2026-11-15 修正：system 收尾时模型找不到触发源，会回退到会话开头
  那条 user 消息，把「子助手完成」误判成「用户重复提问」，实测一次会话连判 4 次、多烧约 220 万 token）；
  「不是用户说的」由文案首尾标注承担（`［内部系统通知 · 不是用户的新消息］`）；
- **每完成一个子助手就唤醒一次**（不做批次聚合，2026-11-15 定）：父模型拿第一个结果就能推进；
  唤醒通知带同批进度 `{ total, completed, pending[] }`，并明确「还有谁在跑 / 全齐了才做最终汇总」；
  提示词 `assistant.eta` 的「编排子助手」段承载使用口径；
- **list/wait 的作用域是会话**（`listSessionChildren` 按子会话反查），不是父 run：第二轮与唤醒 run
  都能看到此前派出的子；`batchRunId` 标批次。list 只回状态 + 元数据，wait 不传 id = 本会话未完成子；
- **子助手结论落工作区** `subagents/<名字>-<subRunId>.md`（`runtime/subagent-result.ts` 约定路径）；
  `wait` / `list` 只回 `path + 行数 + 字节数`（不返回摘要），正文用 `read-file` 读 —— 不再整段进父上下文；
- **完成卡由消费者写**：dispatcher 消费 queue 项时写；`wait-sub-agent` 抢先消费时由工具补写
  （`consumeByDedupe` 返回是否命中，天然去重）。wait 不带 `sub_agent_ids` = 等全部子助手（含已完成），
  返回完整结论；曾只收未完成的 → 全跑完返回空数组（2026-11-15 实测白等 88 秒）；
- 子 agent 可以使用 planner，**父子 plan 按会话独立**（`envelope.conversationId`，2026-11-15 修正；
  曾用 `parentRunId` 作键，父子撞同一份内存清单，四个子助手互相覆盖任务 id）；
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
