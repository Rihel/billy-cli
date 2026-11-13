'use client'

import { useEffect, useRef, type ReactElement } from 'react'

/** 停手多久后淡出（毫秒）；macOS 覆盖式滚动条约 1s，这里稍快 */
const IDLE_MS = 700
/** 滑块视觉厚度（像素）；轨道是 8px，居中放 4px */
const THICKNESS = 4
/** 没有滚动条沟槽时（覆盖式滚动条）距容器边缘的留白 */
const EDGE_INSET = 2
/** 滑块最短长度（像素），太短不好看也不好抓 */
const MIN_THUMB = 24

/** 一段滚动轨道上的滑块几何（纯函数，便于单测） */
export function thumbBox(
  scrollSize: number,
  clientSize: number,
  position: number,
  minLength = MIN_THUMB,
): { length: number; offset: number } {
  // 1px 级别的溢出多半是取整 / 滚动条占位造成的假溢出，不画（否则会出现一条几乎占满轨道的滑块）
  if (clientSize <= 0 || scrollSize - clientSize <= 1) return { length: 0, offset: 0 }
  const track = clientSize
  const length = Math.min(track, Math.max(minLength, (clientSize / scrollSize) * track))
  const maxScroll = scrollSize - clientSize
  const maxOffset = track - length
  const ratio = maxScroll > 0 ? Math.min(1, Math.max(0, position / maxScroll)) : 0
  return { length, offset: ratio * maxOffset }
}

type Metrics = {
  top: number
  left: number
  right: number
  bottom: number
  borderTop: number
  borderRight: number
  borderBottom: number
  borderLeft: number
  scrollTop: number
  scrollLeft: number
  scrollHeight: number
  scrollWidth: number
  clientHeight: number
  clientWidth: number
  /** 纵向滚动条占用的宽度（0 = 覆盖式滚动条） */
  barWidth: number
  /** 横向滚动条占用的高度 */
  barHeight: number
}

const borderCache = new WeakMap<
  Element,
  Pick<Metrics, 'borderTop' | 'borderRight' | 'borderBottom' | 'borderLeft'>
>()
const barNoneCache = new WeakMap<Element, boolean>()

/** 边框宽度读一次就够（滚动过程中不变），避免每帧 getComputedStyle */
function bordersOf(
  el: HTMLElement,
): Pick<Metrics, 'borderTop' | 'borderRight' | 'borderBottom' | 'borderLeft'> {
  const cached = borderCache.get(el)
  if (cached) return cached
  const style = getComputedStyle(el)
  const px = (value: string) => Number.parseFloat(value) || 0
  const borders = {
    borderTop: px(style.borderTopWidth),
    borderRight: px(style.borderRightWidth),
    borderBottom: px(style.borderBottomWidth),
    borderLeft: px(style.borderLeftWidth),
  }
  borderCache.set(el, borders)
  return borders
}

/** `scrollbar-width: none`（`no-scrollbar` / `scrollbar-none`）的容器不该被画滑块 */
function hidesNativeBar(el: HTMLElement): boolean {
  const cached = barNoneCache.get(el)
  if (cached !== undefined) return cached
  const { scrollbarWidth } = getComputedStyle(el) as CSSStyleDeclaration & {
    scrollbarWidth?: string
  }
  const none = scrollbarWidth === 'none'
  barNoneCache.set(el, none)
  return none
}

function measure(el: HTMLElement): Metrics {
  const root = el === document.documentElement
  if (root) {
    const html = document.documentElement
    return {
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      borderTop: 0,
      borderRight: 0,
      borderBottom: 0,
      borderLeft: 0,
      scrollTop: html.scrollTop,
      scrollLeft: html.scrollLeft,
      scrollHeight: html.scrollHeight,
      scrollWidth: html.scrollWidth,
      clientHeight: html.clientHeight,
      clientWidth: html.clientWidth,
      barWidth: Math.max(window.innerWidth - html.clientWidth, 0),
      barHeight: Math.max(window.innerHeight - html.clientHeight, 0),
    }
  }

  const rect = el.getBoundingClientRect()
  const borders = bordersOf(el)
  return {
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    ...borders,
    scrollTop: el.scrollTop,
    scrollLeft: el.scrollLeft,
    scrollHeight: el.scrollHeight,
    scrollWidth: el.scrollWidth,
    clientHeight: el.clientHeight,
    clientWidth: el.clientWidth,
    barWidth: Math.max(
      el.offsetWidth - el.clientWidth - borders.borderLeft - borders.borderRight,
      0,
    ),
    barHeight: Math.max(
      el.offsetHeight - el.clientHeight - borders.borderTop - borders.borderBottom,
      0,
    ),
  }
}

