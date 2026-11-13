import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '../src/rate-limit/rate-limiter.js'
import { isIpWhitelisted, normalizeIp } from '../src/rate-limit/ip-utils.js'
import type { RedisStore } from '../src/redis/redis-store.js'

/** mock rate-limiter-flexible：记录实例，consume 由用例控制。 */
interface MockLimiter {
  options: Record<string, unknown>
  consume: ReturnType<typeof vi.fn>
}

const { mockLimiters, MockRateLimiterRes, consumeFn } = vi.hoisted(() => {
  class MockRateLimiterRes {
    consumedPoints = 0
    remainingPoints = 0
    msBeforeNext = 0
    isFirstInDuration = false
  }
  return {
    mockLimiters: [] as MockLimiter[],
    MockRateLimiterRes,
    consumeFn: vi.fn(async () => ({ remainingPoints: 0 })),
  }
})

vi.mock('rate-limiter-flexible', () => {
  class MockRateLimiterRedis {
    consume = consumeFn
    constructor(public options: Record<string, unknown>) {
      mockLimiters.push(this)
    }
  }
  return {
    RateLimiterRedis: MockRateLimiterRedis,
    RateLimiterRes: MockRateLimiterRes,
  }
})

const createLimiter = (): RateLimiter => new RateLimiter({ raw: {} } as RedisStore)

describe('RateLimiter（rate-limiter-flexible 统一入口）', () => {
  beforeEach(() => {
    mockLimiters.length = 0
    consumeFn.mockResolvedValue({ remainingPoints: 0 })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('check 命中：创建底层限流器并透传剩余配额', async () => {
    consumeFn.mockResolvedValue({ remainingPoints: 19 })
    const limiter = createLimiter()

    const decision = await limiter.check('login:1.2.3.4', 20, 60)

    expect(decision).toEqual({ allowed: true, remaining: 19, retryAfterSeconds: 0 })
    expect(mockLimiters).toHaveLength(1)
    expect(mockLimiters[0].options).toMatchObject({
      keyPrefix: 'ratelimit',
      points: 20,
      duration: 60,
    })
    expect(consumeFn).toHaveBeenCalledWith('login:1.2.3.4')
  })

  it('check 超限：RateLimiterRes（consumedPoints > limit）映射为拒绝与重试秒数', async () => {
    const exceeded = new MockRateLimiterRes()
    exceeded.consumedPoints = 21
    exceeded.msBeforeNext = 30_000
    consumeFn.mockRejectedValue(exceeded)
    const limiter = createLimiter()

    const decision = await limiter.check('login:1.2.3.4', 20, 60)

    expect(decision).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 30 })
  })

  it('同 (limit, window) 组合复用底层实例，不同组合新建', async () => {
    consumeFn.mockResolvedValue({ remainingPoints: 5 })
    const limiter = createLimiter()
    await limiter.check('login:1.1.1.1', 20, 60)
    await limiter.check('login:2.2.2.2', 20, 60)
    expect(mockLimiters).toHaveLength(1)

    await limiter.check('login:3.3.3.3', 100, 60)
    await limiter.check('login:4.4.4.4', 20, 300)
    expect(mockLimiters).toHaveLength(3)
  })

  it('非限流错误（Redis 故障等）原样上抛', async () => {
    const boom = new Error('redis down')
    consumeFn.mockRejectedValue(boom)
    const limiter = createLimiter()
    await expect(limiter.check('login:1.1.1.1', 20, 60)).rejects.toBe(boom)
  })
})

describe('isIpWhitelisted（ipaddr.js 白名单匹配）', () => {
  it('精确 IPv4 / IPv6 命中', () => {
    expect(isIpWhitelisted('192.168.1.10', ['192.168.1.10'])).toBe(true)
    expect(isIpWhitelisted('192.168.1.11', ['192.168.1.10'])).toBe(false)
    expect(isIpWhitelisted('::1', ['::1', 'fe80::1'])).toBe(true)
    expect(isIpWhitelisted('::2', ['::1'])).toBe(false)
  })

  it('IPv4 / IPv6 CIDR 网段匹配', () => {
    expect(isIpWhitelisted('192.168.1.55', ['10.0.0.0/8', '192.168.1.0/24'])).toBe(true)
    expect(isIpWhitelisted('192.168.2.1', ['192.168.1.0/24'])).toBe(false)
    expect(isIpWhitelisted('10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(isIpWhitelisted('2001:db8::1', ['2001:db8::/32'])).toBe(true)
    expect(isIpWhitelisted('2001:db9::1', ['2001:db8::/32'])).toBe(false)
  })

  it('CIDR /0 匹配所有 IPv4，/32 等于精确匹配', () => {
    expect(isIpWhitelisted('8.8.8.8', ['0.0.0.0/0'])).toBe(true)
    expect(isIpWhitelisted('1.2.3.4', ['1.2.3.4/32'])).toBe(true)
    expect(isIpWhitelisted('1.2.3.5', ['1.2.3.4/32'])).toBe(false)
  })

  it('非法 CIDR / 非法 IP 不匹配', () => {
    expect(isIpWhitelisted('1.2.3.4', ['1.2.3.0/33'])).toBe(false)
    expect(isIpWhitelisted('1.2.3.4', ['1.2.3.0/abc'])).toBe(false)
    expect(isIpWhitelisted('not-an-ip', ['1.2.3.4'])).toBe(false)
  })

  it('unknown / 空 IP 一律不匹配；条目自动 trim 且空条目忽略', () => {
    expect(isIpWhitelisted('unknown', ['1.2.3.4'])).toBe(false)
    expect(isIpWhitelisted('', ['1.2.3.4'])).toBe(false)
    expect(isIpWhitelisted('1.2.3.4', [' 1.2.3.4 '])).toBe(true)
    expect(isIpWhitelisted('1.2.3.4', ['', '  '])).toBe(false)
  })

  it('IPv6-mapped IPv4 规范化后匹配 IPv4 白名单与 CIDR', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4')
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4')
    expect(isIpWhitelisted('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true)
    expect(isIpWhitelisted('::ffff:192.168.1.55', ['192.168.1.0/24'])).toBe(true)
    expect(isIpWhitelisted('::ffff:192.168.2.1', ['192.168.1.0/24'])).toBe(false)
  })
})
