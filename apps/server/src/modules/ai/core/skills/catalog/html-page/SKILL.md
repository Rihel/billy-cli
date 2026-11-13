---
name: html-page
description: 只要产出 HTML 就用它 —— .html 页面文件（调研报告 / 数据图表 / 信息图 / 单页介绍 / 可下载文档）、聊天里的 html 围栏、gsap 动画围栏、页面里的 HTML / SVG 片段。沙箱能加载什么、第三方库怎么按「国内 → 海外 → 兜底」三级 CDN 引、单文件与交付要求都在里面。只写纯文本回答、或用 xflow / mermaid 画图时不用。
---

# 写 HTML：单文件、能预览、有兜底

## 适用面：只要产出 HTML 就按这份来

- **整页交付**：写 `.html` 文件 → `file-submit`，用户在文件树里预览（推荐形态，本文其余部分以它为主）；
- **聊天里的 `html` 围栏**：只适合小片段（整页预览已改成文件交付），沙箱与 CDN 规则相同；
- **`gsap` 动画围栏**：沙箱里已内置 gsap，**不要重复引 gsap**；其他库仍按三级 CDN 引；
- **页面里的 HTML / SVG 片段**：同上，别引白名单之外的资源。

纯文本回答、`xflow` / `mermaid` 结构图不归这份技能管。

## 预览环境的三条硬边界

页面在后台的**沙箱 iframe** 里跑（`sandbox="allow-scripts"`，没有 same-origin），CSP 只放行两类资源：

1. 内联的 `<style>` / `<script>`；
2. 下面三家 CDN 上的脚本 / 样式 / 图片 / 字体 / 音视频：

| 顺位 | CDN | 同一个文件的地址 |
| --- | --- | --- |
| 国内 | `registry.npmmirror.com` | `https://registry.npmmirror.com/<包>/<版本>/files/<包内路径>` |
| 海外 | `cdn.jsdelivr.net` | `https://cdn.jsdelivr.net/npm/<包>@<版本>/<包内路径>` |
| 兜底 | `unpkg.com` | `https://unpkg.com/<包>@<版本>/<包内路径>` |

**其他地址一律加载不出来**：`fetch` / XHR / WebSocket、表单提交、`<iframe>`、`<base>`、
Google Fonts、cdnjs、GitHub raw、自建图床 —— 写了只会得到一块空白，而且不会报错。

推论：**数据必须内联**（把 JSON 直接写进 `<script>`，或先渲染成 HTML 节点），页面不能自己去请求接口。

## 样式：Tailwind 写布局，字体一律无衬线

结构 / 间距 / 排版用 **Tailwind CSS v4 浏览器版**（`@tailwindcss/browser`：加载后扫描 DOM 并注入样式），
不要引 Bootstrap / Pico 这类第二套 CSS 框架，也不要把一堆一次性 CSS 写在 `<style>` 里。
它走同一套三级 CDN：

```html
<script>
  ;(function () {
    var urls = [
      'https://registry.npmmirror.com/@tailwindcss/browser/4.3.5/files/dist/index.global.js',
      'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.5/dist/index.global.js',
      'https://unpkg.com/@tailwindcss/browser@4.3.5/dist/index.global.js'
    ]
    var i = 0
    ;(function next() {
      var s = document.createElement('script')
      s.src = urls[i]
      s.onerror = function () {
        i += 1
        if (i < urls.length) next()
      }
      document.head.appendChild(s)
    })()
  })()
</script>
```

- **它没有全局变量**（不像 `echarts` / `Chart`）：三级兜底只能挂 `onerror`，别写 `window.tailwind` 判断；
- 版本写死 `4.3.5`；三家的包内路径都是 `dist/index.global.js`；
- 主题覆盖用 `<style type="text/tailwindcss">@theme { --font-sans: … }</style>`；
- **Tailwind 只是增强**：`<style>` 里仍要写最小基础样式（页面背景、文字色、字体栈、打印），
  否则 CDN 全挂时整页是一张白纸；Tailwind 不计入「1–3 个库」的上限，但别再引第二套 CSS 框架。

**字体一律无衬线，不要衬线字体。** 中文衬线（宋体 / Noto Serif）在预览里没有字体文件可依赖，
会回退成系统宋体、在屏幕上发虚，和后台的现代观感也不一致：`font-sans` 可以用，但
`font-serif`、`font-family: serif`、`Songti SC`、`SimSun`、`Noto Serif SC`、`Source Han Serif`、
`Georgia`、`Times New Roman` 一律不要写。正文给无衬线系统栈：
`-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`。

## 交付流程

