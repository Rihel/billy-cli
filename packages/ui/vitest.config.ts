import { defineConfig } from 'vitest/config'

/**
 * `@repo/ui` 单测配置。
 *
 * - `environment: 'jsdom'`：hook / 组件级测试需要 DOM（纯逻辑测试跑在同一环境无副作用）；
 * - 不需要额外配置 JSX：vitest 4 用 oxc 转换（自动识别 tsconfig 的 `jsx`），
 *   显式再设 `esbuild.jsx` 会被忽略并告警；
 * - `#components/*` / `#lib/*` / `#hooks/*` 子路径导入依赖 package.json 的 `imports`
 *   字段，vite 原生支持，无需 alias。
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
  },
})
