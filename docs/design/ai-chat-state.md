# 会话页前端状态与数据流（按 part 类型增量归约）

> 触发：会话 `vske8ur0le74hwsfii0s`（1 轮、4 路并行子助手）**把页面卡死**。
> 结论与做法：**只改前端**。后端一行没动 —— 数据照常逐块下发，前端按 part 的 type
> 把「数据」归约成「渲染状态」，不再把 parts 当渲染槽位用。
> 2026-11-13 补记了同期落地的会话隔离键、续流入口与右栏 tab（§2.4 / §7），
> 主体结论未变。

## 0. 实测证据（2026-11-03）

| 指标 | 实测值 | 来源 |
| --- | --- | --- |
| 子助手输出 token | 62,895（根 run 合计 76,941） | `runs.usage` |
| 流块（Redis 输出记录） | `LLEN = 20000`，**已顶到 `CHUNKS_MAX` 被 ltrim 截断** | `agent:stream:qs176wjgq01jkh87y116` |
| 其中 `data-sub-agent-delta` | 12,868 条（截断后的窗口内），平均 3.47 字节/块 | 同上 |
| 推算 delta 总数 | 子助手正文+推理 120KB ÷ 3.47B ≈ **3.5 万块** | 两条数据交叉 |
| 时间线（历史）行数 | 377 行（text 20 + reasoning 58 + 工具 116 + 计划 5） | `timelines` |

同一个会话两个入口两种规模：**实时 3.5 万 part，刷新后约 200 part**。卡死只发生在实时 / 重连。

## 1. 根因

**R1 逐帧增量被当成了"内容 part"。**

`agent-runner.ts:612` 的 `writeDelta` 写 `{ type: 'data-sub-agent-delta' }` 且不带 id；AI SDK 对
不带 id 的 data 块**每块 push 一个 part**（`ai/dist/index.js` 的 `processUIMessageStream`）。
而 `docs/design/ai-agent.md` §5.2 / §5.4 早就写明：进度类逐帧增量走 `transient`（只触发 `onData`、
不进 parts），内容与状态才走持久 part。实现没落到这条设计上。

**R2 渲染层把 parts 当渲染槽位。**

`message-row.tsx` 每帧：计划收集 / 事件分桶 / 子助手收集 / 委派去重各扫一遍 parts，再
`parts.map` 生成同样长度的 children（3.5 万个 `null` 槽）；`chat-conversation.tsx` 另有三个
依赖 `[messages]` 的全量 memo（每帧必失效）。真正要画的单元只有几十个。

**R3 更新频率跟着 chunk 走。**

`experimental_throttle: 60` 只节流"React 提交"，节流不了每帧成本；4 路并行时主线程长期超 100%。

## 2. 做法

### 2.1 传输层：逐帧增量不落 part

`chat-transport.ts` 继承 `DefaultChatTransport`，在 `processResponseStream` 后加一层
`markTransientChunks`：给 `data-sub-agent-delta` 打 `transient: true`。

- 这是 SDK 的**正式通道**（transient data chunk 只调 `onData`、绝不进 parts），不是绕路；
- 数据仍然一块块到达前端（流式体验不变），只是不再变成 part；
- 续传（`reconnectToStream`）走同一个 `processResponseStream`，所以"重开页面又卡一次"的入口一并关掉；
- 后端零改动：块还是那些块，Redis 补发内容不变。

### 2.2 会话层：按 type 增量归约

`chat-session.ts` 的 `ChatSessionStore`：

- **写 1 —— `sync(messages)`**：useChat 的消息数组进来，逐条按 part 归约。只处理
  **新出现的 part** 与**尾部被就地更新的那一个**（流式文本 / 推理 / 工具结果都是同一下标覆盖），
  所以成本与"这一帧新增了多少内容"成正比，与整条消息长度无关。
- **写 2 —— `applyChunk(chunk)`**：`onData` 的 data 块。`data-sub-agent` 合并状态、
  `data-sub-agent-delta` 追加进聚合正文；`data-run` 表示新一轮开始 → 清空上一轮实时数据
  （续传重放也从这里重来，正文不会翻倍）。
- **读 —— `getSnapshot()`**：`{ messages, live, liveById }`，几个订阅入口：
  `useChatMessages()` / `useLiveSubAgents()` / `useLiveSubAgent(runId)` / `useHasActiveSubAgent()`。

归约规则（就是"按 type 追加或更新"）：

