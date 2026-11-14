import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ConfigService } from '@nestjs/config'
import type { AppLogger, Notifier, PasswordHasher, SessionStore, TokenSigner } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import { AuthService } from '../src/modules/auth/auth.service.js'
import type { UserRepository } from '../src/modules/user/user.repository.js'

/**
 * 找回密码链路的安全口径（2026-11-14 评审整改）：
 * - API 响应**不含令牌**；
 * - 库里只存 `sha256(token)`；
 * - 令牌只经通知渠道（邮件）投递；
 * - 重置成功后撤销该用户全部会话。
 */
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const makeService = () => {
  const update = vi.fn(async () => ({ id: 'u-1' }))
  const users = new Map<string, Record<string, unknown>>([
    [
      'a@example.com',
      {
        id: 'u-1',
        email: 'a@example.com',
        resetPasswordToken: null,
        resetPasswordTokenExpiry: new Date(Date.now() + 60_000),
      },
    ],
  ])
  const findByEmail = vi.fn(async (email: string) => users.get(email) ?? null)
  const findByResetTokenHash = vi.fn(async (hash: string) => {
    for (const user of users.values()) if (user.resetPasswordToken === hash) return user
    return null
  })
  const send = vi.fn(async () => ({ ok: true }))
  const revokeAll = vi.fn(async () => undefined)
  const hash = vi.fn(async (password: string) => `hashed:${password}`)

  const repository = { update, findByEmail, findByResetTokenHash } as unknown as UserRepository
  const notifier = { send } as unknown as Notifier
  const passwordHasher = { hash, verify: vi.fn() } as unknown as PasswordHasher
  const sessionStore = { revokeAll } as unknown as SessionStore
  const tokenSigner = { sign: vi.fn(), verify: vi.fn() } as unknown as TokenSigner
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  } as unknown as AppLogger

  const config = new ConfigService({
    server: { appUrl: 'https://web.example.com', resetPasswordTokenTtlMinutes: 30 },
  })

  const service = new AuthService(
    repository,
    passwordHasher,
    tokenSigner,
    sessionStore,
    config,
    logger,
    notifier,
  )
  return { service, update, findByEmail, findByResetTokenHash, send, revokeAll, hash }
}

describe('找回密码：令牌只经邮件投递', () => {
  it('响应不含令牌；库里存 sha256(hash)；邮件正文带明文链接', async () => {
    const { service, update, send } = makeService()

    const result = await service.forgotPassword({ email: 'a@example.com' })

    expect(result).toEqual({ success: true })
    expect(update).toHaveBeenCalledTimes(1)
    const [, patch] = update.mock.calls[0] as unknown as [string, { resetPasswordToken: string }]
    expect(patch.resetPasswordToken).toMatch(/^[a-f0-9]{64}$/)

    expect(send).toHaveBeenCalledTimes(1)
    const [channel, payload] = send.mock.calls[0] as unknown as [
      string,
      { to: string; subject: string; text: string },
    ]
    expect(channel).toBe('email')
    expect(payload.to).toBe('a@example.com')
    const token = /token=([A-Za-z0-9_-]+)/.exec(payload.text)?.[1]
    expect(token).toBeTruthy()
    expect(payload.text).toContain('https://web.example.com/auth/reset-password')
    // 库里是哈希，不是明文
    expect(patch.resetPasswordToken).toBe(sha256(token!))
    expect(patch.resetPasswordToken).not.toBe(token)
  })

  it('邮箱不存在：响应与成功一致，不落库也不发信（不泄露账号是否存在）', async () => {
    const { service, update, send } = makeService()

    const result = await service.forgotPassword({ email: 'nobody@example.com' })

    expect(result).toEqual({ success: true })
    expect(update).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('重置成功：按 hash 查用户、更新密码并撤销全部会话', async () => {
    const { service, update, findByResetTokenHash, findByEmail, hash, revokeAll } = makeService()
    const token = 'reset-token-abc'
    const user = (await findByEmail('a@example.com')) as Record<string, unknown>
    user.resetPasswordToken = sha256(token)

    const result = await service.resetPassword({ token, password: 'new-password' })

    expect(result).toEqual({ success: true })
    expect(findByResetTokenHash).toHaveBeenCalledWith(sha256(token))
    expect(hash).toHaveBeenCalledWith('new-password')
    expect(update).toHaveBeenCalledWith('u-1', {
      password: 'hashed:new-password',
      resetPasswordToken: null,
      resetPasswordTokenExpiry: null,
    })
    expect(revokeAll).toHaveBeenCalledWith('user', 'u-1')
  })

  it('令牌无效 / 已过期：分别抛 InvalidResetToken / ExpiredResetToken', async () => {
    const { service } = makeService()

    await expect(
      service.resetPassword({ token: 'nope', password: 'x123456' }),
    ).rejects.toMatchObject({ code: AppErrorCodes.InvalidResetToken })

    const { service: expired, findByEmail } = makeService()
    const token = 'expired-token'
    const user = (await findByEmail('a@example.com')) as Record<string, unknown>
    user.resetPasswordToken = sha256(token)
    user.resetPasswordTokenExpiry = new Date(Date.now() - 1000)
    await expect(expired.resetPassword({ token, password: 'x123456' })).rejects.toMatchObject({
      code: AppErrorCodes.ExpiredResetToken,
    })
  })
})
