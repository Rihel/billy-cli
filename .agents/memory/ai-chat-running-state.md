# AI 会话「续流 / 运行中」状态：作用域必须带 conversationId

**查证优先级：抽核**（`modules/ai/runtime/` 或 `main/ai/chat/` 有改动时复核）
核对命令：`grep -n "findActiveByConversation" apps/server/src/modules/ai/runtime/run.repository.ts`、
`grep -n "startInvalidated" "apps/admin/src/app/(standalone)/main/ai/chat/chat-conversation.tsx"`

## 结论

- 续流 `GET /agent/run/stream` 必须带 `conversationId`。不带则服务端只按登录用户跨会话找最近一条
  活动 run（`findActiveByUser`）—— 任意会话页挂载都会接上**别的会话**正在跑的流（串流）。
  新会话页还没有真实 id，传占位段 `new`：永不匹配任何 run → 204。
- 侧栏「运行中」呼吸灯依赖**条件轮询**（`layout.tsx` 的 `refetchInterval`：缓存里已有 `item.running`
  才每 5s 拉一次），开跑时不会自启。所以会话页必须在 `status` 变 `streaming` 时手动失效一次
  `['ai','conversations']`；用 `submitted` 会抢跑（run 行还没建，查到 `running=false`）。
  熄灭由 `streaming → idle` 的对账失效负责，不用另写。

## 依据

- `run.repository.ts`：`findActiveByConversation(userId, conversationId)`（按会话）、
  `findActiveByUser(userId)`（旧口径，仅兼容不带会话的调用）
- `chat.service.ts` 的 `resumeCurrentRun(..., conversationId?)`、`ai.controller.ts` 的 `run/stream`
- `sdk/server.client.ts` 的 `currentRunStreamUrl(offset, conversationId?)`
- `chat-conversation.tsx` 的 `prepareReconnectToStreamRequest` 与 `startInvalidated` effect
- `docs/dev-logs/2026-11-12.md`

## 失效信号

续流改成「始终带 runId」的单一端点，或列表状态改为推送 / 常驻轮询后复核。
