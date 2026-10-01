import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * **密钥改明文存储**（2026-10-01 用户决定），并给 `ai_tools` 加"参数契约镜像"列。
 *
 * 三件事：
 * 1. `ai_providers` 加 `api_key`（text），把已有密文**就地解密回填**（口令取
 *    `AI_MODEL_ENCRYPTION_KEY`，回落 `JWT_SECRET`）—— 解不开的行留 NULL 并告警，
 *    由管理员在后台重填（**不静默写坏值**）；
 * 2. 删掉 `api_key_cipher` 与 `api_key_hint`：提示串现在由明文派生（`hintOf`）；
 * 3. `ai_tools`：`secrets_cipher` → `secrets`（明文），删 `secrets_hint`（派生），
 *    加 `param_schema` jsonb（启动期把代码声明的参数 JSON Schema 全量写进来）。
 *
 * 为什么用 TS 迁移而不是纯 SQL：AES-GCM 解密要在 Node 里做（scrypt 派生 + 认证标签校验）。
 */
export class PlainTextSecrets1790825000000 implements MigrationInterface {
  name = 'PlainTextSecrets1790825000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 供应商密钥：密文 → 明文 ──
    await queryRunner.query(`ALTER TABLE "ai_providers" ADD "api_key" text`)
    const passphrase =
      process.env.AI_MODEL_ENCRYPTION_KEY?.trim() || process.env.JWT_SECRET?.trim() || ''
    const rows: Array<{ id: string; api_key_cipher: string | null }> = await queryRunner.query(
      `SELECT "id", "api_key_cipher" FROM "ai_providers" WHERE "api_key_cipher" IS NOT NULL`,
    )
    if (rows.length > 0) {
      if (!passphrase) {
        console.warn(
          `[迁移] 有 ${rows.length} 个供应商密钥无法回填：缺少 AI_MODEL_ENCRYPTION_KEY / JWT_SECRET，请在后台重填`,
        )
      } else {
        let restored = 0
        for (const row of rows) {
          try {
            const plain = decryptLegacySecret(row.api_key_cipher as string, passphrase)
            await queryRunner.query(`UPDATE "ai_providers" SET "api_key" = $1 WHERE "id" = $2`, [
              plain,
              row.id,
            ])
            restored += 1
          } catch (error) {
            console.warn(
              `[迁移] 供应商 ${row.id} 的密钥解不开（口令变过或密文损坏），已留空待重填：${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          }
        }
        console.log(`[迁移] 供应商密钥回填完成：${restored}/${rows.length}`)
      }
    }
    await queryRunner.query(`ALTER TABLE "ai_providers" DROP COLUMN "api_key_cipher"`)
    await queryRunner.query(`ALTER TABLE "ai_providers" DROP COLUMN "api_key_hint"`)

    // ── 工具表：秘钥换明文列、删提示列、加参数镜像列 ──
    await queryRunner.query(`ALTER TABLE "ai_tools" RENAME COLUMN "secrets_cipher" TO "secrets"`)
    await queryRunner.query(`ALTER TABLE "ai_tools" DROP COLUMN "secrets_hint"`)
    await queryRunner.query(`ALTER TABLE "ai_tools" ADD "param_schema" jsonb`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回滚只能恢复**结构**：明文没法再变回密文（这是单向取舍）
    await queryRunner.query(`ALTER TABLE "ai_tools" DROP COLUMN "param_schema"`)
    await queryRunner.query(`ALTER TABLE "ai_tools" ADD "secrets_hint" jsonb`)
    await queryRunner.query(`ALTER TABLE "ai_tools" RENAME COLUMN "secrets" TO "secrets_cipher"`)
    await queryRunner.query(`ALTER TABLE "ai_providers" ADD "api_key_hint" character varying(32)`)
    await queryRunner.query(`ALTER TABLE "ai_providers" ADD "api_key_cipher" text`)
    await queryRunner.query(`ALTER TABLE "ai_providers" DROP COLUMN "api_key"`)
  }
}

/**
 * 旧的 AES-256-GCM 解密（**内联在迁移里，刻意不 import 源码**）。
 *
 * 迁移是历史：不能依赖会继续演进的 `src/`（那个文件本体已经删掉了）——
 * 内联一份只服务于"把老数据搬过来"的解密逻辑，回滚历史时它仍然跑得动。
 */
const decryptLegacySecret = (payload: string, secret: string): string => {
  const scryptSync = (password: string, salt: string, keylen: number) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('node:crypto') as typeof import('node:crypto')).scryptSync(password, salt, keylen)
  const { createDecipheriv } = require('node:crypto') as typeof import('node:crypto')
  const KDF_SALT = 'billy.ai-model.secret.v1'
  const IV_BYTES = 12
  const TAG_BYTES = 16
  const raw = Buffer.from(payload, 'base64')
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('密文长度不足，缺少 iv / tag / ciphertext')
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(secret, KDF_SALT, 32), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
