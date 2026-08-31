import { defineConfig } from 'vitest/config'

/**
 * server 单测配置：@repo/kits 等 workspace 包 inline 处理，
 * 使 vi.mock('typeorm-transactional') 能拦截 kits re-export 的事务层
 * （@Transactional 属框架职责，测试中 mock 为 no-op）。
 */
export default defineConfig({
  test: {
    deps: {
      inline: ['@repo/kits', '@repo/shared', '@repo/di'],
    },
  },
})
