import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UserAvatar } from '../src/components/user-avatar.tsx'

/**
 * 头像兜底规则：没图就「首字符 + 品牌色底」。
 *
 * 断言的是**规则**而不是像素：中文取第一个字、英文取首字母大写、名称缺失回落 `?`、
 * 兜底底色走设计系统 token（`bg-brand`）而不是调色板硬编码。
 */
describe('UserAvatar', () => {
  it('没有头像时用姓名首字符兜底', () => {
    render(<UserAvatar name="张三" />)

    expect(screen.getByText('张')).toBeDefined()
  })

  it('英文名取首字母并大写', () => {
    render(<UserAvatar name="alice" />)

    expect(screen.getByText('A')).toBeDefined()
  })

  it('姓名缺失回落问号', () => {
    render(<UserAvatar name={null} />)

    expect(screen.getByText('?')).toBeDefined()
  })

  it('兜底底色用品牌主色 token', () => {
    render(<UserAvatar name="bob" />)

    const className = screen.getByText('B').className
    expect(className).toContain('bg-brand')
    expect(className).toContain('text-white')
    expect(className).not.toMatch(/(emerald|red|amber|indigo)-\d{2,3}/)
  })

  // 有图时的 img 渲染由 Base UI 的图片加载状态机控制（jsdom 不加载图片，拿不到 img 节点），
  // 这里不测；组件本身只是把 src 透传给 AvatarImage。
})
