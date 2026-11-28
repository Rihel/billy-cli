# 引第三方库：三级兜底

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
| 2D 绘制（矢量 / SVG） | `@svgdotjs/svg.js@3.2.8` | `dist/svg.min.js` | `SVG` |
| 2D 绘制（Canvas / 交互） | `konva@10.9.1` | `konva.min.js` | `Konva` |
| 动画 | `gsap@3.15.1` | `dist/gsap.min.js` | `gsap` |
| 公式 | `katex@0.19.1` | `dist/katex.min.js` | `katex` |
| 日期 | `dayjs@1.11.13` | `dayjs.min.js` | `dayjs` |
| 图标 | `lucide@0.469.0` | `dist/umd/lucide.min.js` | `lucide` |
| 流程图（重，2.5MB） | `mermaid@11.4.1` | `dist/mermaid.min.js` | `mermaid` |

表里没有的库：先确认包里有 UMD 构建（`dist/*.umd*.js` / `*.min.js`），再用同一套模板；
路径不确定时不要猜 `index.js` —— 404 之后是静默空白。

## 2D 绘制 / 动画 / 公式：先选形态，再抄片段

- **2D 绘制先分两种，选错白费**：要矢量（放大不糊、文字可选中、能打印）→ `SVG.js`，
  `var draw = SVG().addTo('#drawing').size(600, 400)` 起手，之后 `draw.circle(...)` / `draw.path(...)` / `draw.text(...)`；
  要拖拽 / 命中检测 / 大量对象 / 导出位图 → `Konva`（Canvas 渲染，文字不可选中、导出是位图），
  `new Konva.Stage({ container: 'drawing', width: 600, height: 400 })` 起手。
  两者都**不是图表库**（图表用 echarts / Chart.js）；原生 SVG 能画清楚的就别引库。
- **`.html` 页面里没有内置 gsap**：内置 gsap 只给 `gsap` 围栏用，`.html` 里要动画得自己按三级兜底引；
  CSS `transition` / `@keyframes` 够用就别引，要时间线 / 错峰 / 滚动触发再上 gsap
  （插件同包：`dist/ScrollTrigger.min.js`，引法相同）。
- **公式用 `katex`：JS 和 CSS 都要引**，字体写在 CSS 的相对路径里、跟着 CSS 那家 CDN 走；
  KaTeX **默认不扫描页面**，所以把 LaTeX 放 `data-tex` 属性再 `katex.render`（或另引
  `dist/contrib/auto-render.min.js` 后调 `renderMathInElement`）。只引 JS 不引 CSS，公式会退化成裸文本。

```html
<!-- 公式：JS / CSS 都三级兜底（字体跟着 CSS 走） -->
<link rel="stylesheet" href="https://registry.npmmirror.com/katex/0.19.1/files/dist/katex.min.css"
      onerror="this.onerror=function(){this.href='https://unpkg.com/katex@0.19.1/dist/katex.min.css'};this.href='https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.css'">
<script src="https://registry.npmmirror.com/katex/0.19.1/files/dist/katex.min.js"></script>
<script>window.katex||document.write('<script src="https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.js"><\/script>')</script>
<script>window.katex||document.write('<script src="https://unpkg.com/katex@0.19.1/dist/katex.min.js"><\/script>')</script>

<p class="text-center text-lg" data-tex="\int_0^1 x^2\,\mathrm{d}x = \tfrac{1}{3}"></p>
<script>
  document.querySelectorAll('[data-tex]').forEach(function (el) {
    var tex = el.getAttribute('data-tex')
    if (!window.katex) { el.textContent = tex; return }
    try { katex.render(tex, el, { throwOnError: false }) } catch (e) { el.textContent = tex }
  })
</script>
```

LaTeX 写在 `data-tex` 里、不写进 JS 字符串，省掉反斜杠二次转义；容器里先放一句纯文本，库没来也读得懂。

## 库没加载出来时也要看得见

三级 CDN 全挂（内网 / 断网）是真实场景。所以：

- 正文、表格、结论用原生 HTML + Tailwind 类写死，库只负责**增强**（图表、图标）；
- 图表容器里先放一句说明 + 一张原生 `<table>`（"图表依赖 echarts；加载失败时以下面的数据表为准"）；
- 不要整页只挂一个 `<canvas>`：库不出现就是一块白。
