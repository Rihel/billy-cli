import { credentialAadOf } from '@repo/shared'
import type { PersonalCredentialEntity } from '@repo/db'

/** 参与 AAD 的行字段（写入后不可改：改了必须重新加密，否则解不开） */
interface AadRow {
  id: string
  ownerType: string
  ownerId: string
  provider: string
  template: string
}

/**
 * 一行凭据的 AAD（`docs/design/workspace-cli-credentials.md` §6.4.2）。
 *
 * 绑定、解密、刷新三处必须用**同一个函数**算，否则加密/解密口径迟早分叉。
 */
export const aadOfRow = (row: AadRow): string =>
  credentialAadOf({
    id: row.id,
    ownerType: row.ownerType as 'user' | 'admin',
    ownerId: row.ownerId,
    provider: row.provider,
    template: row.template,
  })

/** 便捷重载：传完整实体 */
export const aadOfEntity = (row: PersonalCredentialEntity): string => aadOfRow(row)
