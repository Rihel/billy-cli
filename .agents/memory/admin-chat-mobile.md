# 会话页手机端（<1024）：两个抽屉 + base/lg 双档

**查证优先级：抽核**（会话页目录有改动时重核）
核对命令：`grep -n "useIsMobile" 'apps/admin/src/app/(app)/(standalone)/main/ai/chat/layout.tsx' 'apps/admin/src/app/(app)/(standalone)/main/ai/chat/chat-conversation.tsx'`、
`ls 'apps/admin/src/app/(app)/(standalone)/main/ai/chat/conversation-list.tsx'`

## 结论

- 断点 = `useIsMobile()` 的 1024（`packages/ui/src/hooks/use-mobile.ts`），与 Tailwind `lg` 同界。
  **口径：窄屏写在 base 类里，桌面用 `lg:` 逐项还原**（信息取舍可退到 `sm:`）。
- 三层结构：`(standalone)/main/layout.tsx`（`h-dvh` + 共享顶栏）→ `chat/layout.tsx`
  （桌面分栏 / 手机会话列表 Sheet）→ `chat-conversation.tsx`（页头 + 子 agent tab 条 + 消息 +
  dock + 输入区；手机右栏是**全宽全高 Sheet**）。
- **会话列表只有一份实现**：`conversation-list.tsx` 的 `ConversationGroupList`，
  `variant='sidebar' | 'drawer'`。分组 / 折叠 / 组内「+」/ 删工作区 / 分页 / 行菜单全共用 ——
  抽屉原先自己写了一套扁平列表，结果「工作区」在手机上整个不存在（2026-11-21 返工）。

## 坑

1. **`SheetHeader` 会盖住关闭键**：它是 `sticky z-20`，而 `SheetContent` 的关闭键是
   `absolute top-3 right-3` 且 `z-auto` → 被标题栏底色压住。两个手机 Sheet 改用普通 div +
   `SheetTitle`，并给 `SheetContent` 补 `gap-0`（默认 `gap-4` 会在发丝线后留 16px）。
2. **触屏没有 hover**：`opacity-0 group-hover:opacity-100` 的入口（消息复制、会话行「更多」、
   工作区「+」/删除）在手机上不可达 —— 常显，或走 `persistent` 分支。
3. **手机没有 ⌘/Ctrl**：placeholder 里的「⌘/Ctrl + Enter 发送」是错提示，且
   `field-sizing-content` 的 textarea 不给 placeholder 留高（90 字被裁半句）→ 按 `isMobile` 换短文案。
4. **字号基准被压缩过**：`chat-type-scale` 把 `--text-sm` 压到 12px（`text-xs`=11px），
   `text-[10px]` 这类绝对字号在手机上要抬到 11/12px（`lg:` 还原桌面密度）。
5. **文件树缩进走 CSS 变量** `--tree-step`（base 14 / `lg:` 20px）：虚拟行不重渲染；
   **行高不动**，Virtuoso 实测行高与断点无关。
6. **触屏热区**：`icon-sm`（28px）级的右栏 / 发送 / 复制 / 下载键手机抬到 32px
   （`size-8 lg:size-7`）；`ConfirmAction` 内部固定渲染 `IconText`、不接 className，
   要放大热区只能把 children 包成固定尺寸的 span。
7. **预览弹窗的左栏是 `hidden sm:block`**：`file-preview-dialog.tsx` 在 <640 原先没有任何挑文件
   入口，只剩顶部「上一个 / 下一个」盲翻。现在 `<640` 用页头「文件 N」按钮打开覆盖层，
   与左栏共用 `PreviewFileTree`（同一份 `treeRows` / 折叠态）。

## 未做（要动就得先裁决）

- 外壳没有 `viewport` 导出：既无 `viewport-fit=cover`（安全区恒 0，别加 `env()` 死代码），
  也无 `interactive-widget=resizes-content`（Chrome Android 键盘不压缩布局）。
- `TabsList` 32px 的触控高度、12px 的字号基准：属组件库 / 全局排版决策，没在页面里硬覆盖。

## 依据

`apps/admin/src/app/(app)/(standalone)/main/ai/chat/{layout,conversation-list,chat-conversation}.tsx`、
`apps/admin/src/components/file-preview-dialog.tsx`、`packages/ui/src/components/ui/sheet.tsx`、
`docs/dev-logs/2026-11-21.md`。

## 失效信号

- 断点改回 768、或 `useIsMobile` 换成 CSS 方案；
- 组件库修了 `SheetHeader` 的 z-index / 关闭键位置（那时第 1 条的绕行可以删）；
- 页头 / 输入区 / 右栏 / 列表重构，`lg:` 双档口径不再成立。
