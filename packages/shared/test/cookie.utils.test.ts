import { describe, expect, it } from 'vitest'
import { authCookieOptions } from '../src/utils/cookie.utils'

/**
 * 认证 cookie 的安全默认：这是两端曾各抄一份的地方，
 * 所以重点验「默认值不依赖调用方自觉」—— httpOnly / path 必须由本函数固定。
 */
describe('authCookieOptions', () => {
  it('固定附加 httpOnly 与 path=/，同站策略默认 lax', () => {
    const options = authCookieOptions({ maxAge: 60, secure: true })

    expect(options).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60,
      secure: true,
    })
  })

  it('secure 由调用方决定，不会被默认成 true', () => {
    expect(authCookieOptions({ maxAge: 60, secure: false }).secure).toBe(false)
  })

  it('sameSite 可显式覆盖', () => {
    expect(authCookieOptions({ maxAge: 60, secure: true, sameSite: 'strict' }).sameSite).toBe(
      'strict',
    )
  })
})
