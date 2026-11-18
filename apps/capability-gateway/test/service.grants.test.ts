import { describe, expect, it } from 'vitest'
import type { Db } from '@repo/kits'
import type { RegisteredService } from '@repo/contracts'
import { ServiceRegistry } from '../src/registry/service.registry.js'

const config = {
  internalToken: 'token',
  staleAfterMs: 30_000,
  invokeTimeoutMs: 2_000,
  rateLimitPerMinute: 60,
  allowPrivateNetwork: true,
}

const manual = { service: 'amap', source: 'manual' } as Pick<
  RegisteredService,
  'service' | 'source'
>
const code = { service: 'common', source: 'code' } as Pick<RegisteredService, 'service' | 'source'>

/** 最小 Db 替身：a 有 amap 授权，b 没有 */
const fakeDb = {
  getRepository: () => ({
    find: async (options: { where: { principalId: string } }) =>
      options.where.principalId === 'a' ? [{ service: 'amap' }] : [],
  }),
} as unknown as Db

describe('服务级授权过滤', () => {
  it('manual 服务只对被授权的管理员可见', async () => {
    const registry = new ServiceRegistry(config, undefined, undefined, fakeDb)
    expect(await registry.canUseService({ isAdmin: true, userId: 'a' }, manual as never)).toBe(true)
    expect(await registry.canUseService({ isAdmin: true, userId: 'b' }, manual as never)).toBe(
      false,
    )
  })

  it('非管理员 / 无身份不能使用 manual 服务', async () => {
    const registry = new ServiceRegistry(config, undefined, undefined, fakeDb)
    expect(await registry.canUseService({ isAdmin: false, userId: 'a' }, manual as never)).toBe(
      false,
    )
    expect(await registry.canUseService({ isAdmin: true }, manual as never)).toBe(false)
  })

  it('code 服务默认全部可用，不查授权', async () => {
    const registry = new ServiceRegistry(config, undefined, undefined, fakeDb)
    expect(await registry.canUseService({ isAdmin: true, userId: 'b' }, code as never)).toBe(true)
    expect(await registry.canUseService({ isAdmin: false, userId: null }, code as never)).toBe(true)
  })
})
