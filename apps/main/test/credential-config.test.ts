import { describe, expect, it } from 'vitest'
import { CredentialCryptoConfigSchema } from '@repo/kits'
import { mapServerEnv } from '../src/app-config.js'

/**
 * 凭据主密钥的配置校验（`docs/design/workspace-cli-credentials.md` §6.4.2）。
 *
 * 口径：**配了但长度不对 → 拒绝启动**；一把都没配 → 允许启动（凭据写入时再报错）。
 * 环境变量支持多把（轮换）与单把简写两种写法。
 */

const VALID_KEY = 'Dh6WPBpMm8Ve6gTx7+ed6t1zD/6tmYowUgRnSOjR2KU='

describe('schema：密钥长度与 current 必须自洽', () => {
  it('32 字节 base64 通过', () => {
    const parsed = CredentialCryptoConfigSchema.parse({
      keys: { v1: VALID_KEY },
      current: 'v1',
    })
    expect(parsed.current).toBe('v1')
  })

  it('长度不对（31 / 33 字节）→ 拒绝', () => {
    for (const bytes of [31, 33]) {
      const short = Buffer.alloc(bytes, 1).toString('base64')
      const result = CredentialCryptoConfigSchema.safeParse({ keys: { v1: short }, current: 'v1' })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.message).toMatch(/32 字节/)
    }
  })

  it('current 指向未配置的版本 → 拒绝', () => {
    const result = CredentialCryptoConfigSchema.safeParse({
      keys: { v1: VALID_KEY },
      current: 'v2',
    })
    expect(result.success).toBe(false)
  })

  it('一把都没配 → 允许启动（可降级，写入时再报错）', () => {
    const parsed = CredentialCryptoConfigSchema.parse({})
    expect(parsed.keys).toEqual({})
    expect(parsed.current).toBe('v1')
  })
})

describe('环境变量映射', () => {
  const credentialOf = (env: Record<string, string>) =>
    (mapServerEnv(env as NodeJS.ProcessEnv) as { credential: unknown }).credential

  it('单把简写 → keyId v1', () => {
    expect(credentialOf({ PERSONAL_CREDENTIAL_KEY: VALID_KEY })).toEqual({
      keys: { v1: VALID_KEY },
      current: undefined,
    })
  })

  it('多把写法 → 按逗号与冒号解析，忽略空段', () => {
    const env = {
      PERSONAL_CREDENTIAL_KEYS: ` v1:${VALID_KEY} , , v2:${VALID_KEY}`,
      PERSONAL_CREDENTIAL_KEY_CURRENT: 'v2',
    }
    expect(credentialOf(env)).toEqual({
      keys: { v1: VALID_KEY, v2: VALID_KEY },
      current: 'v2',
    })
  })
})