| part | 归约结果 |
| --- | --- |
| `text` / `reasoning` | 同一下标覆盖同一个单元（`streaming` 跟着 part.state） |
| `dynamic-tool` | 按 `toolCallId` upsert；委派 / 计划 / 问答工具的原始卡记 `hidden` / `delegated` |
| `data-sub-agent` | 该 `runId` 的子助手单元：状态快照合并；带 `toolCallId` 时把对应工具卡标成 `delegated` |
| `data-sub-agent-delta` | **折叠进聚合正文**，不产生新单元（下标前进才追加，重放幂等） |
| `data-tool-event` | 能对上工具卡的并进卡里；对不上的独立成卡（之后若出现同 id 工具卡，渲染时按"已认领"跳过） |
| `data-tool-call-suspended` | 问答卡单元 |
| `data-plan` | 重算消息级计划（`collectMessagePlan`），不占单元 |
| `data-run-usage` | 记到消息的 `usage` |
| `data-run` / `data-run-suspended` / `step-start` / `data-conversation-title` | 不进正文（`data-run` 同时清实时数据；标题块由 `onData` 另行处理，不进归约） |
| 其它未知 part | 记一个 `unknown` 单元（不静默丢内容，便于发现新协议块没接上） |

### 2.3 视图层：只吃单元，各自订阅

- `ChatMessage`（原 `MessageRow`，文件仍是 `message-row.tsx`）接 `ChatMessageState` 并 `memo`：
  消息没变就不重渲染；单元列表直接 `map`，**渲染期不再扫 parts**。
- **store 的归属层在页面**：`ChatSessionStore` 由 `[conversationId]/page.tsx` 的
  `ChatSessionProvider` 创建（`useRef`）并下发 context，**不是** `ChatConversation` 自己建 ——
  Provider 一旦是使用方 `return` 的一部分，组件体里的 `useContext` 永远读不到它
  （SSR 报"会话 store 缺失"，整页退化成纯客户端渲染）。
- 子助手卡自己订阅 `useLiveSubAgent(runId)`：实时增量只重渲染那一张卡，
  不会带着整行 / 整个列表一起重渲染（实时数据 100ms 合并通知一次）。
- 右栏「子 agent」用 `useLiveSubAgents()`；右栏的"子助手完整过程"用 `toMessageState(history消息)`
  走同一套归约 + 同一个 `ChatMessage`，历史与实时形状一致。
- 运行指示 `RunActivity` 拿 `activeSubAgentName`（布尔 / 单值订阅，只在翻转时重渲染）。

### 2.3.1 右栏 tab（现状）

`RightPanelTab = 'system' | 'skills' | 'plan' | 'subagents' | 'files'`：

| tab | 数据源 | 备注 |
| --- | --- | --- |
| 系统指令 | `/agent/instructions` | — |
| 技能 | **当前消息的 parts**（派生） | 只列**本会话实际激活过**的技能（从 `skill` 工具入参算），不是"可用技能清单"；关联不到库里的标「库外」 |
| 任务 | 消息级计划（`data-plan` / `collectMessagePlan`） | tab 上的进度 `3/5` 与卡片正文同源 |
| 子 agent | 库里的子 run + `useLiveSubAgents()` 合流成 tab | 完整过程用 `toMessageState` + 同一个 `ChatMessage` 渲染 |
| 文件 | 会话详情 `aiFiles` + `/agent/file/workspace` | 两个视图（会话文件 / 工作区），见 `ai-file-manager.md` §8.3 |

### 2.4 会话隔离：`chatSessionKey` 与"隔离代次"

会话页的 `useChat` 实例 id 与 store 全都挂在**一个 key** 上，key 由 `routes.ts` 统一给
（`chatSessionKey(conversationId)`），不是页面里的 `useRef` 自增：

- 真实会话 → `chat-<conversationId>`，天然隔离；
- `new`（占位段 `NEW_CONVERSATION_SLUG = 'new'`）→ 每次进入分配一个新的 `chat-new-<n>`；
- **`new → 真实 id` 是同一次发送的延续**：`markAdoptedConversation` 把真实 id 映射回那个
  `chat-new-<n>`，页面 key 不变 → 不重挂载 → 正在流的 `useChat` 连接和刚收到的消息都不丢；
- `nextChatGeneration()` 只在其它的 id 变化（A→B、A→new）时递增，用来判断"真的换了会话"。

> 为什么不把 key 直接绑 URL 参数：`new → 真实 id` 会重挂载整棵对话区，用户看到"闪一下 / SSE 断了"。

### 2.5 续流（断线 / 刷新 / 换设备）

四个入口分开，别混用：

| 场景 | 端点 | 说明 |
| --- | --- | --- |
| 建流（发一轮） | `POST /agent/chat/stream` | AI SDK transport 的 `api`；**只收 POST** |
| 回答挂起（问答卡） | `POST /agent/chat/resume` | 返回同一轮的续跑 SSE（`resumed: true`） |
| 续流（知道 runId） | `GET /agent/run/{runId}/stream?offset=` | `resumeStreamUrl(runId, offset)` |
| 续流（不知道 runId） | `GET /agent/run/stream?offset=&conversationId=` | `currentRunStreamUrl(offset, conversationId)`；没有进行中的轮就 204 |

