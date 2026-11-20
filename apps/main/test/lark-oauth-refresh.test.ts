import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialRefreshRejectedError } from '../src/modules/ai-admin/credential/credential-refresh.js'
import { createLarkRefreshAdapter } from '../src/modules/ai-admin/credential/lark-oauth.refresh.js'

/**
 * 飞书 OAuth 刷新（§6.4.6 / P11）。
 *
 * 失败分类是重点：上游**明确拒绝** → `CredentialRefreshRejectedError`（置 expired、提示重新授权）；
 * 5xx / 网络错误 → 原样抛出（可重试、不降级）。
 */
const adapter = createLarkRefreshAdapter({ appId: 'app_id', appSecret: 'app_secret' })

const mockFetch = (status: number, body: unknown) => {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('刷新成功', () => {
  it('换回新 access token、保留/轮换 refresh token、算出到期时间', async () => {
    const fetchMock = mockFetch(200, {
      code: 0,
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 7200,
    })

    const result = await adapter.refresh({
      secret: { accessToken: 'old', refreshToken: 'old-refresh' },
      config: {},
    })

    expect(result.secret).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' })
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      grant_type: 'refresh_token',
      client_id: 'app_id',
      refresh_token: 'old-refresh',
    })
  })
})

describe('失败分类', () => {
  it('invalid_grant → 确定性失效（置 expired，提示重新授权）', async () => {
    mockFetch(400, { code: 20037, error: 'invalid_grant' })

    await expect(
      adapter.refresh({ secret: { refreshToken: 'revoked' }, config: {} }),
    ).rejects.toBeInstanceOf(CredentialRefreshRejectedError)
  })

  it('5xx → 普通错误（可重试、不得置过期）', async () => {
    mockFetch(503, {})

    const error = await adapter
      .refresh({ secret: { refreshToken: 'ok' }, config: {} })
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(CredentialRefreshRejectedError)
  })

  it('没有 refresh token → 确定性失效（不拿它去撞上游）', async () => {
    await expect(adapter.refresh({ secret: {}, config: {} })).rejects.toBeInstanceOf(
      CredentialRefreshRejectedError,
    )
  })
})
