import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { MessageResponse } from '../src/components/ai-elements/message.tsx'

/**
 * mermaid 围栏的回归测试。
 *
 * Streamdown 把 mermaid 的 diagram 分支挂在**内部 code 组件**上，靠 `data-block` 判定块级；
 * 一旦 `components.pre` 覆盖把 children 截走（CodeMirror 代码块改造时就是这样），
 * mermaid 围栏就会静默退回成"带复制/下载的代码块"。这里用真解析 + 真组件钉住这条链路，
 * 只把 mermaid 渲染器换成替身：本用例验的是"走没走 diagram 分支"，不是图长什么样。
 */
vi.mock('@streamdown/mermaid', () => ({
  mermaid: {
    name: 'mermaid',
    type: 'diagram',
    language: 'mermaid',
    getMermaid: () => ({
      initialize: () => undefined,
      render: async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }),
    }),
  },
}))

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
  // jsdom 没有这两个观察者：Streamdown 的懒渲染（diagram）与 React Flow（尺寸测量）都要用
  Object.assign(globalThis, { IntersectionObserver: Observer, ResizeObserver: Observer })
})

afterEach(() => cleanup())

const mermaidSource = 'flowchart TD\n  A[开始] --> B[结束]'
const mermaidMarkdown = ['正文：', '', '```mermaid', mermaidSource, '```'].join('\n')

describe('mermaid 围栏', () => {
  it('不会被 CodeFence 接管，而是交给 Streamdown 内部的 diagram 分支', async () => {
    const { container } = render(<MessageResponse>{mermaidMarkdown}</MessageResponse>)

    await waitFor(() =>
      expect(container.querySelector('[data-streamdown="mermaid-block"]')).not.toBeNull(),
    )
    // CodeFence 的卡片标记不该出现：出现了就说明 mermaid 被截成了普通代码块
    expect(container.querySelector('[data-code-fence]')).toBeNull()
  })

  it('透传时保留 data-block：按块级处理，不退化成行内代码', async () => {
    const { container } = render(<MessageResponse>{mermaidMarkdown}</MessageResponse>)

    // 少了 data-block，内部 code 组件会走行内分支：mermaid 源码变成一段行内纯文本
    await waitFor(() =>
      expect(container.querySelector('[data-streamdown="mermaid-block"]')).not.toBeNull(),
    )
    expect(container.querySelector('[data-streamdown="inline-code"]')).toBeNull()
    expect(container.textContent ?? '').not.toContain('flowchart TD')
  })
})

describe('其余围栏行为不变', () => {
  it('普通代码块仍交给 CodeFence', () => {
    const { container } = render(<MessageResponse>{'```ts\nconst a = 1\n```'}</MessageResponse>)

    expect(container.querySelector('[data-code-fence="ts"]')).not.toBeNull()
  })

  it('行内代码仍按行内渲染', () => {
    const { container } = render(<MessageResponse>{'这是 `inline` 代码'}</MessageResponse>)

    expect(container.querySelector('[data-streamdown="inline-code"]')).not.toBeNull()
  })

  it('自定义围栏仍交给自己的渲染器，不落到 CodeFence', () => {
    const { container } = render(
      <MessageResponse>{'```xflow\n{ "nodes": [oops] }\n```'}</MessageResponse>,
    )

    expect(container.querySelector('[data-fence="xflow"]')).not.toBeNull()
    expect(container.querySelector('[data-code-fence]')).toBeNull()
  })
})
