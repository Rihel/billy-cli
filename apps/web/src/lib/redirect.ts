import { Pages } from './constants'

/**
 * 解析登录 / 注册后的回跳地址（`?next=`）。
 *
 * 只接受**站内相对路径**：拒绝绝对 URL（`https://evil.com`）与协议相对地址（`//evil.com`），
 * 否则 `?next=` 会变成开放重定向（钓鱼跳板的经典入口）。
 */
export function resolveNextPath(
  next: string | null | undefined,
  fallback: string = Pages.home,
): string {
  if (!next) return fallback
  if (!next.startsWith('/') || next.startsWith('//')) return fallback
  return next
}
