import { describe, expect, it } from 'vitest'
import { formatStorageUrl, Pages } from '../src/lib/constants.ts'

/**
 * web 前台纯逻辑测试样板（node 环境，无需 DOM）。
 * 组件 / hook 级测试样板见 `@repo/ui` 的 `test/tag.test.tsx` 与 `test/use-stream.test.ts`。
 */
describe('formatStorageUrl', () => {
  it('空 key 返回空串（避免渲染出裸 storage 域名）', () => {
    expect(formatStorageUrl('')).toBe('')
  })

  it('已是完整 URL 时原样返回（外部图床 / CDN 地址）', () => {
    expect(formatStorageUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png')
    expect(formatStorageUrl('http://cdn.example.com/a.png')).toBe('http://cdn.example.com/a.png')
  })

  it('对象存储 key 拼接为完整 URL', () => {
    const url = formatStorageUrl('avatar/2026/a.png')

    expect(url.endsWith('/avatar/2026/a.png')).toBe(true)
    expect(url.startsWith('http')).toBe(true)
  })
})

describe('Pages 常量', () => {
  it('页面路径以 / 开头（供 Link / redirect 使用）', () => {
    for (const path of Object.values(Pages)) {
      expect(path.startsWith('/')).toBe(true)
    }
  })
})
