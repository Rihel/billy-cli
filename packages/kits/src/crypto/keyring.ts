import { z } from 'zod'

/** AES-256 的密钥长度（字节）：32 字节 = 256 位 */
export const ENVELOPE_KEY_BYTES = 32

/**
 * 密钥环：`keyId → 32 字节主密钥（base64）`，外加"写用哪一把"。
 *
 * 为什么需要 `keyId` 而不是一把密钥打天下：换密钥时新旧密文要能共存，
 * 否则轮换必须停机重写全表。读时按密文里记录的 `keyId` 取钥匙，写时用 `current`。
 */
export interface CredentialKeyring {
  /** keyId（如 `v1`）→ base64 编码的 32 字节密钥 */
  keys: Record<string, string>
  /** 当前用于**加密**的 keyId（解密永远按密文自带的 keyId） */
  current: string
}

/**
 * 校验密钥环（启动期跑，不合法就拒绝启动）。
 *
 * 返回 keyId → `Buffer`，供加密器直接使用；顺带保证：
 * - keyId 非空、每把密钥 base64 解码后**正好 32 字节**（长度不对等于加密强度不对）；
 * - `current` 必须指向已配置的某一把（否则加密时取不到钥匙）。
 */
export const parseCredentialKeys = (
  keys: Record<string, string>,
  current: string,
): Map<string, Buffer> => {
  const parsed = new Map<string, Buffer>()
  for (const [keyId, raw] of Object.entries(keys)) {
    if (!keyId.trim()) throw new Error('凭据主密钥缺少 keyId')
    const buffer = Buffer.from(raw.trim(), 'base64')
    if (buffer.length !== ENVELOPE_KEY_BYTES) {
      throw new Error(
        `凭据主密钥 ${keyId} 长度不合法：base64 解码后应为 ${ENVELOPE_KEY_BYTES} 字节，实际 ${buffer.length} 字节`,
      )
    }
    parsed.set(keyId, buffer)
  }
  if (parsed.size > 0 && !parsed.has(current)) {
    throw new Error(`凭据主密钥当前版本 ${current} 不在已配置的密钥里`)
  }
  return parsed
}

/**
 * 应用配置里的凭据加密分片（`serverAppConfigSchema.credential`）。
 *
 * `keys` 为空表示**尚未配置密钥**：启动不拦（与对象存储一致的可降级口径），
 * 但凭据模块一旦被用来加密就会明确报错。生产环境必须配，且放 Secret。
 * 配了但长度不对则**直接拒绝启动**（长度错 = 加密强度错，不能带病运行）。
 */
export const CredentialCryptoConfigSchema = z
  .object({
    /** keyId → base64(32 字节)；环境变量 `PERSONAL_CREDENTIAL_KEYS`（`v1:<base64>,v2:<base64>`） */
    keys: z.record(z.string(), z.string()).default({}),
    /** 写入使用的 keyId；环境变量 `PERSONAL_CREDENTIAL_KEY_CURRENT`，缺省 `v1` */
    current: z.string().min(1).default('v1'),
  })
  .superRefine((value, ctx) => {
    for (const [keyId, raw] of Object.entries(value.keys)) {
      const bytes = Buffer.from(raw.trim(), 'base64').length
      if (bytes !== ENVELOPE_KEY_BYTES) {
        ctx.addIssue({
          code: 'custom',
          path: ['keys', keyId],
          message: `凭据主密钥 ${keyId} 长度不合法：base64 解码后应为 ${ENVELOPE_KEY_BYTES} 字节，实际 ${bytes} 字节`,
        })
      }
    }
    if (Object.keys(value.keys).length > 0 && !(value.current in value.keys)) {
      ctx.addIssue({
        code: 'custom',
        path: ['current'],
        message: `凭据主密钥当前版本 ${value.current} 不在已配置的密钥里`,
      })
    }
  })

export type CredentialCryptoConfig = z.infer<typeof CredentialCryptoConfigSchema>
