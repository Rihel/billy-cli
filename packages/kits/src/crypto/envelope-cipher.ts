import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AppErrorCodes } from '@repo/shared'
import { AppError } from '../foundation/errors/app-error.js'
import { parseCredentialKeys, type CredentialKeyring, ENVELOPE_KEY_BYTES } from './keyring.js'

/** 密文信封版本前缀（格式变更时升它，读侧按版本分派） */
const ENVELOPE_VERSION = 'v1'
/** GCM 推荐的 IV 长度（12 字节） */
const IV_BYTES = 12
/** GCM 认证标签长度（16 字节） */
const TAG_BYTES = 16

/**
 * 信封加解密失败（密钥缺失 / 密文被篡改 / AAD 不匹配 / 格式不合法）。
 *
 * 消息里**不出现明文、密钥与密文片段**，只给"哪个环节失败"，避免二次泄露。
 */
export class EnvelopeCipherError extends AppError {
  readonly code = AppErrorCodes.Internal
  constructor(readonly reason: string) {
    super(`Credential envelope failed: ${reason}`)
  }
}

/**
 * **信封加密**（AES-256-GCM）。
 *
 * 密文格式：`v1:<keyId>:<iv_b64>:<tag_b64>:<ct_b64>`
 * - `keyId` 让换密钥时新旧密文共存（读按密文自带 keyId，写按 `current`）；
 * - IV 每次随机 12 字节，**绝不复用**（GCM 下 IV 复用会直接瓦解认证与保密性）；
 * - 明文是 JSON 序列化后的对象（`{ accessToken, refreshToken }` 这类多字段凭据包）。
 *
 * **AAD（附加认证数据）必须传该行的身份**：`id|owner_type:owner_id|provider|template`。
 * 目的不是保密而是**防搬运**：缺 AAD 时把 A 行密文写进 B 行，B 就继承了 A 的凭据；
 * 有了 AAD，密文与"它属于谁"绑定，换行即解密失败。
 *
 * 明文只在单次调用内驻留内存，不进日志、不进异常消息（§6.4.2 明文纪律）。
 */
export class EnvelopeCipher {
  private readonly keys: Map<string, Buffer>
  private readonly current: string

  constructor(keyring: CredentialKeyring) {
    try {
      this.keys = parseCredentialKeys(keyring.keys, keyring.current)
    } catch (cause) {
      throw new EnvelopeCipherError(cause instanceof Error ? cause.message : '密钥环不合法')
    }
    this.current = keyring.current
  }

  /** 是否已配置密钥（未配置时凭据模块不可用，但服务可以起） */
  get configured(): boolean {
    return this.keys.size > 0
  }

  /** 加密：返回 `v1:<keyId>:<iv>:<tag>:<ct>` 信封字符串 */
  seal(value: unknown, aad: string): string {
    const key = this.currentKey()
    const iv = randomBytes(IV_BYTES)
    const plain = Buffer.from(JSON.stringify(value ?? null), 'utf8')
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(Buffer.from(aad, 'utf8'))
      const cipherText = Buffer.concat([cipher.update(plain), cipher.final()])
      return [
        ENVELOPE_VERSION,
        this.current,
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        cipherText.toString('base64'),
      ].join(':')
    } catch {
      throw new EnvelopeCipherError('encrypt')
    }
  }

  /** 解密：AAD 与 `seal` 时不一致、密钥缺失或密文被改，一律抛错（不返回半截值） */
  open<T = unknown>(envelope: string, aad: string): T {
    const parsed = this.parse(envelope)
    const key = this.keys.get(parsed.keyId)
    if (!key) throw new EnvelopeCipherError(`unknown-key:${parsed.keyId}`)
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, parsed.iv, {
        authTagLength: TAG_BYTES,
      })
      decipher.setAAD(Buffer.from(aad, 'utf8'))
      decipher.setAuthTag(parsed.tag)
      const plain = Buffer.concat([decipher.update(parsed.cipherText), decipher.final()])
      return JSON.parse(plain.toString('utf8')) as T
    } catch {
      // 认证失败 / JSON 不合法都归为"解不开"：不区分失败细节，避免成为探测手段
      throw new EnvelopeCipherError('decrypt')
    }
  }

  /** 只取信封里的 keyId（轮换任务用它筛出"不是当前密钥"的行） */
  keyIdOf(envelope: string): string {
    return this.parse(envelope).keyId
  }

  private currentKey(): Buffer {
    const key = this.keys.get(this.current)
    if (!key) throw new EnvelopeCipherError(`missing-current-key:${this.current}`)
    return key
  }

  private parse(envelope: string): {
    keyId: string
    iv: Buffer
    tag: Buffer
    cipherText: Buffer
  } {
    const parts = envelope.split(':')
    if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
      throw new EnvelopeCipherError('format')
    }
    const [, keyId, ivB64, tagB64, ctB64] = parts
    const iv = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    if (!keyId || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new EnvelopeCipherError('format')
    }
    return {
      keyId,
      iv,
      tag,
      cipherText: Buffer.from(ctB64, 'base64'),
    }
  }
}

/** 生成一把符合要求的 32 字节 base64 密钥（运维/脚本用；不要在业务代码里随手造） */
export const generateCredentialKey = (): string =>
  randomBytes(ENVELOPE_KEY_BYTES).toString('base64')
