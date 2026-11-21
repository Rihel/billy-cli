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
