# 会话页"自己滑到底"：是 resize，不是 initial

**查证优先级：抽核**（`chat-conversation.tsx` 的 `<Conversation>` props、或升级 `use-stick-to-bottom` 时复核）
核对命令：`grep -n "resize={streaming" "apps/admin/src/app/(app)/(standalone)/main/ai/chat/chat-conversation.tsx"`、
`grep -n "previousHeight ?" node_modules/.pnpm/use-stick-to-bottom@*/node_modules/use-stick-to-bottom/dist/useStickToBottom.js`

## 结论

- `use-stick-to-bottom` 的规则：内容**第一次**长高用 `initial`，之后每次长高用 `resize`。
- 会话页挂载时已经渲染「正在加载会话历史…」占位（有高度），所以**历史到达算第二次长高** →
  用的是 `resize`。只把 `initial` 改成 `instant` **没有用**（2026-11-13 实测，用户仍看到滑动）。
- 正确做法：非流式的内容长高一律 instant ——
  `<Conversation initial="instant" resize={streaming && !loading ? 'smooth' : 'instant'} />`，
  只有流式输出才平滑跟随。
- 库把 `optionsRef.current = options` 放在**渲染期**，所以同一次提交里 `loading` 翻转后，
  ResizeObserver 回调读到的已经是新值（不必等 effect）。

## 依据

- `apps/admin/src/app/(app)/(standalone)/main/ai/chat/chat-conversation.tsx` 的 `<Conversation>` props
- `useStickToBottom.js` 的 ResizeObserver 分支：`previousHeight ? options.resize : options.initial`
- `docs/dev-logs/2026-11-13.md`

## 失效信号

升级 `use-stick-to-bottom` 改了"首次长高"的判定，或换掉 `Conversation` 组件。
