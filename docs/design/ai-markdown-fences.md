# 富内容围栏：让模型直接表达图、页面与动画

> 定位：AI 会话里「模型写一段带语言标识的代码块 → 前端渲染成看得见的东西」这一层的设计与取舍。
> 现状基线：`MessageResponse`（Streamdown 2.6）已经支持 ```ts 代码高亮、```mermaid 图、`$$…$$` 块级公式；
> 本文补齐 **xflow（流程图）、html（页面预览）、gsap（动画）** 三类，并修掉公式样式缺失。

## 1. 为什么走围栏，而不是新增工具

模型要"表达"富内容有两条路：新增工具（返回结构化数据，前端另做渲染），或者用 Markdown 围栏。

| 维度 | 新增工具 | 围栏 |
| --- | --- | --- |
| 模型侧成本 | 每次都要想参数、多一轮工具往返 | 直接写在正文里，和解释连成一段 |
| 流式体验 | 工具出参到齐才渲染 | 与正文同一条流，边生成边到位 |
| 历史回放 | 依赖时间线里存的结构化出参 | 时间线里本来就是文本，天然可回放 |
| 边界 | 工具面越加越大 | 只扩语言标识，不动工具面 |

结论：**走围栏**。工具留给"要拿数据/要动手"的事，表达交给正文。

扩展点是 Streamdown 的 `plugins.renderers`（`language → 组件`，组件收到 `code` / `language` / `isIncomplete` / `meta`），
不需要 fork Streamdown，也不需要自己解析 Markdown。

## 2. 围栏清单

| 围栏 | 渲染 | 状态 |
| --- | --- | --- |
| ```` ```ts ```` 等普通代码 | Shiki 高亮 + 复制/下载 + 行号 | 已有 |
| ```` ```mermaid ```` | mermaid 11 渲染 SVG（跟随明暗主题、可下载） | 已有 |
| `$$ … $$` | KaTeX 块级公式 | 已有，但**没引 KaTeX 样式表**（字形错位），本次补上 |
| `$ … $` | 行内公式 | **保持关闭**：`$5 到 $10` 这类金额会被误判成公式 |
| ```` ```xflow ```` | JSON → React Flow 流程图 | 本次新增 |
| ```` ```html ```` | 沙箱 iframe 里的真实页面 | 本次新增 |
| ```` ```gsap ```` | 沙箱 iframe + 内置 gsap 的动画 | 本次新增 |
| ```` ```json ```` | 可折叠的 JSON 树（原文 / 复制可切） | 本次新增 |

## 3. 三类新围栏的写法与渲染

### 3.1 xflow：结构化 JSON，前端排版

模型只给"谁连谁"，坐标由前端算 —— 让模型算坐标既费 token 又经常重叠。

```json
{
  "title": "一轮 AI 对话的时序",
  "direction": "LR",
  "nodes": [
    { "id": "user", "label": "用户消息", "kind": "start" },
    { "id": "agent", "label": "主 agent", "description": "决定这轮怎么走" },
    { "id": "tools", "label": "工具往返", "kind": "process" },
    { "id": "done", "label": "落时间线", "kind": "end" }
  ],
  "edges": [
    { "from": "user", "to": "agent" },
    { "from": "agent", "to": "tools", "label": "需要外部信息" },
    { "from": "tools", "to": "agent" },
    { "from": "agent", "to": "done" }
  ]
}
```

- 解析与排版是纯函数（`parseXflowSpec` / `layoutXflow`），可单测：同一份数据结果确定、节点不重叠；
- **排版用 dagre**（`@dagrejs/dagre`，React Flow 官方布局示例用的就是它）：分层布局会做层内排序
  （减少连线交叉）与坐标优化，菱形分叉、交叉边、回边都排得开 —— 先前自己写的「最长路径分层」
  只对树和单向链好看，边一交叉就叠在一起。dagre 有百来 KB，所以放在**按需加载的画布**里，
  不进首屏包；排版结果喂给 `useNodes` 前是一次纯函数调用，仍然可单测；
- 渲染用已装的 `@xyflow/react`（复用 `ai-elements/canvas`、`node` 组件），`fitView`，只读（不可拖拽连线）；
- 解析失败、边引用了不存在的节点：**显示错误 + 原始 JSON**，不静默丢内容；
- 渲染成功时**不再附原始 JSON**：画出来的图就是数据本身，再挂一段 `{"nodes":…}` 折叠块只是噪音
  （只有出错时才把原文摆出来，那时它才是有用的证据）；
