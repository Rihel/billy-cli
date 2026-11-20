import { describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import { MarketItemSaveSchema, AppErrorCodes } from '@repo/shared'
import { MarketService } from '../src/modules/ai-market/market.service.js'
import type { MarketRepository } from '../src/modules/ai-market/market.repository.js'

/** AI 市场 v1（§6.9）：只收录 MCP，scope 固定平台；key 唯一 upsert；删除缺条目报 3501 */
const make = () => {
  const rows = new Map<string, Record<string, unknown>>()
  const repo = {
    list: vi.fn(async () => [...rows.values()]),
    findByKey: vi.fn(async (key: string) => rows.get(key) ?? null),
    upsert: vi.fn(async (data: Record<string, unknown>) => {
      const existing = rows.get(String(data.key))
      const row = {
        id: 'mkt_1',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...existing,
        ...data,
      }
      rows.set(String(data.key), row)
      return row
    }),
    softRemove: vi.fn(async (key: string) => rows.delete(key)),
  }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
  return { service: new MarketService(repo as unknown as MarketRepository, logger), repo }
}

describe('市场条目 schema', () => {
  it('v1 拒绝非 MCP 条目（CLI / 技能随用户端开放）', () => {
    expect(MarketItemSaveSchema.safeParse({ key: 'x', name: 'x', type: 'cli' }).success).toBe(false)
    expect(
      MarketItemSaveSchema.safeParse({ key: 'x', name: 'x', type: 'mcp', payload: {} }).success,
    ).toBe(true)
  })
})

describe('MarketService', () => {
  it('收录 MCP 条目：scope 固定 platform（不接受入参指定）', async () => {
    const { service } = make()

    const item = await service.save({
      key: 'docs-mcp',
      name: '文档服务',
      type: 'mcp',
      payload: { service: 'docs' },
    })

    expect(item).toMatchObject({ key: 'docs-mcp', type: 'mcp', scope: 'platform' })
  })

  it('同一 key 再次收录 = 更新（幂等）', async () => {
    const { service } = make()
    await service.save({ key: 'docs-mcp', name: '旧名', type: 'mcp', payload: {} })

    const item = await service.save({ key: 'docs-mcp', name: '新名', type: 'mcp', payload: {} })

    expect(item.name).toBe('新名')
    await expect(service.list({})).resolves.toHaveLength(1)
  })

  it('删除不存在的条目 → 3501', async () => {
    const { service } = make()
    await expect(service.remove({ key: 'nope' })).rejects.toMatchObject({
      code: AppErrorCodes.MarketItemNotFound,
    })
  })
})
