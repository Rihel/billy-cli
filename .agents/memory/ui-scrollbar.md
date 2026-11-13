# 滚动条：覆盖式滑块自己画（原生伪元素不能过渡）

**查证优先级：抽核**（`packages/ui/src/globals.css` 滚动条段、`components/overlay-scrollbar.tsx` 有改动时复核）
核对命令：`grep -n "scrollbar-overlay" packages/ui/src/globals.css`、
`grep -rn "OverlayScrollbar" apps/admin/src apps/web/src`（两个 app 各一处挂载）

## 结论

- 原生滚动条伪元素 `::-webkit-scrollbar-thumb` **不支持 `transition`、也不支持 `animation`**
  （2026-11-13 无头 Chrome + CDP 实测：300ms 时颜色已是终值 / 仍是初值）；`var()` 可用。
  所以"淡入淡出"只能自己画一个元素。
- 现行方案：原生滚动条只留**交互**（8px 沟槽、拖拽 / 点轨道 / 键盘），滑块涂透明；
  视觉是 `OverlayScrollbar` 的两个 `position: fixed` 的 4px 圆角 div，`opacity` 过渡 260ms、
  停手 700ms 淡出。`pointer-events: none`，所以拖拽仍落在下面的原生滚动条上。
- **只跟随最近被滚动的那个元素** → 不会"滚一个区域、整页滚动条都亮"。
  跳过 `[data-autoscrolling]`（消息流自动跟随）与 `scrollbar-width: none`（`no-scrollbar`）。
- 几何：`thumbBox(scrollSize, clientSize, position)` 纯函数——长度 = `max(24, client/scroll × 轨道)`，
  偏移按滚动比例夹在 `[0, 轨道-长度]`；文档滚动条用 `documentElement` 单独度量（视口 rect）。
- 坑（2026-11-13 现场：右栏标签条出现竖直滚动条）：`overflow-x-auto` 会把另一轴也算成
  `auto`（CSS 规定 visible+非 visible → auto）。固定高度的横条（标签条 32px）一旦横向溢出，
  横向滚动条吃掉 8px 高度，内容立刻纵向溢出 → 长出**竖直滚动条**。横条一律显式
  `overflow-y-hidden` + `scrollbar-none`（标签条不需要滚动条），不要只写 `overflow-x-auto`。
- 另一个坑：Chromium 容器上写 `scrollbar-width` / `scrollbar-color`（`scrollbar-thin` 等）会让
  `::-webkit-scrollbar` 定制整体失效、退回原生——自定义外观的容器不要写；标准属性只在
  `@supports not selector(::-webkit-scrollbar)`（Firefox）里把原生滚动条涂透明。

## 依据

- `packages/ui/src/components/overlay-scrollbar.tsx`（`thumbBox` + `OverlayScrollbar`）
- `packages/ui/src/globals.css`「滚动条（macOS 覆盖式）」段
- `docs/design/design-system.md` §4.5
- 实测方式：headless Chrome + CDP，`getComputedStyle(el, '::-webkit-scrollbar-thumb')`

## 失效信号

换成成熟库（OverlayScrollbars 等），或浏览器开始支持滚动条伪元素的过渡 / 动画。
