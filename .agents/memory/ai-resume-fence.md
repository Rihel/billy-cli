# resume fence（Mastra 挂起可恢复性）

**查证优先级：必核**（Mastra 版本相关；升级 Mastra 后重跑核对命令）

`abortRunStream(runId)` **不是**"释放流槽位"的中性操作：内部 `abortRun(runId, pubsub)` 默认
`fenceResume: true`，语义是「abort 发生在等待审批 / 挂起期间 → 这个 suspension 永远不能恢复」；
对 parked（挂起中）的 run 还会 `#deleteAbortedSuspendedRun` 删掉快照行。之后 `resumeStream`
入口 `#throwIfRunAborted` 抛 `cannot resume aborted run` → run 标 `failed 3302`，再提交得 409。

**规则**：续跑收尾要放旧槽位时，只在「这次续跑不会再挂起」时调它 ——
`if (!suspendedAgain) agent.abortRunStream?.(run.engineRunId)`。

后果实录（2026-11-17）：一次续跑里模型又挂了下一个问题，第二次回答必失败（run `rj7w3stssee4eh2urzia`）。
公开的 `abortRunStream` **不接受** options，拿不到 `{ fenceResume: false }`。

## 依据

- `@mastra/core@1.82.0` dist `agent-*.js`：`isResumeFenced` / `#fenceResume` / `abortRun(runId, pubsub, options = {})`；
- `apps/agent-runtime/src/modules/ai/runtime/chat.service.ts`：`if (!suspendedAgain) agent.abortRunStream?.(...)`；
- 回归用例 `apps/agent-runtime/test/ai-stream-e2e.test.ts`「连续两次挂起：第二次回答同样能续跑」。

## 核对命令

```bash
grep -n "fenceResume" node_modules/.pnpm/@mastra+core@1.82.0*/node_modules/@mastra/core/dist/agent-*.js | head
grep -n "if (!suspendedAgain) agent.abortRunStream" apps/agent-runtime/src/modules/ai/runtime/chat.service.ts
```

## 失效信号

Mastra 把 `fenceResume` 提成公开可选参数（`abortRunStream(runId, { fenceResume })`），
或 `abortRunStream` 语义改成只释放槽位不 fence —— 那时这条卡与 `!suspendedAgain` 判断都可删。
