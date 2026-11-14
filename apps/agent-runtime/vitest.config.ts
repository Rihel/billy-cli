import { defineConfig } from 'vitest/config'

/**
 * server 单测配置：@repo/kits 等 workspace 包 inline 处理，
 * 使 vi.mock('typeorm-transactional') 能拦截 kits re-export 的事务层
 * （@Transactional 属框架职责，测试中 mock 为 no-op）。
 */
export default defineConfig({
  test: {
    // 共库集成测试（AI 会话/流式那几份）都会写同一批表与 Redis：
    // 文件之间**串行**执行，避免互相清数据造成的偶发失败
    fileParallelism: false,
    deps: {
      inline: ['@repo/kits', '@repo/shared'],
    },
  },
})
