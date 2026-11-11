import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * admin 的测试配置：只补一条 **`@ → src`** 的别名。
 *
 * 业务代码走 Next 的 tsconfig paths（`@/lib/...`），但 vitest 默认不读 tsconfig 的 paths。
 * 之前测试只覆盖纯函数，没触发过 `@/` 导入；工具卡开始引用 `@/lib/server-client` 后就需要它。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Next 在构建时把 `server-only` 解析成虚拟模块，vitest 里没有；
      // 指向空实现，测试才能 import 到带 `server-only` 的模块（如 lib/server-client）
      'server-only': fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url)),
    },
  },
})
