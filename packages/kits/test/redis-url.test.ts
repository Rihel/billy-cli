import { describe, expect, it } from 'vitest'
import { redisTargetOf } from '../src/redis/redis-url.js'

describe('redisTargetOf（日志脱敏）', () => {
  it('只返回 host / port / TLS，不泄露用户名密码', () => {
    const target = redisTargetOf('redis://billy:s3cr3t@redis.internal:6380/2')

    expect(target).toEqual({ host: 'redis.internal', port: 6380, tls: false })
    expect(JSON.stringify(target)).not.toContain('s3cr3t')
    expect(JSON.stringify(target)).not.toContain('billy')
  })

  it('rediss 未写端口时回落 6380', () => {
    expect(redisTargetOf('rediss://:pass@cache.internal/0')).toEqual({
      host: 'cache.internal',
      port: 6380,
      tls: true,
    })
  })

  it('解析失败返回 null，不回退到原始连接串', () => {
    expect(redisTargetOf('not a url')).toBeNull()
    expect(redisTargetOf('redis://host:not-a-port/0')).toBeNull()
  })
})
