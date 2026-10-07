/**
 * 认证 cookie 的配置（web / admin / 脚手架生成的前端共用一份）。
 *
 * 为什么共享：`httpOnly` / `sameSite` / `path` / `secure` 是**安全定义** ——
 * 各端各写一份必然漂移（漏一个 `httpOnly`，token 就能被 XSS 读走）。
 * 各端真正不同的是**取值**（有效期、是否生产），由调用方传入。
 *
 * 服务端专用：调用方在 `'use server'` 模块或 Server Component 里传给 `cookies().set()`。
 */

/** cookie 同站策略（与 `next/headers` 的 `ResponseCookie` 兼容） */
export type CookieSameSite = 'lax' | 'strict' | 'none'

export interface AuthCookieOptionsInput {
  /** 有效期（秒） */
  maxAge: number
  /** 是否附加 `secure`：由调用方判断环境（生产 true），此处不猜 */
  secure: boolean
  /** 同站策略，默认 `lax` */
  sameSite?: CookieSameSite
}

export interface AuthCookieOptions {
  httpOnly: true
  sameSite: CookieSameSite
  path: string
  maxAge: number
  secure: boolean
}

/**
 * 认证 cookie 的安全默认：`httpOnly` + `sameSite=lax` + `path=/`，`secure` 由调用方决定。
 *
 * @example
 * ```ts
 * cookies().set(TokenKey, token, authCookieOptions({
 *   maxAge: 7 * 24 * 60 * 60,
 *   secure: process.env.NODE_ENV === 'production',
 * }))
 * ```
 */
export function authCookieOptions(
  input: AuthCookieOptionsInput,
): AuthCookieOptions {
  return {
    httpOnly: true,
    sameSite: input.sameSite ?? 'lax',
    path: '/',
    maxAge: input.maxAge,
    secure: input.secure,
  }
}
