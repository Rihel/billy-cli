# 子助手卡的状态：库里子 run 才是终态权威

> **查证优先级：必核** —— 取数来源 / 合并优先级类结论；改 `history.ts`、`chat-session.ts`、`sub-agent-live.ts` 后重核。

## 结论（2026-11-15）

主时间线的子助手卡（`SubAgentCard`）状态**不能**只看实时块或历史 part，两者都会停在"起跑那一刻"：

| 来源 | 为什么不可靠 |
| --- | --- |
| 实时 `data-sub-agent` | 只有父这一轮的流开着才收得到；父先结束、或子助手完成触发**唤醒轮**时 `beginRun` 会清空实时数据 |
| 历史 part（`run-sub-agent` 出参） | 出参是**起跑快照**：`status: 'running'`、`stepCount: 0`、`toolCallCount: 0`、`durationMs: 0` |

正确口径：**`runs` 表里的子 run 行是终态权威**（`run/list` 带 status / stepCount / toolCallCount / usage / durationMs）。

- `history.ts`：`toUIMessages` 里用终态子 run 覆盖 `data-sub-agent` part（`applyChildRunStates`）；
- `chat-session.ts`：`ChatSessionStore.runStates`（`applyRunStates` 由 `session-tabs` 用 `run/list` 喂入）。
  **不进 `live`** —— `live` 会被新一轮 `beginRun` 清掉，会退回起跑快照；
- 视图 = 「历史 part ← 实时块 ← 库内终态」（`withRunState`）：非终态只补 `conversationId`，
  **不动计数**（库里的 stepCount 收尾才落，覆盖会让实时 3 步倒退成 0）；
- `subAgentTabs` 的 `active` 有 run 就以 `run.status` 为准（`pending` / `running` / `suspended`）；
  原先 `|| isSubAgentActive(live)` 会让已完成的 tab 一直转圈；
- **运行中的计数**：`stepCount` / `toolCallCount` 只在收尾落库，运行中都是 0。卡片运行中显示
  「已调用 N 次工具」（`liveToolCallCount` 数实时事件里的 `tool-call`，`tool-result` 不重复数），
  **不显示步数**（显示 0 等于谎报）；`durationMs = 0` 是起跑快照的占位，不要渲染成「0ms」。
- 轮询要看「有运行中的 run 行」：只按实时判活跃会提前停轮询，终态永远到不了前端。

## 依据

- `apps/admin/src/app/(app)/(standalone)/main/ai/chat/history.ts`（`applyChildRunStates`）
- `apps/admin/src/app/(app)/(standalone)/main/ai/chat/chat-session.ts`（`applyRunStates` / `views`）
- `apps/admin/src/app/(app)/(standalone)/main/ai/chat/sub-agent-live.ts`（`withRunState` / `isActiveRunStatus`）
- 单测：`apps/admin/test/chat-session-store.test.ts`（清空后仍终态 / 运行中不倒退 / 无实时块首屏）、
  `apps/admin/test/ai-history.test.ts`（起跑快照被终态覆盖）

## 核对命令

```bash
grep -n "applyChildRunStates" "apps/admin/src/app/(app)/(standalone)/main/ai/chat/history.ts"
grep -n "applyRunStates\|private views" "apps/admin/src/app/(app)/(standalone)/main/ai/chat/chat-session.ts"
grep -n "withRunState\|isActiveRunStatus" "apps/admin/src/app/(app)/(standalone)/main/ai/chat/sub-agent-live.ts"
```

## 失效信号

- 服务端改成在子 run 收尾时把终态**再写一条** `data-sub-agent` 到父会话（那历史 part 自带终态，
  覆盖逻辑可以只留兜底）；
- `run/list` 不再返回子 run（那得换数据源，别再退回实时块）；
- 子助手卡改成从子 run 时间线拉摘要（那时正文/结论也从库里来，"没有留下正文"的兜底文案要改）。
