import { describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import { SkillSyncService } from '../src/modules/ai-admin/skill/skill-sync.service.js'

/** 技能集合变更传播（§6.7.4）：只推运行中的工作区，失败只告警（ensure 兜底） */
const make = (states: Record<string, string>, syncImpl?: () => Promise<unknown>) => {
  const db = {
    getRepository: () => ({
      find: vi.fn(async () => Object.keys(states).map((id) => ({ id }))),
    }),
  }
  const port = {
    status: vi.fn(async (id: string) => ({ state: states[id] ?? 'stopped' })),
    sync: vi.fn(syncImpl ?? (async () => ({}))),
  }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
  const service = new SkillSyncService(db as never, port as never, logger)
  return { service, port, logger }
}

describe('SkillSyncService', () => {
  it('运行中的推送、停止的跳过', async () => {
    const { service, port } = make({ ws_a: 'running', ws_b: 'stopped' })

    const result = await service.push([
      { principalType: 'user', principalId: 'u_1' },
      { principalType: 'user', principalId: 'u_2' },
    ])

    expect(result).toEqual({ pushed: 1, failed: 0 })
    expect(port.sync).toHaveBeenCalledWith('ws_a')
  })

  it('失败进日志、不抛出（最终一致交给 ensure）', async () => {
    const { service, logger } = make({ ws_a: 'running' }, async () => {
      throw new Error('down')
    })

    const result = await service.push([{ principalType: 'user', principalId: 'u_1' }])

    expect(result).toEqual({ pushed: 0, failed: 1 })
    expect(logger.warn).toHaveBeenCalled()
  })

  it('全员授权（all）→ 广播到全部工作区（仍只推运行中的）', async () => {
    const { service, port } = make({ ws_a: 'running', ws_b: 'stopped' })
    await expect(service.push([{ principalType: 'all', principalId: '*' }])).resolves.toEqual({
      pushed: 1,
      failed: 0,
    })
    expect(port.sync).toHaveBeenCalledWith('ws_a')
    expect(port.sync).not.toHaveBeenCalledWith('ws_b')
  })
})
