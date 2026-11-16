# AG-UI 输出协议（2026-11-17 起）

> 查证优先级：**必核** —— 协议契约 / 帧结构 / 快照口径改动时复核。
> 核对命令：
> `grep -n "AGENT_STREAM_FRAME_VERSION = 2" packages/shared/src/schema/agent-stream-frame.schema.ts`
> `grep -n "emitAgUi\|beginReplay\|buildMessageParts" apps/agent-runtime/src/modules/ai/runtime/chat.service.ts | head`
> `grep -rn "\[DONE\]" apps/main/src/agent apps/agent-runtime/src/modules/ai/runtime`（只应出现在 `?protocol=ai` 回退与注释里）

## 结论

- **单点编码在执行服务**：`chat.service` 的 `emitAgUi` 是唯一发射口；四条路径（建流 / 续跑 /
  排队无头执行 / 收尾）都走它。网关只透传，回退口才逆映射。
- **帧 v2**：`{ version: 2, runId, event, final, createdAt }`；`final = isRunFinalEvent(event)`。
  版本 1 → 2 的语义变化是「载荷从 chunk 改为事件」，新旧进程互串只会丢帧、不会错乱。
- **收尾一律 `RUN_FINISHED`**，全链路不发 `[DONE]`（官方客户端会 `JSON.parse('[DONE]')` 抛错）。
  `[DONE]` 只保留给网关 `?protocol=ai` 回退口。
- **业务扩展只走 `CUSTOM`**：名字集中在 `packages/shared/src/agui/agui.constant.ts` 的 `AGUI_CUSTOM`；
  带 id 的卡片用 `{ id?, data }` 信封，增量块不带 id。
- **水位用 rev 不用下标**：`appendEvent` 先 `INCR` 再 `RPUSH {rev,event}`，`ltrim/lpop` 裁剪不影响 rev。
- **快照 + sinceRev**：快照 parts 从 **`timelines`** 归约（`buildMessageParts`，全部已闭合内容 +
  assistant 行 messageId）；Redis 输出记录只算 `sinceRev`。20k 裁剪时只补**未闭合 part** 的增量
  （`openPartChunks`），否则已闭合内容会被发第二遍。重放 = `RUN_STARTED` → `start`（种子消息同 id，不重置）→ 快照 → 增量。
- **补发闸门**：`beginReplay` 先合（Redis 计数 + TTL 30s），产事件的一侧在**落时间线与记录之前**
  `waitForReplayGate`，补发完 `endReplay` 放开；顺序反了实时帧会插到重放中间。
- **前端恢复**：`useRunRecovery`（`chat/run-recovery.ts`）先 `snapshot()`（null 不亮灯），
  快照 parts 作 `readUIMessageStream` 种子，从 `sinceRev` 接增量；`onRun` 接回 runId、
  `active` 并入 `busy`；结束时同 id 原位替换并回 messages。不要再退回 `useChat({ resume: true })`。
- **补发批量**：`pubsub.broadcastMany` 一次 pipeline（1.5 万帧逐条约 3s，是乱序窗口；批量 ~56ms）。

## 依据 / 失效信号

- 依据：`packages/shared/src/agui/`、`runtime/run-snapshot.ts`、`main/src/agent/agent-sse.bridge.ts`；
  `docs/dev-logs/2026-11-17.md`。
- 失效信号：改回 chunk 帧 / 在网关出口编码 / 用 List 下标当水位 / 重新发 `[DONE]` /
  快照带上未闭合 part。
