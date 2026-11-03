# 会话页渲染状态：按 part 类型增量归约

**查证优先级：抽核**（目录 `apps/admin/src/app/(standalone)/main/ai/chat/` 有改动时重核）
核对命令：`ls apps/admin/src/app/\(standalone\)/main/ai/chat/chat-session.ts apps/admin/src/app/\(standalone\)/main/ai/chat/chat-transport.ts`

## 结论

会话页不再把 `message.parts` 当渲染槽位。parts 进 `ChatSessionStore`（`chat-session.ts`）
**按 type 增量归约成渲染单元**，组件只吃单元：

- `text` / `reasoning`：同一下标覆盖（流式 part 原位更新，幂等）；
- `dynamic-tool`：按 `toolCallId` upsert；委派 / 计划 / 问答的原始卡标 `delegated` / `hidden`；
- `data-sub-agent`：该 runId 的子助手单元（状态合并）；
- `data-sub-agent-delta`：**折叠进聚合正文**，不产生单元；
- `data-tool-event`：有主并进工具卡，无主独立成卡（之后出现同 id 工具卡时渲染跳过）；
- `data-plan` / `data-run-usage`：记到消息的 plan / usage，不占单元。

实时数据：`onData` → `applyChunk`（100ms 合并通知），`data-run` 表示新一轮开始 → 清空上一轮。
视图：`ChatMessage`（`message-row.tsx`）接单元并 `memo`；子助手卡各自订阅 `useLiveSubAgent(runId)`。

## 坑（2026-11-03 实测）

- 逐帧增量若落成 part，part 数 ∝ 输出 token：会话 `vske8ur0le74hwsfii0s` 一轮 4 路子助手 →
  约 3.5 万 part（Redis `LLEN` 已顶 20,000 cap，`data-sub-agent-delta` 12,868 条 / 平均 3.47B）。
  表现是**页面卡死**（每帧多轮全量扫描 + 数万 children）。
- 修法是 **transient**：`chat-transport.ts` 在 `processResponseStream` 后给这类块打
  `transient: true`（SDK 只调 `onData`、不 push part），**后端不用改**；续传走同一条路。
- 续传重放（offset 0）会让 parts 从 0 重来：`sync` 必须"parts 变短就整条重建"，否则残留旧内容；
  实时正文靠 `data-run` 清空重聚合，否则正文翻倍。
- 归约必须**幂等**（尾部重放同一 part）：文本/推理/工具覆盖，增量按"下标前进才追加"。

- **Provider 不能由"使用它的那个组件"渲染**（2026-11-03 踩到，SSR 直接炸）：会话 store 原先建在
  `ChatConversation` 里、Provider 是它 `return` 的一部分，组件体里的 `useContext` 永远读到 null
  → 报「会话 store 缺失」→ Next 退化为**整页客户端渲染**，`min-h-screen` 的加载骨架和真实内容叠加，
  文档比视口高一屏，页面被滚下去、底部露出大片空白（用户报的"下面多了一大截空的"）。
  正确位置：store 建在**页面层**（`[conversationId]/page.tsx` 的 `ChatSessionProvider`，key 跟会话代次），
  会话页与子树统一用 `useChatSessionStore()` 那条 context hook。

- **右栏长内容会把整页的滚动区撑大**（实测 2026-11-03）：子助手过程能长到 8000px，虽然被面板内部
  `overflow: auto` / 面板 `overflow: hidden` 裁住，它的**可滚动溢出仍然计入
  `document.scrollingElement.scrollHeight`**（900 → 8149，整页多出滚动条、切 tab 时被顶动）。
  只加 `overflow: hidden` / `clip` 压不住；给面板内层加 **`contain: paint`** 才回到 900
  （在 `ResizablePanel` 的 `style` 上加，面板内层滚动照常可用）。核对命令：控制台切到子 agent tab 后看
  `document.scrollingElement.scrollHeight`，应为视口高度。

- 会话页的**分栏组不能吃库的内联 `height: 100%`**（`react-resizable-panels@4` 会写死在 Group 上）：
  本页是「页头 + 分栏组」的竖排 flex，`100%` 按整个 section 算 → 溢出约一个页头的高度。
  溢出被 `overflow-hidden` 裁掉后，**根容器仍然是一个可被程序滚动的容器**（hidden 只是不响应滚轮，
  `focus` / `scrollIntoView` 照样改 `scrollTop`）—— 表现是切右栏 tab 时"整屏被顶上去一截"。
  两处修：Group 传 `style={{ height: 'auto' }}` 交给 `flex-1`；独立布局根用 `overflow-clip`（不建立滚动容器）。

- 计时别再"500ms 采样 + 0.1s 精度"混着用：数字会按 0.5 一跳（0ms→500ms→1s→1.5s）。
  统一用 `use-elapsed.ts`：250ms 采样、状态存**整秒**（值不变 React 直接 bail out → 每秒只重渲染一次），
  结束向上取整冻结；历史耗时（审计 `durationMs`）保持一位小数显示。

## 依据

- `chat-session.ts`（归约 + store + 订阅）、`chat-transport.ts`（transient）、`message-row.tsx`（单元渲染）
- 单测：`apps/admin/test/chat-session-store.test.ts`（一万 delta 仍一个单元 / 重放幂等 / 去重规则）
- 方案：`docs/design/ai-chat-state.md`

## 失效信号

- 渲染层又出现"渲染期扫 `message.parts`"或"按 parts 长度生成 children"；
- 服务端把 `data-sub-agent-delta` 改成带 id（那时它会被 SDK 按 id 归并，不需要 transient）；
- 换成别的流消费方式（不再走 `DefaultChatTransport`）。
