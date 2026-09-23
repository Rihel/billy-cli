import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { ProviderKeyUnavailableError } from './errors.js'

/**
 * 供应商密钥的加解密（**纯函数，可脱离数据库单测**）。
 *
 * 算法固定 **AES-256-GCM**，密钥由口令派生（scrypt），密文格式为
 * `base64(iv | tag | ciphertext)`：
 * - `iv` 12 字节（GCM 的推荐长度）；
 * - `tag` 16 字节（认证标签）—— 密文被篡改时解密会直接失败，而不是解出一段垃圾；
 * - `ciphertext` 变长。
 *
 * 三条口径：
 * - **口令解析**：`AI_MODEL_ENCRYPTION_KEY` 优先，缺省回落 `jwt.secret`；两者都没有 → 3405。
 *   派生用的盐是**固定串**（`billy.ai-model.secret.v1`），所以换口令等于换密钥、
 *   旧密文全部解不开 —— 这正是"口令变更"应有的行为（明确报错，不静默）；
 * - **解不开就抛错**：绝不返回空串（空串会被下游当成"没配密钥"，把故障伪装成配置问题）；
 * - **明文只进不出**：本文件只负责加解密，明文绝不落库、绝不进日志（提示只留 `hintOf`）。
 */

/** GCM 推荐 IV 长度（字节） */
const IV_BYTES = 12
/** GCM 认证标签长度（字节） */
const TAG_BYTES = 16
/** AES-256 密钥长度（字节） */
const KEY_BYTES = 32
/** 口令派生的固定盐（串里带版本号：将来换派生规则要一起换） */
const KDF_SALT = 'billy.ai-model.secret.v1'

/**
 * 由口令派生 32 字节密钥（scrypt）。
 *
 * 同一口令永远得到同一密钥（否则重启后就解不开库里的密文），故盐必须是固定串。
 */
export const deriveSecretKey = (secret: string): Buffer =>
  scryptSync(secret, KDF_SALT, KEY_BYTES)

/**
 * 解析实际使用的加密口令：`encryptionKey` 优先，回落 `fallbackSecret`（`jwt.secret`）。
 *
 * 两者都为空 → {@link ProviderKeyUnavailableError}（3405）。**不静默、不存明文**。
 */
export const resolveEncryptionSecret = (options: {
  encryptionKey?: string
  fallbackSecret?: string
}): string => {
  const secret = options.encryptionKey?.trim() || options.fallbackSecret?.trim()
  if (!secret) throw new ProviderKeyUnavailableError()
  return secret
}

/** 加密：`base64(iv | tag | ciphertext)` */
export const encryptSecret = (plain: string, secret: string): string => {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', deriveSecretKey(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

/**
 * 解密：入参是 {@link encryptSecret} 的产物。
 *
 * 解不开（口令不对 / 密文损坏 / 格式非法）一律抛 {@link ProviderKeyUnavailableError}（3405），
 * **绝不返回空串**。
 */
export const decryptSecret = (payload: string, secret: string): string => {
  try {
    const raw = Buffer.from(payload, 'base64')
    if (raw.length <= IV_BYTES + TAG_BYTES) {
      throw new Error('密文长度不足，缺少 iv / tag / ciphertext')
    }
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', deriveSecretKey(secret), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch (error) {
    throw new ProviderKeyUnavailableError(
      `供应商密钥解密失败（加密口令可能已变更或密文损坏）：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/**
 * 密钥提示（`sk-…abcd`）：给人辨认"配的是哪一把"，不足以还原密钥。
 *
 * - 足够长：前 3 字符 + `…` + 末 4 字符（如 `sk-1234abcd` → `sk-…abcd`）；
 * - 太短（不足 8 字符）：`…` + 末 2 位（如 `ab12` → `…12`），避免提示反而泄露大半。
 */
export const hintOf = (plain: string): string =>
  plain.length >= 8 ? `${plain.slice(0, 3)}…${plain.slice(-4)}` : `…${plain.slice(-2)}`
