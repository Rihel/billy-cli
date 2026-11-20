import { describe, expect, it, vi } from 'vitest'
import { CredentialInternalController } from '../src/modules/ai-admin/credential/credential-internal.controller.js'
import type { CredentialResolveService } from '../src/modules/ai-admin/credential/credential-resolve.service.js'

/**
 * `/internal/credentials/resolve` 的令牌闸门（§6.4.6）。
 *
 * 这个接口的入参是**目标归属主体**而不是当前登录人 —— 没有令牌就等于"以任意人身份取凭据"，
 * 所以这里必须钉死：缺令牌、错令牌一律 401，且不会走到 service。
 */
const makeController = () => {
  const resolve = vi.fn(async () => ({ items: [] }))
  const controller = new CredentialInternalController(
    { resolve } as unknown as CredentialResolveService,
    { importForOwner: vi.fn() } as never,
    { cipher: {} as never, internalToken: 'secret-token' },
  )
  return { controller, resolve }
}

const input = {
  ownerType: 'user' as const,
  ownerId: 'u_1',
  names: ['lark'],
  consumer: 'capability-gateway' as const,
}

describe('内部令牌', () => {
  it('缺令牌 / 错令牌 → 401，且不调用解析', async () => {
    const { controller, resolve } = makeController()

    expect(() => controller.resolve(undefined, input)).toThrow('内部令牌不正确')
    expect(() => controller.resolve('wrong-token', input)).toThrow('内部令牌不正确')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('令牌正确 → 交给 service 解析', async () => {
    const { controller, resolve } = makeController()

    await controller.resolve('secret-token', input)
    expect(resolve).toHaveBeenCalledWith(input)
  })
})
