import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Tag } from '../src/components/tag.tsx'

/**
 * 组件级测试样板：演示「用 @testing-library/react 渲染真实组件 + 断言 DOM」的写法，
 * 同时顺带验证 `@repo/ui` 内部的 `#components/*` / `#lib/*` 子路径导入在 vitest 里可解析。
 */
describe('Tag', () => {
  it('渲染子节点文本', () => {
    render(<Tag>已完成</Tag>)

    expect(screen.getByText('已完成')).toBeDefined()
  })

  it('语义预设色映射到设计系统 token，而非硬编码调色板', () => {
    render(<Tag color="success">成功</Tag>)

    const className = screen.getByText('成功').className
    expect(className).toContain('text-success')
    // 反向防线：语义色不得回落成调色板硬编码（改动依据见 docs/design/design-system.md）
    expect(className).not.toMatch(/(emerald|red|amber|indigo)-\d{2,3}/)
  })

  it('未知色名回落默认样式', () => {
    render(<Tag color="不是预设色">未知</Tag>)

    expect(screen.getByText('未知').className).toContain('text-muted-foreground')
  })

  it('hex 颜色走内联样式 + 白色文字，不带预设类', () => {
    render(<Tag color="#123456">自定义</Tag>)

    const node = screen.getByText('自定义')
    expect(node.style.backgroundColor).toBe('rgb(18, 52, 86)')
    expect(node.style.color).toBe('rgb(255, 255, 255)')
    expect(node.className).not.toContain('text-muted-foreground')
  })

  it('className 可与预设色叠加', () => {
    render(
      <Tag color="error" className="tracking-wide">
        错误
      </Tag>,
    )

    const className = screen.getByText('错误').className
    expect(className).toContain('text-destructive')
    expect(className).toContain('tracking-wide')
  })
})
