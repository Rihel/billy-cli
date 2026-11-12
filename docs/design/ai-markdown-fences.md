# 富内容围栏：让模型直接表达图、页面与动画

> 定位：AI 会话里「模型写一段带语言标识的代码块 → 前端渲染成看得见的东西」这一层的设计与取舍。
> 现状基线：`MessageResponse`（Streamdown 2.6）已经支持 ```ts 代码高亮、```mermaid 图、`$$…$$` 块级公式；
> 本文补齐 **xflow（流程图）、html（页面预览）、gsap（动画）** 三类，并修掉公式样式缺失。
>
> **2026-11-11 变更**：`html` 围栏**退役** —— 页面预览改走「`.html` 文件 + 文件管理预览」
> （`ai-file-manager.md` §8.4）；`gsap` / `json` **保留**，它们只在输出里直接看效果，不产出文件。

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
| ```` ```html ```` | 沙箱 iframe 里的真实页面 | **已退役（2026-11-11）** → 走文件管理 |
| ```` ```gsap ```` | 沙箱 iframe + 内置 gsap 的动画 | 保留（行内看效果） |
| ```` ```json ```` | 可折叠的 JSON 树（原文 / 复制可切） | 保留（行内看效果） |

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

### 3.2 gsap：沙箱 iframe（`html` 围栏已退役）

`html` 围栏在 2026-11-11 退役：**页面预览改走文件管理** —— AI 把页面写成 `.html` 文件，
`file-submit` 上传，用户在文件树的预览弹窗里看；预览同样走沙箱（见 `ai-file-manager.md` §8.4）。
`SandboxFrame` 不删：`gsap` 围栏与 HTML 文件预览共用它。

模型写的 `<script>` 要真跑起来，才有"动画能动"这回事。但它**不能**拿到后台页面的权限。

- `sandbox="allow-scripts"`，**不带 `allow-same-origin`** → iframe 是不透明源，拿不到父页面的 DOM、cookie、localStorage；
- iframe 内 `Content-Security-Policy`：`default-src 'none'`，只放行内联样式/脚本、`data:`/`blob:` 图片，
  以及 **CDN 白名单**（见下）上的脚本 / 样式 / 图片 / 字体；`fetch`、表单提交、嵌套框架全部禁止 ——
  模型写的代码能把图画出来，但**发不出去**；
- 外链库（gsap）由**父页面同源 fetch 后内联**进文档，不依赖 iframe 的网络权限；注入位置在
  **模型内容之前**（`<head>`）—— 放到后面时，模型自己的 `<script>` 先执行，实测直接 `gsap is not defined`；
- 高度由 iframe 内 `ResizeObserver` 经 `postMessage` 回报，父页面校验 `event.source` 后夹在 120–560px 之间（超出滚动）；
- **全屏**与 xflow 同一套弹窗（92vh × 96vw）：里面是**另一份文档**、另一个 iframe，沙箱参数一字不改 ——
  所以脚本从头再跑一遍，正好用来重看动画；原来的 iframe 不销毁，关掉弹窗就回到它。

#### CDN 白名单（2026-11-12）

沙箱原先"全禁网"，页面里连图表库都引不进来，模型只能手写 canvas / SVG —— 用户要的
"写页面能用第三方库"就落不了地。现在改为**白名单放行**，清单是
`packages/shared/src/utils/cdn.utils.ts` 的 `SANDBOX_CDN_HOSTS` —— 一份清单两个消费方：
`fence-spec.ts` 拼 CSP，`apps/server/test/ai-prompt-guardrails.test.ts` 校验提示词与它一致。

| 顺位 | 主机 | 路径 |
| --- | --- | --- |
| 国内 | `registry.npmmirror.com` | `/<包>/<版本>/files/<包内路径>` |
| 海外 | `cdn.jsdelivr.net` | `/npm/<包>@<版本>/<包内路径>` |
| 兜底 | `unpkg.com` | `/<包>@<版本>/<包内路径>` |

- 三家都覆盖全部 npm 包、都能按包内路径取到同一个文件（2026-11-12 实测 `echarts@5.4.3` 均 200、
  字节数一致）；老牌国产 CDN（staticfile / bootcdn）只收录热门库、路径规则还不一样，不作为默认；
- **只放行四类子资源**（脚本 / 样式 / 图片 / 字体），`connect-src 'none'` / `form-action 'none'` /
  `frame-src 'none'` 一个没松 —— 所以能"用库画图"，不能"把数据发出去"，最坏情况也只能把数据
  发到这几家 CDN 自己的日志里；
- 加载失败要**三级兜底**：原生 `<script>` 没法感知"加载超时再换源"，提示词因此要求
  `window.<全局名> || document.write(...)` 逐级补 —— 写法见 `requirements.eta`，这是模型最容易写错的一处；
- 升级 / 增删主机时三处一起改：白名单常量、`requirements.eta` 的 CDN 段、两个包的测试。

`gsap` 围栏保留；`html` 不再有围栏组件，但它的沙箱复用给文件预览。gsap 文件放
`apps/admin/public/vendor/gsap.min.js`（随包提交），`apps/admin` 用脚本 `pnpm sync:vendor`
从 node_modules 重新复制，升级版本不靠手抄。

### 3.3 流式行为：没闭合就不渲染

`xflow` / `gsap` 在**围栏未闭合**时只显示一行"正在生成"占位，闭合后才渲染。理由有两条，都是实践结论：

- `gsap` 每来一个 token 就重建 iframe，等于把脚本反复重跑 —— 动画永远卡在第一帧，控制台反复报错；
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
| `.../markdown-fences/sandbox-frame.tsx` | 沙箱 iframe（脚本内联、高度回报、错误兜底）；`gsap` 围栏与 HTML 文件预览共用 |
| `.../markdown-fences/html-fence.tsx` | **软退役**：prompt 已移除；组件保留给历史消息，页面预览改走文件管理 |
| `.../markdown-fences/gsap-fence.tsx` | 动画围栏，使用沙箱 |
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

`html` 围栏退役后，prompt 里的 `html` bullet 改为"要页面预览就写 `.html` 文件并用 `file-submit` 提交"；
`xflow` / `mermaid` / `gsap` / `json` / 公式的说明保留。切换顺序：先让文件树能沙箱预览 `.html`，
再摘 prompt / renderer，避免中间态模型没有页面预览能力。

**页面写法搬进内置技能**（2026-11-12）：HTML 页面的详细做法（单文件、CDN 三级兜底、常用库入口、
交付前自检）做成随包技能 `core/skills/catalog/html-page/SKILL.md`；prompt 只留
「写任何 HTML 之前先加载 `html-page`」（**无条件段**：`.html` 文件、`html` / `gsap` 围栏、
HTML / SVG 片段都算）+ 三行白名单边界。理由：这些细节只在**写页面那一轮**有用，而 prompt 是
每轮都付的前缀 token；技能是按需加载的（渐进披露）。代价是"模型可能不加载"，所以用
`ai-prompt-guardrails.test.ts` 钉住指针（技能名 + 白名单必须在提示词里）、`ai-builtin-skills.test.ts`
钉住技能正文与 `SANDBOX_CDN_HOSTS` 一致。

## 6. 测试点

- 纯函数单测：xflow 解析（合法 / 缺字段 / 边悬空 / 非 JSON）、分层排版（列与行坐标确定、无重叠）、
  沙箱文档组装（CSP 存在、预置脚本在模型内容之前、`</script>` 转义、主题色注入）；
- 浏览器实测（headless Chrome）：沙箱文档里内置 gsap 3.15.0 就位、tween 生效、
  框内 `fetch('https://example.com')` 被 CSP 拦掉、高度回报到父页面；`xflow` 组件单独打包后
  渲染出 4 个节点 / 4 条连线、标签正确；
- 渲染冒烟：`MessageResponse` 传入未闭合围栏 → 只出现占位、不出现 iframe；闭合后 → 出现 `data-fence` 容器；
  全屏按钮开弹窗、弹窗内画布切到 `fill` + `interactive`、标题跟着进去；`gsap` 的全屏
  同样另起一个 `sandbox="allow-scripts"` 的 iframe（权限不放宽）；
- 回归：普通代码块、mermaid、块级公式的现有行为不变。

## 7. 未做 / 后续

- 外链资源只认 CDN 白名单（其余地址会被 CSP 拦下并显示为空）；页面里要"引用真实图片"，仍然走附件，
  不要塞第三方图床地址；
- **HTML 文件预览**要用沙箱：把 `SandboxFrame` 从 `ai-elements/markdown-fences/` 提到
  `packages/ui/components/` 并补导出（`ai-file-manager.md` §8.4）；这是 `html` 围栏退役的前提；
- `xflow` 暂不支持分组、泳道、自定义节点样式；真需要时扩 schema，而不是让模型写坐标；
- `xflow` 节点按固定尺寸（208×84）排版，描述超过两行会被截断（`line-clamp-2`）——
  需要更长文案时用 `label` 说主句、`description` 只说补充，别把一段话塞进节点。
