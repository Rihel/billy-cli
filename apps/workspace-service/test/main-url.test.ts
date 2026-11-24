import { describe, expect, it } from 'vitest'
import { productionMainUrlProblem } from '../src/config/main-url.js'

/**
 * 缺 MAIN_URL 的静默错连（2026-11-24）。
 *
 * 起因：compose 与 k8s 的 workspace-service 都没配 MAIN_URL，schema 里有默认值所以校验通过，
 * 容器里回落到 127.0.0.1:9989 —— 启动不报错，第一次凭据操作才 `fetch failed`。
 * 现在把「生产 / 集群里没配」提前成启动失败；本地开发与非集群自托管（显式写了值）不拦。
 */
describe('productionMainUrlProblem', () => {
  it('本地开发（非生产、非集群）：不拦', () => {
    expect(productionMainUrlProblem({ NODE_ENV: 'development' })).toBeNull()
  })

  it('生产已显式配置 MAIN_URL：放行（自托管单机写 127.0.0.1 也算配置过）', () => {
    expect(
      productionMainUrlProblem({ NODE_ENV: 'production', MAIN_URL: 'http://127.0.0.1:9989' }),
    ).toBeNull()
  })

  it('生产未配置：明确报错，并指出会回落到的地址', () => {
    const problem = productionMainUrlProblem({ NODE_ENV: 'production' })
    expect(problem).toContain('MAIN_URL')
    expect(problem).toContain('127.0.0.1:9989')
  })

  it('集群里（KUBERNETES_SERVICE_HOST 自动注入）即使 NODE_ENV 没设也拦', () => {
    expect(productionMainUrlProblem({ KUBERNETES_SERVICE_HOST: '10.0.0.1' })).toContain('MAIN_URL')
  })

  it('空白字符串视同没配', () => {
    expect(productionMainUrlProblem({ NODE_ENV: 'production', MAIN_URL: '   ' })).toContain(
      'MAIN_URL',
    )
  })
})
