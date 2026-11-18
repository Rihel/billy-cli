import { describe, expect, it, vi } from 'vitest'
import type { Db } from '@repo/kits'
import { ToolConfigService } from '../src/config/tool.config.service.js'

const dbWith = (row: Record<string, unknown> | null) => {
  const findOne = vi.fn(async () => row)
  return {
    db: { getRepository: () => ({ findOne }) } as unknown as Db,
    findOne,
  }
}

describe('ToolConfigService', () => {
  it('读 ai_tools：enabled / scope / limits / secrets / version', async () => {
    const { db } = dbWith({
      enabled: false,
      scope: 'admin',
      allowedAgents: ['assistant'],
      config: { timeoutMs: 1000 },
      limits: { rateLimitPerMinute: 5 },
      secrets: { apiKey: 'sk-test' },
      updatedAt: new Date('2026-11-14T00:00:00.000Z'),
    })
    const service = new ToolConfigService(db)
    await expect(service.effective('bash')).resolves.toEqual({
      enabled: false,
      scope: 'admin',
      allowedAgents: ['assistant'],
      config: { timeoutMs: 1000 },
      limits: { rateLimitPerMinute: 5 },
      secrets: { apiKey: 'sk-test' },
      version: '2026-11-14T00:00:00.000Z',
    })
  })

  it('没有配置行时回代码默认值，并缓存 5 秒', async () => {
    const { db, findOne } = dbWith(null)
    const service = new ToolConfigService(db)
    const first = await service.effective('web-fetch')
    await service.effective('web-fetch')
    expect(first).toMatchObject({ enabled: true, scope: null, version: 'code-default' })
    expect(findOne).toHaveBeenCalledTimes(1)
  })
})
