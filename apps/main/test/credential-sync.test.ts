import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import { credentialVersionOf } from '@repo/shared'
import {
  CredentialSyncService,
  type WorkspaceSyncPort,
} from '../src/modules/ai-admin/credential/credential-sync.service.js'
import type { PersonalCredentialRepository } from '../src/modules/ai-admin/credential/credential.repository.js'

/**
 * 凭据变更传播（`docs/design/workspace-cli-credentials.md` §6.4.6）。
 *
 * 钉三件事：**只查不起**（只对运行中的工作区推送）、**版本一致**（与执行面同一函数算）、
 * **失败重试**（吊销给更多次，因为旧凭据仍然可用）。
 */

const OWNER = { ownerType: 'user' as const, ownerId: 'u_1' }

const makeService = (options: {
  workspaces?: string[]
  states?: Record<string, string>
  syncImpl?: (workspaceId: string) => Promise<{ credentialVersion: string }>
  versions?: { version: number }[]
}) => {
  const workspaces = options.workspaces ?? ['ws_a', 'ws_b']
  const db = {
    getRepository: () => ({
      find: vi.fn(async () => workspaces.map((id) => ({ id }))),
    }),
  }
  const credentials = {
    listActiveVersions: vi.fn(async () => options.versions ?? [{ version: 1 }]),
  }
  const port: WorkspaceSyncPort = {
    status: vi.fn(async (workspaceId: string) => ({
      state: options.states?.[workspaceId] ?? 'running',
    })),
    sync: vi.fn(
      options.syncImpl ?? (async (_workspaceId: string) => ({ credentialVersion: '0-0' })),
    ),
  }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
  const service = new CredentialSyncService(
    db as never,
    credentials as unknown as PersonalCredentialRepository,
    port,
    logger,
  )
  return { service, port, credentials, logger }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('只查不起：只推送正在运行的工作区', () => {
  it('运行中的推送、停止的跳过；状态查询覆盖全部候选', async () => {
    const { service, port } = makeService({
      workspaces: ['ws_run', 'ws_stop', 'ws_unknown'],
      states: { ws_run: 'running', ws_stop: 'stopped', ws_unknown: 'unknown' },
      versions: [{ version: 2 }],
    })

    const result = await service.push(OWNER, 'bind')

    expect(port.status).toHaveBeenCalledTimes(3)
    expect(port.sync).toHaveBeenCalledTimes(1)
    expect(port.sync).toHaveBeenCalledWith('ws_run', credentialVersionOf([{ version: 2 }]))
    expect(result).toEqual({ pushed: 1, failed: 0, skipped: 2 })
  })

  it('没有工作区 → 不查状态、不推送', async () => {
    const { service, port } = makeService({ workspaces: [] })
    await expect(service.push(OWNER, 'bind')).resolves.toEqual({
      pushed: 0,
      failed: 0,
      skipped: 0,
    })
    expect(port.status).not.toHaveBeenCalled()
    expect(port.sync).not.toHaveBeenCalled()
  })

  it('状态查询失败按"没在跑"处理，不影响其它工作区', async () => {
    const { service, port } = makeService({ workspaces: ['ws_a', 'ws_b'] })
    port.status = vi.fn(async (id: string) => {
      if (id === 'ws_a') throw new Error('workspace-service down')
      return { state: 'running' }
    })

    const result = await service.push(OWNER, 'bind')

    expect(result).toMatchObject({ pushed: 1, skipped: 1 })
  })
})

describe('失败重试：普通变更 3 次、吊销 5 次', () => {
  it('推送失败后按延迟重试，成功即停', async () => {
    vi.useFakeTimers()
    let calls = 0
    const { service, port, logger } = makeService({
      workspaces: ['ws_a'],
      syncImpl: async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return { credentialVersion: 'v' }
      },
    })

    const result = await service.push(OWNER, 'bind')
    expect(result.failed).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(port.sync).toHaveBeenCalledTimes(2)
    expect(logger.log).toHaveBeenCalledWith('credential.sync_retry_ok', expect.anything())
  })

  it('吊销一路失败 → 用完 5 次后打 error 级日志（旧凭据仍可用）', async () => {
    vi.useFakeTimers()
    const { service, port, logger } = makeService({
      workspaces: ['ws_a'],
      syncImpl: async () => {
        throw new Error('still down')
      },
    })

    await service.push(OWNER, 'revoke')
    for (const delay of [1_000, 5_000, 15_000, 30_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delay)
    }

    // 首次 + 5 次重试
    expect(port.sync).toHaveBeenCalledTimes(6)
    expect(logger.error).toHaveBeenCalledWith('credential.sync_revoke_gave_up', expect.anything())
  })
})
