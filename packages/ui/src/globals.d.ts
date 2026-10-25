/**
 * 第三方样式入口的模块声明。
 *
 * `@xyflow/react/dist/style.css` 是 React Flow 画布的必需样式，
 * ai-elements 的 canvas / node / edge / controls / panel / toolbar 组件都会用到它。
 * 该包未提供 CSS 的类型声明，这里补一条最小 ambient 声明，避免 tsc 报 TS2882。
 */
declare module "@xyflow/react/dist/style.css"

/**
 * `katex/dist/katex.min.css` 是 KaTeX 公式的排版样式（字体、间距、上下标位置）。
 *
 * 没有它，`$$…$$` 渲染出来的是 KATEX 结构但**字形错位**：分数不叠、根号不伸、
 * 上下标挤在基线上 —— 看起来像乱码。`@streamdown/math` 只负责把公式变成 KaTeX 结构，
 * 不注入样式（`getStyles()` 返回的路径要调用方自己引）。同样该包没有 CSS 类型声明。
 */
declare module "katex/dist/katex.min.css"
