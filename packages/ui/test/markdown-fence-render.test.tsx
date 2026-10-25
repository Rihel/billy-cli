import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { MessageResponse } from '../src/components/ai-elements/message.tsx'
import { GsapFence } from '../src/components/ai-elements/markdown-fences/gsap-fence.tsx'
import { HtmlFence } from '../src/components/ai-elements/markdown-fences/html-fence.tsx'
import { JsonFence } from '../src/components/ai-elements/markdown-fences/json-fence.tsx'
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

const htmlFenceMarkdown = ['```html', '<div id="demo">你好</div>', '```'].join('\n')

describe('沙箱围栏', () => {
  it('围栏没闭合时只出占位，不建 iframe', () => {
    const { container } = render(
      <HtmlFence code={'<div id="demo">你好'} isIncomplete language="html" />,
    )
    expect(container.querySelector('[data-fence-pending="html"]')).not.toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('闭合后进沙箱：不带 same-origin、文档里带禁网 CSP', async () => {
    const { container } = render(<HtmlFence code={'<div id="demo">你好</div>'} isIncomplete={false} language="html" />)

    const frame = container.querySelector('iframe')
    expect(frame).not.toBeNull()
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin')

    await waitFor(() => {
      expect(frame?.getAttribute('srcdoc') ?? '').toContain('Content-Security-Policy')
    })
    expect(frame?.getAttribute('srcdoc') ?? '').toContain('<div id="demo">你好</div>')
  })

  it('全屏：弹窗里另起一个同权限的沙箱 iframe（脚本重跑一遍）', async () => {
    const { container, getByLabelText } = render(
      <HtmlFence code={'<div id="demo">你好</div>'} isIncomplete={false} language="html" />,
    )
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())

    fireEvent.click(getByLabelText('全屏查看'))

    const dialog = await waitFor(() => {
      const element = document.querySelector('[data-slot="dialog-content"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })

    const frame = dialog.querySelector('iframe')
    expect(frame).not.toBeNull()
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(frame?.getAttribute('title') ?? '').toContain('全屏')
    // 内联那张还在（弹窗关掉就回到它）
    expect(container.querySelector('iframe')).not.toBeNull()
  })

  it('gsap 围栏会去取内置脚本（取不到时报错而不是空白）', async () => {
    const { container } = render(<GsapFence code={'<div id="stage"></div>'} isIncomplete={false} language="gsap" />)
    await waitFor(() => {
      expect(container.textContent ?? '').toContain('沙箱运行环境没准备好')
    })
    expect(container.querySelector('iframe')).toBeNull()
  })
})

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

describe('JSON 围栏', () => {
  it('生成中只出占位（半截 JSON 解析不了）', () => {
    const { container } = render(
      <JsonFence code={'{"name": "bil'} isIncomplete language="json" />,
    )
    expect(container.querySelector('[data-fence-pending="json"]')).not.toBeNull()
    expect(container.querySelector('[data-json-view]')).toBeNull()
  })

  it('闭合后按树渲染，键与嵌套值都在', () => {
    const { container } = render(
      <JsonFence code={'{"name":"billy","meta":{"version":2}}'} isIncomplete={false} language="json" />,
    )
    expect(container.querySelector('[data-json-view="tree"]')).not.toBeNull()
    expect(container.textContent ?? '').toContain('name')
    expect(container.textContent ?? '').toContain('version')
  })

  it('```json 围栏命中自定义渲染器，而不是当代码块', async () => {
    const { container } = render(<MessageResponse>{'```json\n{"a":1}\n```'}</MessageResponse>)
    await waitFor(() => {
      expect(container.querySelector('[data-fence="json"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-language="json"]')).toBeNull()
  })
})

describe('注册到 Streamdown 之后', () => {
  it('```html 围栏命中自定义渲染器，而不是当普通代码块', async () => {
    const { container } = render(<MessageResponse>{htmlFenceMarkdown}</MessageResponse>)
    await waitFor(() => {
      expect(container.querySelector('[data-fence="html"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-language="html"]')).toBeNull()
  })

  it('没注册的语言照旧走普通代码块（回归）', () => {
    const { container } = render(<MessageResponse>{'```ts\nconst a = 1\n```'}</MessageResponse>)
    expect(container.querySelector('[data-language="ts"]')).not.toBeNull()
    expect(container.querySelector('[data-fence]')).toBeNull()
  })
})
