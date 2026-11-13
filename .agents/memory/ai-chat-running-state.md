# AI 会话「运行中」列表状态：事件驱动 + 重连对账（不再轮询）

**查证优先级：抽核**（`runtime/run.repository.ts`、`modules/stream/`、`chat/layout.tsx` 有改动时复核）
核对命令：`grep -n "STREAM_CONVERSATION_RUN_CHANGED_EVENT" "apps/admin/src/app/(app)/(standalone)/main/ai/chat/layout.tsx"`、
`grep -n "notifyStatus" apps/server/src/modules/ai/runtime/run.repository.ts`、
`grep -n "refetchInterval" "apps/admin/src/app/(app)/(standalone)/main/ai/chat/layout.tsx"`（应无输出）

## 结论

- 侧栏「运行中」呼吸灯**不再轮询**：服务端在根 run 活跃状态变化时推 `conversation.run.changed`
  （频道 `ai:owner:{ownerId}`，服务端按登录身份派生订阅，客户端不传频道）；前端 `useStream`
  收到后只覆盖缓存里的 `running` 字段，`running=false` 时补一次列表失效（刷标题 / 轮数 / 排序）。
- 发布收口在 `RunRepository`：`create` / `markRunning` / `suspend` / `finish` / `cancelActive` /
  `markTimeout` / `interruptActiveBefore` 各调一次 `notifyStatus`；子 run 跳过。
  `running` 由 `ConversationRepository.isRunning` **发布时现算**，不从状态机推断。
- **对话详情仍有 2s 轮询**（`chat-conversation.tsx` 的 `activeRunQuery`）：那是断流后续流的兜底，
  与列表运行态不是一件事，别顺手删。
- `running` 只认根 run 的 `pending` / `running`：**挂起（suspended）会灭灯**，与部分唯一索引口径不同。

## 为什么保留一次"对账"

推流 at-most-once 且服务端**不回放** `Last-Event-ID`；`HttpStreamClient` 默认 `openWhenHidden: false`，
切标签页就断。所以 `layout.tsx` 在每次重新 `open` 时补拉一次列表（首次 open 跳过）——
这是"连上先对齐真相"，不是轮询。别改成"只靠事件"。

## 依据

- `packages/shared/src/schema/stream.schema.ts`：`STREAM_AI_OWNER_CHANNEL_PREFIX` /
  `STREAM_CONVERSATION_RUN_CHANGED_EVENT` / `ConversationRunChangedEventSchema`
- `modules/stream/stream.controller.ts` 的 `resolveSubscriptions`（第 4 类：派生频道）、
  `stream.module.ts` 的 `derivedChannels`
- `runtime/run-status.stream.ts`（`RunStatusStream` + `RUN_STATUS_LISTENER` token）
- `docs/dev-logs/2026-11-13.md`

## 失效信号

改成推送运行态增量（带 seq / 快照语义），或频道改成 `conversation:{id}`（那就要补归属权校验，
`allowChannel` 签名当前拿不到身份）。
