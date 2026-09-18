import { describe, expect, it } from 'vitest'
import { AppName, ThemeKey, TokenKey } from '../src/lib/constants'

/**
 * admin 应用私有取值的契约测试（node 环境）。
 *
 * 为什么值得锁：admin 与前台可能同域部署，`localStorage` 与 cookie 是共享的 ——
 * 主题 key / 凭证 key 一旦撞上，就会出现「切后台主题把前台也改了」「登出后台把前台也蹬了」
 * 这类只在特定部署形态下复现的问题。主题能力本身（三态判定 / 持久化）由 `@repo/ui` 的
 * `theme.test.ts` / `theme-hook.test.tsx` 覆盖，这里只锁 admin 自己的取值。
 */
describe('admin 应用私有取值', () => {
  it('主题 key 与前台分开（前台是 billy-theme）', () => {
    expect(ThemeKey).toBe('billy-admin-theme')
    expect(ThemeKey).not.toBe('billy-theme')
  })

  it('凭证 key 与前台分开（前台是 access-token）', () => {
    expect(TokenKey).toBe('admin-access-token')
    expect(TokenKey).not.toBe('access-token')
  })

  it('产品名统一为 Billy CLI', () => {
    expect(AppName).toBe('Billy CLI')
  })
})
