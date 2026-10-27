# 会话页：动态段换参数会重挂载页面子树

**查证优先级：抽核**（Next 升级、或会话页路由结构改动时复核）

## 结论

`/main/ai/chat/[conversationId]` 里 `new → 真实 id` 的 `router.replace` **会卸载并重新挂载整棵对话区**。
组件里的 `useState` 全部归零；`useChat` 的消息不丢，是因为 Chat 实例按 `useChat` 的 `id` 存在
组件外（SDK 的 chat store），不是因为它没重挂载。

**失效信号**：升级 Next 大版本后重新实测；或页面不再用动态段承载会话 id。

## 怎么实测（2026-10-27，Next 16.3.5）

无头 Chrome + CDP（`/tmp/repro` 那套脚本，不入库）：

1. 打标记记下 `textarea` 元素，每 50ms 采样 `document.querySelector('textarea') === 旧元素`；
2. 在 `/chat/new` 选一个非默认模型 → 发一条消息；
3. `location.pathname` 变成真实 id 的那一帧：`sameTa: false`、`taConnected: false`、`loading` 又变回 true。

同一实验里 `runs.request_snapshot->>'model'` 仍是选中的模型 —— **数据没错，只有界面 state 被重置**。
换 `useParams()` 代替 `use(params)`、去掉 layout 的 `<Suspense>` 都**没**能阻止重挂载（都试过）。

## 由此定下的写法

- 会话页凡是要跨"首轮建会话"活下来的选择，**存在 React 之外**：
  模型选择 → `localStorage['ai-chat-model:<会话 id>']`（`new` 段是"下个新会话的待用选择"，
  首轮拿到真实 id 时搬家）；口径见 `docs/design/ai-agent.md` §4.9.4 与 `chat-conversation.tsx`。
- 存的选择可能过期（模型被删 / 停用）→ effect 里校验，不在可选清单就归零，
  否则服务端按"不静默回落"直接回 3402，用户看到的是"每轮都发不出去"。

## 依据

- `apps/admin/src/app/(standalone)/main/ai/chat/chat-conversation.tsx`（`MODEL_STORAGE_PREFIX` + 两个 effect）
- `apps/admin/src/app/(standalone)/main/ai/chat/[conversationId]/page.tsx`（页面 key 只解决"切会话隔离"，
  解决不了本次重挂载）
- `docs/dev-logs/2026-10-27.md`
