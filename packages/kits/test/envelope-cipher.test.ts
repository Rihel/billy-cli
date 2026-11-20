import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  EnvelopeCipher,
  EnvelopeCipherError,
  generateCredentialKey,
  parseCredentialKeys,
} from '../src/crypto/index.js'

/**
 * 信封加密（`docs/design/workspace-cli-credentials.md` §6.4.2）。
 *
 * 钉四件事：能往返、AAD 绑定（防密文搬运）、密文被改一定解不开、换密钥期间新旧共存。
 */

const key = (): string => generateCredentialKey()

const keyring = (over: Partial<{ keys: Record<string, string>; current: string }> = {}) => {
  const v1 = key()
  return { cipher: new EnvelopeCipher({ keys: { v1 }, current: 'v1', ...over }), v1 }
}

const AAD = 'cred_1|admin:adm_1|mysql|mysql'

describe('往返：对象进、对象出', () => {
  it('多字段凭据包原样还原（含中文与 emoji）', () => {
    const { cipher } = keyring()
    const secret = { password: 'p@ss:word', note: '中文🙂', nested: { retries: 3 } }

    const envelope = cipher.seal(secret, AAD)

    expect(envelope.startsWith('v1:v1:')).toBe(true)
    expect(cipher.open(envelope, AAD)).toEqual(secret)
  })

  it('同一明文两次加密得到的密文不同（IV 每次随机）', () => {
    const { cipher } = keyring()
    expect(cipher.seal({ a: 1 }, AAD)).not.toBe(cipher.seal({ a: 1 }, AAD))
  })
})

describe('AAD：密文与"它属于谁"绑定', () => {
  it('换一行身份（AAD 不同）就解不开 —— 防把 A 行密文搬到 B 行', () => {
    const { cipher } = keyring()
    const envelope = cipher.seal({ password: 'x' }, AAD)

    expect(() => cipher.open(envelope, 'cred_2|admin:adm_1|mysql|mysql')).toThrow(
      EnvelopeCipherError,
    )
  })
})

describe('完整性：密文被改一定失败', () => {
  it('篡改密文正文 → 解密失败', () => {
    const { cipher } = keyring()
    const [version, keyId, iv, tag, ct] = cipher.seal({ password: 'x' }, AAD).split(':')
    const flipped = Buffer.from(ct, 'base64')
    flipped[0] ^= 0xff

    expect(() =>
      cipher.open([version, keyId, iv, tag, flipped.toString('base64')].join(':'), AAD),
    ).toThrow(EnvelopeCipherError)
  })

  it('格式不合法 / 未知密钥版本 → 明确报错而不是返回半截值', () => {
    const { cipher } = keyring()
    expect(() => cipher.open('not-an-envelope', AAD)).toThrow(EnvelopeCipherError)

    const envelope = cipher.seal({ a: 1 }, AAD).replace(/^v1:v1:/, 'v1:v9:')
    expect(() => cipher.open(envelope, AAD)).toThrow(EnvelopeCipherError)
  })
})

describe('密钥环：轮换期间新旧共存', () => {
  it('换 current 后新密文用新 keyId，旧密文仍能解开', () => {
    const v1 = key()
    const v2 = key()
    const before = new EnvelopeCipher({ keys: { v1 }, current: 'v1' })
    const oldEnvelope = before.seal({ token: 'a' }, AAD)

    const after = new EnvelopeCipher({ keys: { v1, v2 }, current: 'v2' })
    expect(after.keyIdOf(after.seal({ token: 'b' }, AAD))).toBe('v2')
    expect(after.keyIdOf(oldEnvelope)).toBe('v1')
    expect(after.open(oldEnvelope, AAD)).toEqual({ token: 'a' })
  })

  it('密钥长度不是 32 字节 → 构造/校验直接失败（不等运行到加密才炸）', () => {
    const short = Buffer.from(randomBytes(31)).toString('base64')
    expect(() => parseCredentialKeys({ v1: short }, 'v1')).toThrow(/32 字节/)

    const cipher = new EnvelopeCipher({ keys: {}, current: 'v1' })
    expect(cipher.configured).toBe(false)
  })

  it('current 指向未配置的版本 → 失败', () => {
    expect(() => parseCredentialKeys({ v1: key() }, 'v2')).toThrow(/不在已配置的密钥里/)
  })
})