- 容器高度由画布排版后回报的内容尺寸决定（夹在 220–420px），不是先拍一个高度再跳；
- **全屏**：会话里那张是缩略图（高 220–420px，只读、滚轮缩放），节点一多只能靠缩小硬看；
  右侧「全屏」按钮开一个 92vh × 96vw 的弹窗，里面是同一份数据、同一套排版的另一个实例，
  只是**撑满容器 + 可拖动画布 + 带缩放控件**（`XflowCanvas` 的 `fill` / `interactive` 两个开关）。
  用弹窗而不是浏览器 Fullscreen API：不额外申请权限、样式可控、Esc 与焦点陷阱由弹窗组件负责。

### 3.2 html / gsap：沙箱 iframe

模型写的 `<script>` 要真跑起来，才有"页面能跑、动画能动"这回事。但它**不能**拿到后台页面的权限。

- `sandbox="allow-scripts"`，**不带 `allow-same-origin`** → iframe 是不透明源，拿不到父页面的 DOM、cookie、localStorage；
- iframe 内 `Content-Security-Policy`：`default-src 'none'`，只放行内联样式/脚本、`data:`/`blob:` 图片；外链脚本、`fetch`、表单提交、嵌套框架全部禁止 —— 模型写的代码无法把页面数据带出去；
- 外链库（gsap）由**父页面同源 fetch 后内联**进文档，不依赖 iframe 的网络权限；注入位置在
  **模型内容之前**（`<head>`）—— 放到后面时，模型自己的 `<script>` 先执行，实测直接 `gsap is not defined`；
- 高度由 iframe 内 `ResizeObserver` 经 `postMessage` 回报，父页面校验 `event.source` 后夹在 120–560px 之间（超出滚动）；
- **全屏**与 xflow 同一套弹窗（92vh × 96vw）：里面是**另一份文档**、另一个 iframe，沙箱参数一字不改 ——
  所以脚本从头再跑一遍，正好用来重看动画；原来的 iframe 不销毁，关掉弹窗就回到它。

`gsap` 与 `html` 的差别只在"多内联一个 gsap"。gsap 文件放 `apps/admin/public/vendor/gsap.min.js`（随包提交），
`apps/admin` 用脚本 `pnpm sync:vendor` 从 node_modules 重新复制，升级版本不靠手抄。

### 3.3 流式行为：没闭合就不渲染

这三类围栏在**围栏未闭合**时只显示一行"正在生成"占位，闭合后才渲染。理由有两条，都是实践结论：

- `html` / `gsap` 每来一个 token 就重建 iframe，等于把脚本反复重跑 —— 动画永远卡在第一帧，控制台反复报错；
- `xflow` 每来一个 token 就重新排版，节点会来回跳。

普通代码块和 mermaid 保持逐字渲染（mermaid 自己做了防抖与错误兜底），不受此限。

### 3.5 json：结构化的东西给结构化的视图

```json
{ "model": "deepseek-v4-pro", "temperature": 0.3, "tools": ["web-fetch", "run-sub-agent"] }
```

- 一层一行、容器可折叠（默认展开两层），容器旁给 `{3 个字段}` / `[5 项]` 摘要；
- 工具栏：展开全部 / 收起全部 / 原文 / 复制；长字符串截到 120 字，点一下展开；
- 解析失败：**原因 + 原文**都显示（半截 JSON 一眼能看出是模型没写完还是写法不对）；
- 上限：原文超过 200KB 或条目超过 2000，直接按原文显示并说明 —— 把 5MB 的 JSON 展开成树只会把标签页卡死；
- 组件是 `packages/ui/src/components/json-view.tsx`（走汇总导出），围栏只是它的一个调用方：
  后台的告警快照、工具入参出参以后也可以直接用它。

### 3.4 字符画不算"图"，正文代码块也不带行号

