import { describe, expect, it } from 'vitest'
import { AiProviderKind } from '@repo/shared'
import {
  DEFAULT_PROVIDER_BASE_URLS,
  PROVIDER_ENDPOINTS,
  listProviderModels,
} from '../src/sync/provider-adapters.js'

describe('provider-adapters 错误与默认地址', () => {
  it('不支持列模型的厂商：不发请求，直接明确提示', async () => {
    await expect(
      listProviderModels({ kind: AiProviderKind.Spark, apiKey: 'sk-test' }),
    ).rejects.toMatchObject({ code: 3403 })
    await expect(
      listProviderModels({ kind: AiProviderKind.Spark, apiKey: 'sk-test' }),
    ).rejects.toThrow(/该供应商不支持自动拉取模型明细/)
  })

  it('未知 kind / 没有默认地址：发请求前拦住', async () => {
    await expect(listProviderModels({ kind: 'not-a-vendor', apiKey: 'sk-test' })).rejects.toThrow(
      /不支持的供应商类型/,
    )
    await expect(
      listProviderModels({ kind: AiProviderKind.OpenaiCompatible, apiKey: 'sk-test' }),
    ).rejects.toThrow(/必须配置 baseUrl/)
  })

  it('默认地址表：兼容路径与无默认地址的兜底项', () => {
    expect(DEFAULT_PROVIDER_BASE_URLS[AiProviderKind.Deepseek]).toBe('https://api.deepseek.com')
    expect(PROVIDER_ENDPOINTS[AiProviderKind.Dashscope].baseUrl).toContain('/compatible-mode/v1')
    expect(PROVIDER_ENDPOINTS[AiProviderKind.Volcengine].baseUrl).toContain('/api/v3')
    expect(PROVIDER_ENDPOINTS[AiProviderKind.Zhipu].baseUrl).toContain('/api/paas/v4')
    expect(DEFAULT_PROVIDER_BASE_URLS[AiProviderKind.OpenaiCompatible]).toBeUndefined()
    expect(PROVIDER_ENDPOINTS[AiProviderKind.Spark].supportsModelList).toBe(false)
  })
})
