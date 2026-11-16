---
name: html-page
description: 只要产出 HTML 就用它 —— .html 页面文件（调研报告 / 数据图表 / 信息图 / 单页介绍 / 可下载文档）、聊天里的 html 围栏、gsap 动画围栏、页面里的 HTML / SVG 片段。沙箱能加载什么、第三方库怎么按「国内 → 海外 → 兜底」三级 CDN 引、样式怎么以 Tailwind 工具类为主并用 `<style>` 补位、整页怎么拆片段再用构建脚本合成单文件、交付要求都在里面。只写纯文本回答、或用 xflow / mermaid 画图时不用。
---

# 写 HTML：单文件交付、能预览、有兜底

## 适用面：只要产出 HTML 就按这份来

- **整页交付**：拆片段 → 构建成 `.html` → `file-submit`，用户在文件树里预览（推荐形态）；
- **聊天里的 `html` 围栏**：只适合小片段（整页预览已改成文件交付），沙箱与 CDN 规则相同；
- **`gsap` 动画围栏**：沙箱里已内置 gsap，**不要重复引 gsap**；其他库仍按三级 CDN 引；
- **页面里的 HTML / SVG 片段**：同上，别引白名单之外的资源。

纯文本回答、`xflow` / `mermaid` 结构图不归这份技能管。

## 预览环境：三条硬边界

- 页面跑在**沙箱 iframe**（`allow-scripts`，没有 same-origin）里，只放行**内联**的 `<style>` / `<script>`；
- 外链只认三家 CDN 上的脚本 / 样式 / 图片 / 字体：`registry.npmmirror.com` → `cdn.jsdelivr.net` → `unpkg.com`；
- **其他地址一律加载不出来**：`fetch` / XHR / WebSocket、表单、`<iframe>`、`<base>`、Google Fonts、cdnjs、
  自建图床 —— 写了只会得到一块空白，而且不会报错。所以**数据必须内联**。

地址模板、`data:` 例外、1MB 截断见 `references/sandbox.md`。

## 样式：必须用 Tailwind，覆盖不到的可补 `<style>`

- **每个页面都必须引 Tailwind CSS v4 浏览器版（`@tailwindcss/browser`），主体样式用工具类写**；
- **`<style>` 不是禁用**：动画 / 伪元素 / 打印 / 库覆盖 / `@theme` 用它补位；判据是「补位」不是「替代」；
- **字体一律无衬线，不要衬线字体**：不写 `font-serif` / 宋体 / `Noto Serif` / `Georgia`，正文用无衬线系统栈。

引导脚本、主题覆盖、字体栈写法见 `references/styles.md`。

## 交付：整页默认拆，构建成单文件

**默认就拆**：只要交付整页 `.html`，一律「骨架 + 片段 + 构建」——**不要按体积判断**（拆的是结构，不是大小）。
聊天里的 `html` / `gsap` 围栏是片段，没有工作区可构建，仍然直接写。

```
src/index.html        骨架：<head>、Tailwind、第三方库、<!-- include: ... -->
src/sections/*.html   片段：只写片段，不写 <!doctype> / <html> / <head> / <body>
dist/index.html       产物，file-submit 提交这个
```

**两条协议**：`<!-- include: sections/hero.html -->` 展开片段（路径相对当前文件）；
`<link rel="stylesheet" href="./styles/app.css">`、`<script src="./scripts/app.js"></script>` 就地内联。
片段里不要引 Tailwind / 库 / `<head>`，它们只在骨架里出现一次。

**步骤**：

1. `write-file` 写 `src/index.html` 骨架（Tailwind、库、include 指令）；
2. 每节一个 `write-file` 写进 `src/sections/`；
3. `skill_read` 读本技能的 `scripts/build-html.mjs`，**原样**落到工作区 `scripts/build-html.mjs`
   （工作区里已有就直接用，别自己重写）；
4. `bash` 跑 `node scripts/build-html.mjs`，按 JSON 报告改 `errors`，再跑；
5. `ok:true` 后 `file-submit` 提交 `dist/index.html`（`fileKey` 以 `.html` 结尾）。

先看自己的工具清单：有 `write-file` / `file-submit` 就自己写、自己提交（子助手默认也有这组工具，
工作区与父共享；每个子助手用不同文件名，避免并发覆盖）。确实没有才把整页 HTML 交回主 agent 落盘 ——
不要声称"已提交"。

**跑不了脚本时**（没有 `bash` / 命令执行被关 / 没有 node）：退化为分片写 —— `write-file` 写开头，
之后每节 `append-file` 追加，最后 `replace-file` 收尾；回答里说明这次没走构建。

目录细节、报告字段、错误码修法、子助手并行分工见 `references/build-pipeline.md`。

## 引第三方库：三级兜底

**版本写死**、**只用 UMD / IIFE 构建**、**三级都写**；一个页面 1–3 个库（Tailwind 不计入）。
三级模板、常用库表、2D / 动画 / 公式片段、加载失败兜底见 `references/libraries.md`。

## 交付前

跑一遍 `references/checklist.md` 的自检清单；常见坑也在那页。

## 参考文件

| 文件 | 什么时候读 |
| --- | --- |
| `references/build-pipeline.md` | 拆片段 / 构建报错 / 子助手并行 |
| `references/libraries.md` | 引 echarts / gsap / katex / 2D 库之前 |
| `references/styles.md` | 写 Tailwind 引导脚本 / 主题 / 字体栈 |
| `references/sandbox.md` | 不确定某个资源能不能加载 |
| `references/checklist.md` | 交付前自检 |
