import { describe, expect, it, vi } from 'vitest'
import type { ExecutionContext } from '@nestjs/common'
import { RATE_LIMIT_METADATA, RateLimitGuard } from '../src/common/security/rate-limit.guard.js'
import { requestContext } from '@repo/kits'

class DummyController {
  handler(): void {}
}
Reflect.defineMetadata(
  RATE_LIMIT_METADATA,
  { scope: 'agent-chat', limit: 10, windowSeconds: 60, identity: 'user' },
  DummyController.prototype.handler,
)

const config = {
  getOrThrow: () => ({ rateLimitWhitelist: [], rateLimitTrustProxy: false }),
} as never

const contextOf = (ip = '1.2.3.4'): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: {}, socket: { remoteAddress: ip } }),
    }),
    getHandler: () => DummyController.prototype.handler,
  }) as unknown as ExecutionContext

describe('RateLimitGuard identity', () => {
  it('identity=user 时按登录用户计数，而不是 IP', async () => {
    const check = vi.fn(async () => ({ allowed: true, remaining: 9, retryAfterSeconds: 0 }))
    const guard = new RateLimitGuard({ check } as never, config)
    await requestContext.run({ requestId: 'r1', userId: 'user-1', adminId: null }, () =>
      guard.canActivate(contextOf()),
    )
    expect(check).toHaveBeenCalledWith('agent-chat:u:user-1', 10, 60)
  })

  it('未登录时回落 IP', async () => {
    const check = vi.fn(async () => ({ allowed: true, remaining: 9, retryAfterSeconds: 0 }))
    const guard = new RateLimitGuard({ check } as never, config)
    await requestContext.run({ requestId: 'r2', userId: null, adminId: null }, () =>
      guard.canActivate(contextOf('5.6.7.8')),
    )
    expect(check).toHaveBeenCalledWith('agent-chat:5.6.7.8', 10, 60)
  })
})
