import { createHash, randomBytes } from 'node:crypto'
import type { ShareState } from '@repo/shared'

/**
 * 分享 token 的纯函数（无 IO，可单测）。
 *
 * - 生成：24 字节随机 → base64url（32 字符、192 bit），与文件 id 无任何推导关系；
 * - 存储：只落 `sha256(token)`，明文只在创建响应里回一次 —— 拖库拿不到可用链接；
 * - 状态：由 `expires_at` / `revoked_at` 与当前时间**派生**，不存状态列、不起定时任务。
 */

export const createShareToken = (): string => randomBytes(24).toString('base64url')

export const hashShareToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export const shareState = (
  row: { expiresAt: Date | null; revokedAt: Date | null },
  now: number = Date.now(),
): ShareState => {
  if (row.revokedAt) return 'revoked'
  if (row.expiresAt && row.expiresAt.getTime() <= now) return 'expired'
  return 'active'
}
