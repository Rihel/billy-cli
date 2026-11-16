# 样式：Tailwind 必用，`<style>` 补位

## 规则

**每个页面都必须引 Tailwind CSS v4 浏览器版（`@tailwindcss/browser`），主体样式用工具类写**：
结构 / 间距 / 字号 / 颜色 / 圆角 / 栅格优先落在 `class` 上；不引 Bootstrap / Pico 这类第二套 CSS 框架。

**`<style>` 不是禁用**：Tailwind 覆盖不到、或表达起来别扭的地方，直接写 CSS —— 自定义动画 /
`@keyframes`、复杂选择器与伪元素、`@media print` 等全局规则、第三方库（echarts / mermaid）的样式覆盖、
`@theme` 主题变量。判据是「补位」不是「替代」：`<style>` 不该重造一套布局 / 组件类体系来绕开工具类，
也不能整页只有 `<style>`、没有 Tailwind 类。

## Tailwind 引导脚本（三级兜底）

它走和别的库同一套 CDN：

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
- 版本写死 `4.3.5`；三家的包内路径都是 `dist/index.global.js`；**别只写一条 CDN**（断一家就丢栅格）；
- 主题覆盖用 `<style type="text/tailwindcss">@theme { --font-sans: … }</style>`；
- **Tailwind 必引必用**（整页、`html` 围栏、页面片段都算）：主体布局与排版落在工具类上，
  没引它按「样式没写完」处理；
- `<style>` 负责补 Tailwind 的短板，同时留一点降级基础样式（页面背景 / 文字色 / 字体栈），
  CDN 全挂时不至于白纸；Tailwind 不计入「1–3 个库」的上限，但别再引第二套 CSS 框架。

## 字体

**一律无衬线，不要衬线字体。** 中文衬线（宋体 / Noto Serif）在预览里没有字体文件可依赖，
会回退成系统宋体、在屏幕上发虚，和后台的现代观感也不一致：`font-sans` 可以用，但
`font-serif`、`font-family: serif`、`Songti SC`、`SimSun`、`Noto Serif SC`、`Source Han Serif`、
`Georgia`、`Times New Roman` 一律不要写。正文给无衬线系统栈：
`-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`。
