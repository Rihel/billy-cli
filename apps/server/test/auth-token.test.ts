import { describe, expect, it } from 'vitest'
import type { Request } from 'express'
import { extractToken } from '../src/common/security/authentication.js'

const request = (headers: Record<string, string | undefined>): Request =>
  ({ headers }) as Request

describe('extractToken：按身份体系读不同 cookie', () => {
  it('Authorization 优先于 cookie', () => {
    expect(
      extractToken(
        request({
          authorization: 'Bearer header-token',
          cookie: 'access-token=user-cookie; admin-access-token=admin-cookie',
        }),
        'admin',
      ),
    ).toBe('header-token')
  })

  it('user 只认 access-token，不会误读 admin-access-token', () => {
    expect(
      extractToken(request({ cookie: 'admin-access-token=admin-cookie' }), 'user'),
    ).toBeUndefined()
    expect(
      extractToken(request({ cookie: 'access-token=user-cookie' }), 'user'),
    ).toBe('user-cookie')
  })

  it('admin 只认 admin-access-token，不会误读 user access-token', () => {
    expect(
      extractToken(request({ cookie: 'access-token=user-cookie' }), 'admin'),
    ).toBeUndefined()
    expect(
      extractToken(request({ cookie: 'admin-access-token=admin-cookie' }), 'admin'),
    ).toBe('admin-cookie')
  })

  it('any 两个 cookie 都认，优先 user（兼容原有行为）', () => {
    expect(
      extractToken(request({ cookie: 'access-token=user-cookie; admin-access-token=admin-cookie' })),
    ).toBe('user-cookie')
    expect(
      extractToken(request({ cookie: 'admin-access-token=admin-cookie' })),
    ).toBe('admin-cookie')
  })
})
