import { describe, expect, it } from 'vitest'
import { resolveNextPath } from '../src/lib/redirect.ts'

describe('resolveNextPath（登录/注册回跳）', () => {
  it('站内相对路径原样返回', () => {
    expect(resolveNextPath('/account')).toBe('/account')
    expect(resolveNextPath('/account?tab=security')).toBe('/account?tab=security')
  })

  it('缺省或空值回落到首页', () => {
    expect(resolveNextPath(null)).toBe('/')
    expect(resolveNextPath(undefined)).toBe('/')
    expect(resolveNextPath('')).toBe('/')
  })

  it('拒绝绝对 URL（防开放重定向）', () => {
    expect(resolveNextPath('https://evil.com')).toBe('/')
    expect(resolveNextPath('http://evil.com/account')).toBe('/')
    expect(resolveNextPath('javascript:alert(1)')).toBe('/')
  })

  it('拒绝协议相对地址（//evil.com 会被浏览器当外部域）', () => {
    expect(resolveNextPath('//evil.com/account')).toBe('/')
  })

  it('可自定义回落地址', () => {
    expect(resolveNextPath(null, '/account')).toBe('/account')
  })
})
