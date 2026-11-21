# 会话页"自己滑到底"：是 resize，不是 initial

**查证优先级：抽核**（会话页滚动相关改动、或升级 `use-stick-to-bottom` 时复核）
核对命令：
```bash
grep -n "ConversationAutoScroll\|resize={streaming" "apps/admin/src/app/(app)/(standalone)/main/ai/chat/chat-conversation.tsx"
grep -n "EndAlignedPanel" "apps/admin/src/app/(app)/(standalone)/main/ai/chat/session-tabs.tsx"
grep -n "previousHeight ?" node_modules/.pnpm/use-stick-to-bottom@*/node_modules/use-stick-to-bottom/dist/useStickToBottom.js
```

## 结论

- `use-stick-to-bottom` 的规则：内容**第一次**长高用 `initial`，之后每次长高用 `resize`。
- 会话页挂载时已经渲染「正在加载会话历史…」占位（有高度），所以**历史到达算第二次长高** →
  用的是 `resize`。只把 `initial` 改成 `instant` **没有用**（2026-11-13 实测，用户仍看到滑动）。
- 正确做法：非流式的内容长高一律 instant ——
  `<Conversation initial="instant" resize={streaming && !loading ? 'smooth' : 'instant'} />`，
  只有流式输出才平滑跟随。
- 库把 `optionsRef.current = options` 放在**渲染期**，所以同一次提交里 `loading` 翻转后，
  ResizeObserver 回调读到的已经是新值（不必等 effect）。

## 2026-11-21 补充：两个「不会自动滚」的坑

- **用户发完新消息不滚**：`isAtBottom` 会被输入区上方 dock（任务卡 / 运行状态）的高度变化判成
  false，之后内容长高就不再跟随。修法是显式触发：`ConversationAutoScroll`（`@repo/ui` 的
  conversation.tsx）监听**最后一条 user 消息 id**，一变就 `scrollToBottom('smooth')` ——
  用户自己发消息是唯一"必须拉到底"的动作，流式增量不改变这个 id，所以不会抢视图。
- **切子 agent tab 停在顶部**：子 agent 面板原先只是普通 `overflow-auto`，没有任何贴底逻辑。
  现在用 `EndAlignedPanel`（session-tabs.tsx）：挂载即 `scrollTop = scrollHeight`，
  内容长高跟随时观察**内容元素**（时间线异步到货），用户自己上翻（距底 >24px）就停。

## 依据

- `apps/admin/src/app/(app)/(standalone)/main/ai/chat/chat-conversation.tsx` 的 `<Conversation>` props
- `useStickToBottom.js` 的 ResizeObserver 分支：`previousHeight ? options.resize : options.initial`
- `docs/dev-logs/2026-11-13.md`

## 失效信号

升级 `use-stick-to-bottom` 改了"首次长高"的判定，或换掉 `Conversation` / `ConversationAutoScroll`；
`EndAlignedPanel` 换成虚拟滚动（那时贴底要改 `scrollToIndex`）。

## 2026-11-22 补充：用户气泡按轮次吸顶

- **钉的是气泡本身**（用户口径："就那个气泡吸顶"；"视口之前最近的那个"），不是另起一条吸顶条。
- **必须按轮次分组**：`position: sticky` 只在自己的包含块里移动。把「用户消息 + 它的回答」包成
  一轮（`chat-turns.ts` 的 `groupChatTurns`），气泡才会在这一轮内一直钉着；下一轮气泡到达顶部
  把它顶走 —— 这正是"视口之前最近的那个气泡"。
  **不要**给所有用户消息直接加 `sticky`（不加容器边界）：滚过去的会全部叠在顶部，矮气泡后面
  露出高气泡的下半截。
- **背景必须铺满整行**：气泡是右对齐、行宽 `w-full`；只给气泡上底色的话，回答会从气泡左边的
  空隙"透"出来，所以吸顶时整行实底（`bg-card/95` + `backdrop-blur`）。
- **10 行折叠**用「行高 × 10」实测像素上限 + `scrollHeight` 判溢出，不用 `-webkit-line-clamp`：
  用户消息是 `whitespace-pre-wrap`，line-clamp 对用户自己打的换行计数不稳（Safari）。
  纯函数在 `user-message-clamp.ts`（阈值 / `line-height: normal` 兜底 / 1px 容差）。
- **展开按钮位置**：吸顶气泡用 `variant='sticky'` 浮在右上角 —— 展开不限高，消息可能比视口还高，
  按钮放底部会点不到。

## 失效信号（补充）

换成虚拟滚动，或用户消息改成 Markdown 渲染（折叠要按渲染块而不是纯文本行数）；
吸顶改成顶部悬浮条（用户明确要的是气泡本身）。
