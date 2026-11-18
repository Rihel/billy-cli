import { describe, expect, it } from 'vitest'
import { UnsafeTargetError, assertSafeTarget } from '../src/registry/target.guard.js'

describe('外部目标校验（协议 §4.4）', () => {
  it('公网 https 放行', async () => {
    await expect(
      assertSafeTarget('https://93.184.216.34/mcp', { allowPrivateNetwork: false }),
    ).resolves.toBeInstanceOf(URL)
  })

  it('http 需要显式允许', async () => {
    await expect(
      assertSafeTarget('http://93.184.216.34/invoke', { allowPrivateNetwork: false }),
    ).rejects.toBeInstanceOf(UnsafeTargetError)
    await expect(
      assertSafeTarget('http://93.184.216.34/invoke', {
        allowHttp: true,
        allowPrivateNetwork: false,
      }),
    ).resolves.toBeInstanceOf(URL)
  })

  it.each([
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://192.168.1.10/x',
    'https://172.16.0.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'https://[fd00::1]/x',
  ])('内网 / 回环 / 元数据地址拒绝：%s', async (url) => {
    await expect(assertSafeTarget(url, { allowPrivateNetwork: false })).rejects.toBeInstanceOf(
      UnsafeTargetError,
    )
  })

  it('localhost 拒绝', async () => {
    await expect(assertSafeTarget('https://localhost/x', {})).rejects.toBeInstanceOf(
      UnsafeTargetError,
    )
  })

  it('显式允许内网时放行（本地联调 / 测试）', async () => {
    await expect(
      assertSafeTarget('https://127.0.0.1:9443/x', {
        allowHttp: true,
        allowPrivateNetwork: true,
      }),
    ).resolves.toBeInstanceOf(URL)
  })

  it('非 http(s) 协议拒绝', async () => {
    await expect(assertSafeTarget('ftp://example.com/x', {})).rejects.toBeInstanceOf(
      UnsafeTargetError,
    )
  })
})
