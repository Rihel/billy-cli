import { describe, expect, it } from 'vitest'
import { createShareToken, hashShareToken, shareState } from '../src/modules/share/share.token.js'

/**
 * 分享 token 的纯函数（设计 `docs/design/file-share.md` §4）。
 *
 * 这里钉住三条不变量：token 不重复 / 哈希稳定且不可逆推 / 状态按时间与撤销派生。
 */
describe('share token', () => {
  it('生成的 token 是 32 字符 base64url，且两次不同', () => {
    const a = createShareToken()
    const b = createShareToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(a).not.toBe(b)
  })

  it('哈希稳定：同 token 两次相同，不同 token 不同', () => {
    const token = createShareToken()
    expect(hashShareToken(token)).toBe(hashShareToken(token))
    expect(hashShareToken(token)).toHaveLength(64)
    expect(hashShareToken(token)).not.toBe(hashShareToken(createShareToken()))
  })

  it('状态派生：active / expired / revoked 优先于过期', () => {
    const now = Date.now()
    const base = { expiresAt: null, revokedAt: null }

    expect(shareState(base, now)).toBe('active')

    expect(shareState({ ...base, expiresAt: new Date(now - 1) }, now)).toBe('expired')
    expect(shareState({ ...base, expiresAt: new Date(now + 1000) }, now)).toBe('active')

    expect(shareState({ ...base, revokedAt: new Date(now - 5000) }, now)).toBe('revoked')
    // 撤销优先：既撤销又过期，仍然报 revoked
    expect(
      shareState(
        { expiresAt: new Date(now - 1), revokedAt: new Date(now - 5000) },
        now,
      ),
    ).toBe('revoked')
  })

  it('过期边界：等于当前时刻即视为过期', () => {
    const now = 1_700_000_000_000
    expect(shareState({ expiresAt: new Date(now), revokedAt: null }, now)).toBe('expired')
  })
})