两个都是看真实会话发现的问题（问"画个古代朝廷的组织架构图"，模型用 ```` ```text ```` 拼了一棵
带框线的树）：

- **中文字符画必然错位**：等宽字体里中文占两格、`├─┐` 占一格，模型按"一格一个字符"排坐标，
  渲染出来就是一团乱线，前端也没法替它对齐。所以提示词里直接禁止 ASCII / 字符画拼图，
  要求结构图一律走 `xflow` / `mermaid`，实在要纯文本就用缩进列表表达层级；
- **代码块不显示行号**：`MessageResponse` 传 `lineNumbers={false}`（Streamdown 默认是 `true`）。
  聊天里的代码是读的，不是讨论第 12 行的；字符画被行号挤窄后更难读。要行号时调用方显式传。

## 4. 代码位置

| 文件 | 职责 |
| --- | --- |
| `packages/ui/src/components/ai-elements/markdown-fences/fence-spec.ts` | 纯函数：xflow 解析/排版、沙箱文档与 CSP 组装、语言清单 |
| `.../markdown-fences/sandbox-frame.tsx` | 沙箱 iframe（脚本内联、高度回报、错误兜底） |
| `.../markdown-fences/html-fence.tsx` `gsap-fence.tsx` | 两个围栏组件，共用沙箱 |
| `.../markdown-fences/xflow-fence.tsx` | 解析 + 外壳（含全屏弹窗）；画布按需加载 |
| `.../markdown-fences/xflow-layout.ts` | dagre 排版（只有画布引用它，所以不进首屏包） |
| `.../markdown-fences/xflow-canvas.tsx` | 只有这里 import `@xyflow/react` |
| `.../markdown-fences/json-fence.tsx` | `json` 围栏外壳（未闭合出占位），正文交给 `JsonView` |
| `.../markdown-fences/renderers.tsx` | `markdownFenceRenderers`：语言 → 组件，给 Streamdown 的 `plugins.renderers` |
| `packages/ui/src/components/json-view.tsx` | JSON 查看器本体（纯函数 + 树/原文两种视图），走汇总导出 |
| `packages/ui/src/components/ai-elements/message.tsx` | 注册 renderers（与 `reasoning.tsx` 共用同一份插件配置） |

放在 `ai-elements/` 下（走子路径导入、不进 `packages/ui/src/index.ts` 汇总导出）的原因：`check:ui` 对
`components/ui/` 与 `components/ai-elements/` 两个子目录不做汇总导出检查，而 React Flow / Shiki 这类重依赖
一旦进了汇总导出，任何 `import { X } from "@repo/ui"` 都会把整棵 AI 组件树拉进首屏包。

## 5. 提示词侧

围栏是"前端会渲染"的前提，模型得先知道有这些东西、以及每种的确切写法。写在
`apps/server/src/modules/ai/core/prompts/templates/partials/requirements.eta`（所有 agent 共用的一段要求），
只加"什么时候用 + 写法要点 + 不许做什么"三类信息，不展开举例，避免提示词膨胀。

## 6. 测试点

- 纯函数单测：xflow 解析（合法 / 缺字段 / 边悬空 / 非 JSON）、分层排版（列与行坐标确定、无重叠）、
  沙箱文档组装（CSP 存在、预置脚本在模型内容之前、`</script>` 转义、主题色注入）；
- 浏览器实测（headless Chrome）：沙箱文档里内置 gsap 3.15.0 就位、tween 生效、
  框内 `fetch('https://example.com')` 被 CSP 拦掉、高度回报到父页面；`xflow` 组件单独打包后
  渲染出 4 个节点 / 4 条连线、标签正确；
- 渲染冒烟：`MessageResponse` 传入未闭合围栏 → 只出现占位、不出现 iframe；闭合后 → 出现 `data-fence` 容器；
  全屏按钮开弹窗、弹窗内画布切到 `fill` + `interactive`、标题跟着进去；`html` / `gsap` 的全屏
  同样另起一个 `sandbox="allow-scripts"` 的 iframe（权限不放宽）；
- 回归：普通代码块、mermaid、块级公式的现有行为不变。

## 7. 未做 / 后续

- 围栏内容不允许外链资源（会被 CSP 拦下并显示为空），如果需要"引用真实图片"，走附件而不是围栏；
- 沙箱 iframe 目前只在 AI 会话里用；若将来预览类页面也要用，把 `SandboxFrame` 提到 `components/` 并补导出；
- `xflow` 暂不支持分组、泳道、自定义节点样式；真需要时扩 schema，而不是让模型写坐标；
- `xflow` 节点按固定尺寸（208×84）排版，描述超过两行会被截断（`line-clamp-2`）——
  需要更长文案时用 `label` 说主句、`description` 只说补充，别把一段话塞进节点。