1. 先看有没有设计 / 前端类技能要加载（见系统提示词「要求」段），再动手；
2. 用 `write-file` 把整页写进 workspace 的一个文件，例如 `report.html`；
3. 用 `file-submit` 提交：`filePath` 是 workspace 路径，`fileKey` 是会话内路径（如 `reports/q3.html`）；
4. 回答里说清文件名与怎么看（点文件树里的 `.html` 预览）。

子 agent 一般**没有**文件工具（`write-file` / `file-submit` 都是主 agent 才有的）：那就把整页 HTML
作为结果交回，由主 agent 落盘提交 —— 不要声称"已提交"。

**单文件**：样式写 `<style>`、脚本写 `<script>`，不要 `./style.css` / `./app.js` ——
预览里没有第二份文件，相对路径必然落空。预览只读文本的前 1MB，超过会被截断：
大表先聚合 / 抽样，别把几万行原始数据塞进来。

## 引第三方库：三级兜底

三条规矩：**版本写死**、**只用 UMD / IIFE 构建**、**三级都写**。

```html
<script src="https://registry.npmmirror.com/echarts/5.4.3/files/dist/echarts.min.js"></script>
<script>window.echarts||document.write('<script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"><\/script>')</script>
<script>window.echarts||document.write('<script src="https://unpkg.com/echarts@5.4.3/dist/echarts.min.js"><\/script>')</script>
```

- 三条地址是**同一个包内路径**（`dist/echarts.min.js`），只是前缀与版本写法不同；换库只换包名、版本、路径、全局变量；
- 检测的是**全局变量**（`echarts` / `Chart` / `dayjs` / `lucide` / `mermaid`），不是包名；
- 内联脚本里的 `</script>` 必须写成 `<\/script>`，否则浏览器把它当成结束标签，脚本被截断；
- 不要用 `?module`、`/+esm`、`type="module"` + `import`：沙箱是不透明源，裸包名解析不了；
- 一个页面 **1–3 个库**：能用原生 CSS / SVG 画出来的就别引库。

## 常用库（入口已实测可达）

| 用途 | 包 | 包内路径 | 全局变量 |
| --- | --- | --- | --- |
| 图表（功能全） | `echarts@5.4.3` | `dist/echarts.min.js` | `echarts` |
| 图表（轻） | `chart.js@4.5.0` | `dist/chart.umd.min.js` | `Chart` |
| 日期 | `dayjs@1.11.13` | `dayjs.min.js` | `dayjs` |
| 图标 | `lucide@0.469.0` | `dist/umd/lucide.min.js` | `lucide` |
| 流程图（重，2.5MB） | `mermaid@11.4.1` | `dist/mermaid.min.js` | `mermaid` |

表里没有的库：先确认包里有 UMD 构建（`dist/*.umd*.js` / `*.min.js`），再用同一套模板；
路径不确定时不要猜 `index.js` —— 404 之后是静默空白。

## 库没加载出来时也要看得见

三级 CDN 全挂（内网 / 断网）是真实场景。所以：

- 正文、表格、结论用原生 HTML / CSS 写死，库只负责**增强**（图表、图标）；
- 图表容器里先放一句说明 + 一张原生 `<table>`（"图表依赖 echarts；加载失败时以下面的数据表为准"）；
- 不要整页只挂一个 `<canvas>`：库不出现就是一块白。

## 交付前自检

- [ ] 单文件：样式 / 脚本内联，没有相对路径外链
- [ ] 版本写死；三级兜底齐全；`<\/script>` 已转义
- [ ] 样式用 Tailwind（`@tailwindcss/browser` 版本写死 + `onerror` 三级兜底），且 `<style>` 里有基础样式兜底
- [ ] **没有衬线字体**（`font-serif` / `serif` / `Songti SC` / `SimSun` / `Noto Serif SC` / `Georgia`），正文是无衬线系统栈
- [ ] 没有 `fetch` / XHR / 表单 / `<iframe>` / 白名单之外的域名
- [ ] 数据内联；整页 ≤1MB
- [ ] 窄屏不横向溢出（宽表格套 `overflow-x:auto`）
- [ ] 库 ≤3 个（Tailwind 不计入），去掉库之后正文仍然可读
- [ ] `file-submit` 的 `fileKey` 以 `.html` 结尾

## 常见坑

- 用 ```` ```html ```` 围栏把整页贴在聊天里：用户在文件树里看不到文件、也没法下载 —— 页面一律走 `.html` 文件；
- 只写一级 CDN：目标网络恰好不可达时整页空白，而三级兜底的成本只有两行；
- 用了 `font-serif` / 宋体：中文衬线在预览里会回退成系统宋体、屏幕发虚，统一换 `font-sans`；
- 只引 Tailwind 不写基础样式：CDN 全挂时整页白纸（Tailwind 是增强，不是地基）；
- 设计感要求高时先加载设计 / 前端类技能再动手，本技能只保证**能跑、能引库、能交付**。
