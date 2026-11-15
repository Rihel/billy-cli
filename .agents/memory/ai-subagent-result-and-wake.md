# 子助手结论与唤醒：四个容易复发的坑

> **查证优先级：必核** —— 行号、标记键名、TTL 都是会变的值；改 `agent-runner` / `subagent.tool` /
> `run-queue.*` 后重核。

## 结论（2026-11-15）

1. **结论正文只能收 `text` 增量**：`agent-runner` 流循环里的 `text` 同时是落盘结论
   （`persistResultFile`）、唤醒 payload、卡片摘要与 `outcome.result` 的来源。把 `reasoning-delta`
   也拼进去，结论文件就会整段以 CoT 开头（实测 `subagents/故事风格调研-….md` 前 101 行是思考，
   父 agent `read-file` 读结论时又把 CoT 读进自己的上下文）。时间线里 reasoning / text 本来就分开存，
   脏的只有这个拼接产物。
2. **`wait-sub-agent` 不传 id 时，目标集必须含「已完成但队列项还没被消费」的子**：只收「未完成」
   会让父收口漏掉早就跑完的那一路，父 run 结束后 dispatcher 补一轮延迟唤醒（实测 20:44 起了一个
   1 步 / 0 工具的 run，模型回「这条通知是延迟到达的…」，多烧 9.2 万 token）。
3. **「已交付」是事实，要独立标记**（Redis `ai:subagent:delivered:<subRunId>`，7 天）：
   `runs.finish` 翻终态在前，落结论文件 / 回写用量 / `enqueue` 在后，中间父的 wait 可能先拿到结果 ——
   那时队列行还不存在，`consumeByDedupe` 必然失手。入队端与 `dispatcher.dispatch`（claim 之后）
   都查标记，晚到的队列项直接 `markDone`、不起 run。
   **代价：卡必须有人写**。完成卡原本只有 dispatcher 起 run 时写，标记挡掉入队后它就永远不跑 ——
   所以 `wait` 除了「消费到队列行」的情况，还得在「队列里根本没有这一行」（`findByDedupe` 为 null）
   时自己补卡，否则时间线上没有任何"子助手完成"的证据。

4. **`subagents/` 只给引擎写**：主 agent 若让子助手自己往 `subagents/<名字>.md` 落全文，就会与引擎的
   `<名字>-<subRunId>.md` 并存（一个子助手两个文件），不带 run id 的那份重跑必覆盖，父还常常只读
   浓缩版、全文没人读。正确做法：让子助手把全文放进最终回复（引擎落盘），或写到 `reports/`
   （2026-11-15 会话 `p4cmqhspjjyuhnfp4dsi`；纪律句在 `assistant.eta`，`ai-prompt-guardrails` 守着）。

## 依据

- `apps/agent-runtime/src/modules/ai/runtime/agent-runner.ts`（流循环的 `if (delta.kind === 'text')`；
  `enqueueSubAgentWake` 的 `isConsumed` 前置）
- `apps/agent-runtime/src/modules/ai/tools/subagent.tool.ts`（`wait` 的 targets 与 `markConsumed`）
- `apps/agent-runtime/src/modules/ai/runtime/run-queue.service.ts`（`markConsumed` / `isConsumed` /
  `listQueuedSubAgentKeys`）、`run-queue.dispatcher.ts`（claim 后的 `skipped_consumed`）
- 会话 `cdzcqdf6bteca91p10cm`：队列行 `mr9ga19v2h4k2n2cvwau`（20:41:18 入队 → 20:44:00 才起 run）；
  唤醒 run `g3k4jo7l7124iw8t4sy3`（9.2 万 token / 1 步 / 0 工具）

## 核对命令

```bash
grep -n "delta.kind === 'text'" apps/agent-runtime/src/modules/ai/runtime/agent-runner.ts
grep -n "listQueuedSubAgentKeys\|markConsumed\|isConsumed" apps/agent-runtime/src/modules/ai/runtime/run-queue.service.ts
psql "$DB_URL" -c "select dedupe_key,status,created_at,started_at from conversation_run_queue where conversation_id='cdzcqdf6bteca91p10cm'"
```

## 失效信号

- `wait-sub-agent` 被删（改纯唤醒驱动）：只剩调度端一个消费者，第 2 条不再适用；
- `finish()` 改成「先入队、再翻终态」：第 3 条的时序窗口消失，标记降级为幂等兜底；
- 子助手结论改成从子 run 时间线按 kind 取正文（不再用运行中拼接）：第 1 条要改口径。
