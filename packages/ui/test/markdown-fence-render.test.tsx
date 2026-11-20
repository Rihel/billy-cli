import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { XflowFence } from '../src/components/ai-elements/markdown-fences/xflow-fence.tsx'

/**
 * 围栏渲染的冒烟测试（真解析 + 真组件，只是把浏览器能力补成 jsdom 的替身）。
 *
 * 这里只管三件事：流式中只出占位、闭合后真的进了沙箱、出错时原文还在。
 * 排版细节在 `markdown-fences.test.ts` 用纯函数测，不在这里看 DOM。
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
  // jsdom 没有这两个观察者，Streamdown（懒渲染）与 React Flow（尺寸测量）都会用到
  Object.assign(globalThis, { IntersectionObserver: Observer, ResizeObserver: Observer })
})

// 没有开 vitest globals 时 testing-library 不会自动清理，上一个用例的 DOM 会留给下一个 ——
// 弹窗与按钮都是按全局查的，不清理就会撞到"找到多个"。
afterEach(() => cleanup())

describe('流程图围栏', () => {
  it('JSON 不合法时给出原因，并把原文留在页面上', () => {
    const { container } = render(
      <XflowFence code={'{ "nodes": [oops] }'} isIncomplete={false} language="xflow" />,
    )
    expect(container.querySelector('[data-fence-error="xflow"]')).not.toBeNull()
    expect(container.textContent ?? '').toContain('JSON')
    expect(container.querySelector('pre')?.textContent ?? '').toContain('oops')
  })

  it('生成中不解析（避免每来一个 token 重排一次）', () => {
    const { container } = render(
      <XflowFence code={'{"nodes":[{"id":"a","lab'} isIncomplete language="xflow" />,
    )
    expect(container.querySelector('[data-fence-pending="xflow"]')).not.toBeNull()
    expect(container.querySelector('[data-fence-error="xflow"]')).toBeNull()
  })
})

/**
 * 画布本身（React Flow）在 jsdom 里会缺一堆测量能力，所以这里换成占位组件 ——
 * 本用例要验的是"按钮开了弹窗、弹窗里挂的是同一份数据"，不是画布能不能画。
 */
vi.mock('../src/components/ai-elements/markdown-fences/xflow-canvas.tsx', () => ({
  XflowCanvas: (props: { fill?: boolean; interactive?: boolean }) => (
    <div
      data-fill={String(Boolean(props.fill))}
      data-interactive={String(Boolean(props.interactive))}
      data-testid="xflow-canvas"
    />
  ),
}))

const xflowCode = JSON.stringify({
  title: '朝廷组织架构',
  nodes: [
    { id: 'emperor', label: '皇帝', kind: 'start' },
    { id: 'cabinet', label: '内阁' },
  ],
  edges: [{ from: 'emperor', to: 'cabinet' }],
})

describe('流程图不附原始 JSON', () => {
  it('渲染成功时只有图，没有「数据」折叠块（那是在重复图本身的信息）', async () => {
    const { container, getByTestId } = render(
      <XflowFence code={xflowCode} isIncomplete={false} language="xflow" />,
    )
    await waitFor(() => expect(getByTestId('xflow-canvas')).toBeTruthy())
    expect(container.querySelector('details')).toBeNull()
    expect(container.textContent ?? '').not.toContain('"nodes"')
  })

  it('解析失败时原文照旧保留（这时候原文才是有用的证据）', () => {
    const { container } = render(
      <XflowFence code={'{"nodes": [oops] }'} isIncomplete={false} language="xflow" />,
    )
    expect(container.querySelector('details')).not.toBeNull()
    expect(container.textContent ?? '').toContain('oops')
  })
})

describe('流程图全屏', () => {
  it('默认只有会话内那张图，没有弹窗', async () => {
    const { container, getByTestId } = render(
      <XflowFence code={xflowCode} isIncomplete={false} language="xflow" />,
    )
    await waitFor(() => expect(getByTestId('xflow-canvas')).toBeTruthy())
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull()
    expect(container.querySelector('[data-fill="false"]')).not.toBeNull()
  })

  it('点「全屏」开弹窗，画布切到撑满 + 可交互，标题一并在', async () => {
    const { getByLabelText, getAllByTestId } = render(
      <XflowFence code={xflowCode} isIncomplete={false} language="xflow" />,
    )

    fireEvent.click(getByLabelText('全屏查看流程图'))

    const dialog = await waitFor(() => {
      const element = document.querySelector('[data-slot="dialog-content"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })

    expect(dialog.textContent ?? '').toContain('朝廷组织架构')
    // 弹窗里那张是撑满 + 可拖动的那张，会话里那张仍然是定高只读的
    expect(dialog.querySelector('[data-fill="true"][data-interactive="true"]')).not.toBeNull()
    expect(getAllByTestId('xflow-canvas')).toHaveLength(2)
  })
})
