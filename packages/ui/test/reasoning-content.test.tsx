import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Reasoning, ReasoningContent } from '../src/components/ai-elements/reasoning.tsx'

/**
 * 思考块：限高之后必须自己跟着流式内容滚到底，否则新推理全在可视区下面。
 * 用户在块内往上翻时要暂停跟随（不能把他拽回去），滚回底部再恢复。
 *
 * jsdom 不做真实滚动，这里用属性替身把 scrollHeight / clientHeight 定住，
 * 只验证"什么时候写 scrollTop、写到哪"。
 */
const setupScroll = (
  container: HTMLElement,
  options: { scrollHeight: number; clientHeight: number },
) => {
  const scroller = container.querySelector<HTMLElement>('[data-slot="reasoning-content-scroll"]')
  if (!scroller) throw new Error('找不到思考块的滚动容器')
  let scrollTop = 0
  const setScrollTop = vi.fn((value: number) => {
    scrollTop = value
  })
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    get: () => options.scrollHeight,
  })
  Object.defineProperty(scroller, 'clientHeight', {
    configurable: true,
    get: () => options.clientHeight,
  })
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: setScrollTop,
  })
  return { scroller, setScrollTop }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReasoningContent：流式跟随', () => {
  it('流式期间内容变长 → 滚到底部', () => {
    const { container, rerender } = render(
      <Reasoning isStreaming>
        <ReasoningContent>第一段</ReasoningContent>
      </Reasoning>,
    )
    const { setScrollTop } = setupScroll(container, { scrollHeight: 500, clientHeight: 200 })
    setScrollTop.mockClear()

    rerender(
      <Reasoning isStreaming>
        <ReasoningContent>第一段，又长出一些</ReasoningContent>
      </Reasoning>,
    )

    expect(setScrollTop).toHaveBeenCalledWith(500)
  })

  it('用户往上翻之后暂停跟随，不把他拽回底部', () => {
    const { container, rerender } = render(
      <Reasoning isStreaming>
        <ReasoningContent>第一段</ReasoningContent>
      </Reasoning>,
    )
    const { scroller, setScrollTop } = setupScroll(container, {
      scrollHeight: 500,
      clientHeight: 200,
    })

    // 模拟用户滚到 100：离底部还有 200px，视为"正在往前读"
    fireEvent.scroll(scroller)
    setScrollTop.mockClear()

    rerender(
      <Reasoning isStreaming>
        <ReasoningContent>第一段，又长出一些</ReasoningContent>
      </Reasoning>,
    )

    expect(setScrollTop).not.toHaveBeenCalled()
  })

  it('不在流式时不动滚动位置（历史回放从顶部读）', () => {
    // 非流式默认是收起的；显式打开才有内容可测（从顶部读，不自动滚）
    const { container, rerender } = render(
      <Reasoning defaultOpen>
        <ReasoningContent>历史推理</ReasoningContent>
      </Reasoning>,
    )
    const { setScrollTop } = setupScroll(container, { scrollHeight: 500, clientHeight: 200 })
    setScrollTop.mockClear()

    rerender(
      <Reasoning defaultOpen>
        <ReasoningContent>历史推理，内容更长</ReasoningContent>
      </Reasoning>,
    )

    expect(setScrollTop).not.toHaveBeenCalled()
  })
})
