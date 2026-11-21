import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { MessageResponse } from '../src/components/ai-elements/message.tsx'

/**
 * 会话正文（Streamdown）的排版契约。
 *
 * 为什么要有这组断言：正文样式是**通过 `components` 覆盖**加进去的（Streamdown 自己不给
 * 段落和链接任何类名），改回裸 `<p>` / 默认 `<a>` 不会有任何类型错误，只有肉眼看才发现
 * 「行高又挤了、链接又变成默认下划线」——这里把两个已定的口径钉住。
 *
 * jsdom 没有观察者，Streamdown 懒渲染会用到；照 `markdown-fence-render.test.tsx` 的写法补桩。
 */
beforeAll(() => {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
    root = null
    rootMargin = ''
    thresholds = []
  }
  Object.assign(globalThis, { IntersectionObserver: Observer, ResizeObserver: Observer })
})

afterEach(() => cleanup())

describe('会话正文的 Markdown 排版', () => {
  it('段落行高 1.75，外链新窗口 + 品牌淡下划线', async () => {
    const { container } = render(
      <MessageResponse>
        {'一段正文。\n\n[飞书文档](https://my.feishu.cn/docx/example)'}
      </MessageResponse>,
    )
    await waitFor(() => expect(container.querySelector('p')).not.toBeNull())

    expect(container.querySelector('p')?.className).toContain('leading-[1.75]')

    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toContain('noopener')
    expect(link?.className).toContain('decoration-brand/40')
  })

  it('表格：短列不折行，长列封顶', async () => {
    const { container } = render(
      <MessageResponse>
        {
          '| 排名 | 剧名 | 核心数据 |\n| --- | --- | --- |\n| 1 | Stranger Things | 很长的说明文字 |\n'
        }
      </MessageResponse>,
    )
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull())
    // 表头不换行（否则「排名」「题材标签」会被拆成两行）
    expect(container.querySelector('th')?.className).toContain('whitespace-nowrap')
    // 列按内容取宽（不再用 w-full 把短列压折）
    expect(container.querySelector('table')?.className).toContain('w-max')
    expect(container.querySelector('table')?.className).toContain('min-w-full')
    // 单元格内容有宽度上限，长说明才会折行
    expect(container.querySelector('td > div')?.className).toContain('max-w-[22rem]')
  })

  it('站内链接留在当前页（不新开窗口）', async () => {
    const { container } = render(<MessageResponse>{'[会话](/main/ai/chat)'}</MessageResponse>)
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull())
    expect(container.querySelector('a')?.hasAttribute('target')).toBe(false)
  })
})