/**
 * 覆盖式滚动条（macOS 观感）：**滚动时才淡入、停手淡出，且只显示被滚动的那一个容器**。
 *
 * 为什么必须自己画：原生滚动条伪元素（`::-webkit-scrollbar-thumb`）**不支持 transition
 * 也不支持 animation**（2026-11-13 用无头 Chrome 实测：过渡与关键帧都被忽略）。所以：
 * - 原生滚动条只保留**交互**（拖拽 / 点轨道 / 键盘），滑块涂成透明；
 * - 视觉由这里两个 fixed 的 4px div 画，`opacity` 过渡就是真淡入淡出；
 * - 只跟踪最近被滚动的元素，因此不会出现"滚一个区域、整页滚动条都亮"。
 *
 * 一条 `scroll` 捕获监听覆盖页面与所有滚动容器（scroll 不冒泡但走捕获阶段），
 * 每个滚动容器不需要包一层、也不改它的 DOM。
 *
 * 跳过两类滚动：`[data-autoscrolling]`（消息流自动跟随）与 `scrollbar-width: none`
 * （`no-scrollbar` / `scrollbar-none`）—— 它们本来就不该有滚动条。
 */
export function OverlayScrollbar(): ReactElement {
  const verticalRef = useRef<HTMLDivElement>(null)
  const horizontalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const vertical = verticalRef.current
    const horizontal = horizontalRef.current
    if (!vertical || !horizontal) return

    let frame = 0
    let idle: ReturnType<typeof setTimeout> | undefined
    let target: HTMLElement | null = null

    const setVisible = (div: HTMLDivElement, visible: boolean) => {
      div.dataset.visible = visible ? 'true' : 'false'
    }

    const place = (
      div: HTMLDivElement,
      box: { top: number; left: number; width: number; height: number } | null,
    ) => {
      if (!box) {
        setVisible(div, false)
        return
      }
      div.style.transform = `translate(${Math.round(box.left)}px, ${Math.round(box.top)}px)`
      div.style.width = `${Math.round(box.width)}px`
      div.style.height = `${Math.round(box.height)}px`
      setVisible(div, true)
    }

    const render = () => {
      frame = 0
      const el = target
      if (!el || !el.isConnected) {
        place(vertical, null)
        place(horizontal, null)
        return
      }
      const m = measure(el)

      // 整个容器都不在视口里：不画（否则会在屏幕外留一条）
      const offscreen =
        m.bottom <= 0 || m.top >= window.innerHeight || m.right <= 0 || m.left >= window.innerWidth

      const y = offscreen
        ? { length: 0, offset: 0 }
        : thumbBox(m.scrollHeight, m.clientHeight, m.scrollTop)
      place(
        vertical,
        y.length > 0
          ? {
              top: m.top + m.borderTop + y.offset,
              left:
                m.barWidth > 0
                  ? m.right - m.borderRight - m.barWidth + (m.barWidth - THICKNESS) / 2
                  : m.right - m.borderRight - THICKNESS - EDGE_INSET,
              width: THICKNESS,
              height: y.length,
            }
          : null,
      )

      const x = offscreen
        ? { length: 0, offset: 0 }
        : thumbBox(m.scrollWidth, m.clientWidth, m.scrollLeft)
      place(
        horizontal,
        x.length > 0
          ? {
              top:
                m.barHeight > 0
                  ? m.bottom - m.borderBottom - m.barHeight + (m.barHeight - THICKNESS) / 2
                  : m.bottom - m.borderBottom - THICKNESS - EDGE_INSET,
              left: m.left + m.borderLeft + x.offset,
              width: x.length,
              height: THICKNESS,
            }
          : null,
      )
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render)
    }

    const scheduleHide = () => {
      if (idle !== undefined) clearTimeout(idle)
      idle = setTimeout(() => {
        idle = undefined
        setVisible(vertical, false)
        setVisible(horizontal, false)
      }, IDLE_MS)
    }

    const onScroll = (event: Event) => {
      const node = event.target
      const el =
        node instanceof Document
          ? document.documentElement
          : node instanceof HTMLElement
            ? node
            : null
      if (!el) return
      // 自动跟随 / 明确不要滚动条的容器：忽略（它们自己也不该出现滑块）
      if (el !== document.documentElement) {
        if (el.closest('[data-autoscrolling]')) return
        if (hidesNativeBar(el)) return
      }
      target = el
      schedule()
      scheduleHide()
    }

    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true })
      if (frame) cancelAnimationFrame(frame)
      if (idle !== undefined) clearTimeout(idle)
      target = null
    }
  }, [])

  return (
    <>
      <div ref={verticalRef} className="scrollbar-overlay" data-visible="false" aria-hidden />
      <div ref={horizontalRef} className="scrollbar-overlay" data-visible="false" aria-hidden />
    </>
  )
}
