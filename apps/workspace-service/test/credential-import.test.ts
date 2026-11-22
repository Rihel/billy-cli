import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import { WorkspaceCredentialImportService } from '../src/workspace/credential/import.service.js'
import type { WorkspaceRuntime } from '../src/workspace/workspace-runtime.service.js'
import type { WorkspaceRepository } from '../src/workspace/workspace.repository.js'

/**
 * 从工作区导入凭据（§6.4.5）：候选探测与"读→解析→入库"链路。
 *
 * 用假 shell 输出模拟容器；main 的导入接口用 fetch 打桩，断言**只传 provider 与解析后的值**。
 */

const LARK_JSON = JSON.stringify({ token: 'lark-token-123' })

const make = () => {
  const runtime = {
    exec: vi.fn(async (_id: string, request: { command: string }) => {
      const command = request.command
      if (command.includes('gh auth token')) {
        return { ok: true, exitCode: 0, stdout: 'ghp_token_abc\n', stderr: '', durationMs: 1 }
      }
      if (command === 'gh auth status') {
        return { ok: true, exitCode: 0, stdout: 'Logged in', stderr: '', durationMs: 1 }
      }
      if (command.includes('lark-cli/config.json')) {
        return { ok: true, exitCode: 0, stdout: LARK_JSON, stderr: '', durationMs: 1 }
      }
      if (command.startsWith('if [ -f')) {
        return { ok: true, exitCode: 0, stdout: '__MISSING__\n', stderr: '', durationMs: 1 }
      }
      return { ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }
    }),
  }
  const repo = {
    findSetupContext: vi.fn(async () => ({
      ownerType: 'user' as const,
      ownerId: 'u_1',
      setupId: null,
      setupExtra: [],
    })),
  }
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
  const service = new WorkspaceCredentialImportService(
    runtime as unknown as WorkspaceRuntime,
    repo as unknown as WorkspaceRepository,
    { mainUrl: 'http://main:9989', mainToken: 'internal-token' } as never,
    logger,
  )
  return { service, runtime, repo }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('credential-candidates', () => {
  it('只返回"适配器声明了导入来源且容器里读得到"的 provider', async () => {
    const { service } = make()

    const candidates = await service.candidates('ws_1')

    expect(candidates.map((item) => item.provider)).toEqual(['github'])
  })

  it('lark 没有明文导出通道 → 永不出现在候选里（不再假装能导入）', async () => {
    const { service } = make()

    const candidates = await service.candidates('ws_1')

    expect(candidates.some((item) => item.provider === 'lark')).toBe(false)
  })
})

describe('credential-import', () => {
  it('命令型来源：按行取值，只把 provider 与值交给 main，返回摘要不含值', async () => {
    const { service, repo } = make()
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          code: 0,
          data: { credential: { id: 'cred_1', name: 'gh', provider: 'gh', status: 'active' } },
        }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const credential = await service.import('ws_1', 'github')

    expect(credential).toMatchObject({ id: 'cred_1', name: 'gh', status: 'active', verified: true })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toContain('/internal/credentials/import')
    expect(JSON.parse(String(init.body))).toMatchObject({
      ownerType: 'user',
      ownerId: 'u_1',
      provider: 'github',
      values: { token: 'ghp_token_abc' },
    })
    expect(repo.findSetupContext).toHaveBeenCalledWith('ws_1')
  })

  it('lark 没有可读的导入来源 → 明确报错（真实 CLI 只有加密库，没有明文导出）', async () => {
    const { service } = make()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.import('ws_1', 'lark')).rejects.toThrow('不支持从工作区导入')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('入库失败透传控制面原因（带字段键名），不是只有 HTTP 状态码', async () => {
    const { service } = make()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ code: 4000, message: 'appId：请填写应用 ID' }),
      })),
    )

    await expect(service.import('ws_1', 'github')).rejects.toThrow(
      '凭据入库失败：HTTP 400（appId：请填写应用 ID）',
    )
  })

  it('不支持导入的 provider（mysql）→ 明确报错，不调用 main', async () => {
    const { service } = make()
    vi.stubGlobal('fetch', vi.fn())

    await expect(service.import('ws_1', 'mysql')).rejects.toThrow('不支持从工作区导入')
  })
})
