/**
 * 第三方样式入口的模块声明。
 *
 * `@xyflow/react/dist/style.css` 是 React Flow 画布的必需样式，
 * ai-elements 的 canvas / node / edge / controls / panel / toolbar 组件都会用到它。
 * 该包未提供 CSS 的类型声明，这里补一条最小 ambient 声明，避免 tsc 报 TS2882。
 */
declare module "@xyflow/react/dist/style.css"
