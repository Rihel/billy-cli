import { StorageKeyForbiddenError, StorageKeyInvalidError } from './errors.js'

/**
 * 前台用户的对象命名空间前缀。
 *
 * 为什么用前缀而不是单独的桶：一个桶内用前缀即可隔离，运维成本最低；前缀也让「谁的文件」
 * 在存储层可辨认，便于审计与孤儿对象清理（见 `docs/design/storage-access-policy.md`）。
 */
export const userKeyPrefix = (userId: string): string => `user/${userId}/`

/**
 * 取 key 的最后一段并做白名单过滤（只留 `A-Za-z0-9._-`）。
 *
 * 这一步是防越权的核心：清掉 `/` 与 `..` 之后，前台用户既不能目录穿越（`../../x`），
 * 也不能伪造他人前缀（`user/别人/x.png` 会被压成 `x.png` 再落到自己的前缀下）。
 */
const safeBasename = (key: string): string => {
  const last = key.split('/').pop() ?? ''
  return last.replace(/[^A-Za-z0-9._-]/g, '')
}

/**
 * 上传 key 策略：管理员与无身份（`AUTH_ENABLED=false`）原样放行；前台用户**强制改写**
 * 进自己的命名空间。
 *
 * 「改写」而不是「校验」的原因：前端用 `md5 + 扩展名` 生成扁平 key（见
 * `packages/ui/src/components/use-storage.ts`），它不知道自己是谁；而响应模型
 * `StoragePresignedUrlModel` 带 `key` 且前端**用的是响应里的 key**（`key: presigned.key`），
 * 所以服务端可以安全改写并让前端据此落库。
 */
export const resolveUploadKey = (input: { key: string; userId?: string | null }): string => {
  const raw = input.key?.trim() ?? ''
  if (!raw) throw new StorageKeyInvalidError(input.key ?? '')

  // 管理员 / 鉴权关闭：保持既有行为（key 原样），不破坏历史对象路径
  if (!input.userId) return raw

  const name = safeBasename(raw)
  if (!name) throw new StorageKeyInvalidError(raw)
  return `${userKeyPrefix(input.userId)}${name}`
}

/**
 * 下载 key 策略：管理员与无身份放行；前台用户必须落在自己的前缀内，否则 403。
 *
 * 与上传不同，下载**不能改写**：下载必须命中已存在的对象，改写后的 key 指向别处
 * （甚至不存在的对象），只能拒绝越界请求。
 */
export const assertDownloadKey = (input: { key: string; userId?: string | null }): void => {
  const raw = input.key?.trim() ?? ''
  if (!raw) throw new StorageKeyInvalidError(input.key ?? '')

  if (!input.userId) return
  if (!raw.startsWith(userKeyPrefix(input.userId))) {
    throw new StorageKeyForbiddenError(raw)
  }
}
