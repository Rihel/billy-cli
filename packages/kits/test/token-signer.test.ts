import { describe, expect, it } from 'vitest'
import { IdGeneration } from '../src/foundation/id-generation/id-generation.js'
import type { JwtConfig } from '../src/jwt/jwt.config.js'
import { TokenSigner } from '../src/jwt/token-signer.js'

const makeSigner = () =>
  new TokenSigner(
    { secret: 'test-secret', expiresIn: '1h' } as JwtConfig,
    new IdGeneration(),
  )

describe('TokenSigner（签发与校验）', () => {
  it('往返：verify 能取到原始声明', async () => {
    const signer = makeSigner()

    const token = await signer.sign({ sub: 'u-1' })

    await expect(signer.verify<{ sub: string }>(token)).resolves.toMatchObject({ sub: 'u-1' })
  })

  it('同一载荷连签两次得到不同 token（jti 保证唯一）', async () => {
    const signer = makeSigner()

    const first = await signer.sign({ sub: 'u-1' })
    const second = await signer.sign({ sub: 'u-1' })

    // 回归背景：jsonwebtoken 只补秒级 iat/exp，同一秒内两次签发曾**逐字节相同**，
    // 导致服务端会话（以 sha256(token) 为主键）把两台设备合并成一条。
    expect(first).not.toBe(second)

    const payload = await signer.verify<{ sub: string; jti?: string }>(first)
    expect(typeof payload.jti).toBe('string')
    expect((payload.jti ?? '').length).toBe(16)
  })

  it('被篡改的 token 抛 TokenSigningError', async () => {
    const signer = makeSigner()
    const token = await signer.sign({ sub: 'u-1' })

    await expect(signer.verify(`${token}x`)).rejects.toThrowError()
  })
})