- `useChat({ resume: true })` 挂载即尝试接回；transport 的
  `prepareReconnectToStreamRequest` 指向**允许 GET 的** `currentRunStreamUrl` ——
  退回建流地址会让浏览器对 `POST /agent/chat/stream` 发一次 GET（踩过，404）；
- **必须带 `conversationId`**：不带则服务端只按登录用户跨会话找最近一条，切到已结束的会话
  会接上别的会话正在跑的流（串流）；新会话页传占位段 `new`，永不匹配任何 run；
- 另有一条兜底：轮询会话详情发现 `running` 时主动调一次 `resumeStream()`（DB 的 `running`
  才是事实），每个会话只试一次，由 `reconnectedFor` ref 去重；
- 续传重放会重发 `data-run`，store 据此清空上一轮实时数据（§2.2），正文不会翻倍。

## 3. 取舍

| 选择 | 备选 | 为什么这样选 |
| --- | --- | --- |
| 保留 `useChat` | 自建 SSE 客户端 + reducer | 续传 / 停止 / 工具挂起续跑都已在它上面跑通，重写风险大于收益 |
| `messages` 仍是消息唯一真相 | 复制进自建 store | 双写必然漂移（历史 / 流 / 续传对齐 messageId 的坑已有注释为证） |
| 增量在**传输层**标 transient | 服务端改 `writeDelta` | 用户要求后端不动；这层是 SDK 给前端的口子，一行 transform 即可 |
| 归约放在 React 之外（类 + `useSyncExternalStore`） | 组件内 `useMemo` 重算 | 渲染函数不能有副作用；放外面才能"按 part 增量"而不是"每帧重算" |
| 不设"上限兜底" | 单条消息 part 上限 / 文本截断 | 归一后 part 数与单元数已经是常数级；上限只是防将来别的通道再犯，不是本次必需 |

## 4. 不变式（可用单测钉住）

1. **单元数与流长度无关**：一万个 delta 块 → 仍然只有 1 个子助手单元（`test/chat-session-store.test.ts`）。
2. **归约幂等**：同样的 parts 再同步一遍，正文与聚合文本都不翻倍。
3. **委派 / 计划 / 问答"同一件事只画一张卡"**：工具卡被标记 `delegated` / `hidden`，事件不丢。
4. **part 不再堆积**：`data-sub-agent-delta` 不落 parts（`markTransientChunks` 单测 + 实跑核对）。

## 5. 风险

1. **旧历史数据**里可能已有 `data-sub-agent-delta` part（改造前的流）：`collectSubAgentLives` /
   `toParts` 仍能容忍，按顺序聚合，不丢正文。
2. **续传重放**：`data-run` 清空实时数据 + 消息 parts 变短时整条重建 —— 两处都要保留，
   否则会出现"刷新后正文翻倍 / 残留旧内容"。
3. **StrictMode**：store 建在页面层 `ChatSessionProvider` 的 `useRef` 里（不在使用方组件里建），
   避免 render 期双建；Provider 缺失时 SSR 直接报错，不会静默降级。

## 6. 验证

- `pnpm --filter @app/admin typecheck` / `test` / `pnpm check:ui` 全绿；
- 界面交人工验（见本次开发日志的清单）：跑一个多子助手任务，看消息流是否流畅、
  子助手卡是否边跑边长、刷新后历史是否与实时同形。

## 7. 现状补记（2026-11-13）

- **代码位置（都在 `apps/admin/src/app/(app)/(standalone)/main/ai/chat/`）**：
  `chat-transport.ts`（transient 标记）、`chat-session.ts`（`ChatSessionStore` + hooks）、
  `message-row.tsx`（`ChatMessage`）、`chat-conversation.tsx`（`useChat` / 发送 / 续流）、
  `right-panel.tsx`（5 个 tab）、`files-panel.tsx` / `skill-preview-dialog.tsx`（右栏面板）、
  `routes.ts`（会话 key / 隔离代次）。
- **测试**（`apps/admin/test/`）：`chat-session-store.test.ts`（单元数不随流长度增长）、
  `chat-session.test.ts`（归约规则）、`sub-agent-live.test.ts`、`tool-event.test.ts`、
  `resume-answer.test.ts`、`skill-activity.test.ts`、`skill-markdown.test.ts`、
  `ai-stream-urls.test.ts`（建流 / 续流地址）。
- **`markTransientChunks` 只标 `data-sub-agent-delta`**；其它 data 块（子 agent 状态、计划、
  事件、用量、挂起）仍落成 part —— 它们的数量是"每次调用一条"，不是逐帧。
- **`experimental_throttle: 60` 保留**：它只节流 React 提交，真正让页面不卡的是"增量不落 part"
  与"按 type 增量归约"，两者缺一不可（这也是 §1 的 R1/R2 结论）。
- 归约出来的未知 part / 认领不到的事件不会静默丢：分别落成 `unknown` 单元与独立事件卡。
