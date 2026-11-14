import { describe, expect, it } from 'vitest'
import type { AiModelEntity, AiProviderEntity } from '@repo/db'
import { buildCatalog } from '../src/catalog/model.catalog.service.js'

const provider = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'p1',
    name: '本地 Ollama',
    slug: 'ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    apiKey: null,
    enabled: true,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  }) as unknown as AiProviderEntity

const model = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'm1',
    providerId: 'p1',
    modelKey: 'qwen3.8:27b',
    displayName: 'Qwen',
    contextWindow: 262144,
    mode: 'chat',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    enabled: true,
    ...overrides,
  }) as unknown as AiModelEntity

describe('模型目录构建', () => {
  it('只收对话类，按 modelKey 排序，默认取第一条，并带上协议', () => {
    const { catalog, targets } = buildCatalog(
      [provider()],
      [
        model({ id: 'm2', modelKey: 'zzz' }),
        model({ id: 'm3', modelKey: 'embed', mode: 'embedding' }),
        model({ id: 'm1', modelKey: 'aaa' }),
      ],
    )
    expect(catalog.models.map((item) => item.modelKey)).toEqual(['aaa', 'zzz'])
    expect(catalog.defaultModelId).toBe('m1')
    expect(catalog.models[0].protocol).toBe('ollama')
    expect(targets.get('m1')?.baseUrl).toBe('http://127.0.0.1:11434')
  })

  it('unknown 类型照列（国内厂商多数不声明）', () => {
    const { catalog } = buildCatalog([provider()], [model({ mode: 'unknown' })])
    expect(catalog.models).toHaveLength(1)
    expect(catalog.models[0].mode).toBe('unknown')
  })

  it('供应商未启用 / 模型没有对应供应商：不进目录', () => {
    const disabled = provider({ id: 'p2', enabled: false })
    const orphan = model({ id: 'm9', providerId: 'missing' })
    const { catalog } = buildCatalog([provider(), disabled], [orphan])
    expect(catalog.models).toHaveLength(0)
    expect(catalog.defaultModelId).toBeNull()
  })
})
