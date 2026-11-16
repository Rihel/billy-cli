# 交付前自检 + 常见坑

## 自检

- [ ] 单文件：样式 / 脚本内联，没有相对路径外链
- [ ] 版本写死；三级兜底齐全；`<\/script>` 已转义
- [ ] 引了 `katex` 时 CSS 也引了；`.html` 里的 gsap / 2D 库都自己引了（页面没有内置 gsap）
- [ ] 必须引 Tailwind 并用工具类写主体样式；`<style>` 只补 Tailwind 覆盖不到的（动画 / 伪元素 / 打印 / 库覆盖），
      没有另起一套布局体系
- [ ] **没有衬线字体**（`font-serif` / `serif` / `Songti SC` / `SimSun` / `Noto Serif SC` / `Georgia`），
      正文是无衬线系统栈
- [ ] 没有 `fetch` / XHR / 表单 / `<iframe>` / 白名单之外的域名
- [ ] 数据内联；整页 ≤1MB
- [ ] 窄屏不横向溢出（宽表格套 `overflow-x:auto`）
- [ ] 库 ≤3 个（Tailwind 不计入），去掉库之后正文仍然可读
- [ ] `file-submit` 的 `fileKey` 以 `.html` 结尾
- [ ] 整页交付跑过 `node scripts/build-html.mjs` 且 `ok:true`，提交的是 `dist/index.html`；
      片段里没有 `<!doctype>` / `<html>` / `<head>` / `<body>`，库只在骨架里引一次

## 常见坑

- 用 ```` ```html ```` 围栏把整页贴在聊天里：用户在文件树里看不到文件、也没法下载 —— 页面一律走 `.html` 文件；
- 只写一级 CDN：目标网络恰好不可达时整页空白，而三级兜底的成本只有两行；
- 用了 `font-serif` / 宋体：中文衬线在预览里会回退成系统宋体、屏幕发虚，统一换 `font-sans`；
- 整页不引 Tailwind、只用 `<style>` 写：不符合「必须用 Tailwind」，`<style>` 是补位不是替代；
- 只引 Tailwind 不写降级基础样式：CDN 全挂时整页白纸（基础样式只保底，不替代 Tailwind）；
- `.html` 里直接写 `gsap.to(...)`：页面没有内置 gsap（那是 `gsap` 围栏的特权），会报 `gsap is not defined`
  —— 自己按三级兜底引，或改用 CSS 动画；
- 引了 `katex.min.js` 忘了 `katex.min.css`：公式退化成一串裸 LaTeX 文本，看着像"库没生效"；
- 拆了片段但直接提交 `src/index.html`：交上去的是带 `<!-- include: ... -->` 注释的骨架，页面缺内容 ——
  先构建，提交 `dist/index.html`；
- 片段里又引了一次 Tailwind / echarts：Tailwind 被初始化多次、库重复加载，表现为"样式有但慢、图表闪一下重画" ——
  库只在骨架引一次；
- 设计感要求高时先加载设计 / 前端类技能再动手，本技能只保证**能跑、能引库、能交付**。
