'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefCallback } from 'react'
import { useImmer } from 'use-immer'

export type ElementRect = {
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
  x: number
  y: number
  clientWidth: number
  clientHeight: number
  scrollWidth: number
  scrollHeight: number
  scrollLeft: number
  scrollTop: number
  scrollSizeWidth: number
  scrollSizeHeight: number
  restScrollWidth: number
  restScrollHeight: number
  canScrollX: boolean
  canScrollY: boolean
  atScrollStartX: boolean
  atScrollStartY: boolean
  atScrollEndX: boolean
  atScrollEndY: boolean
}

export type RectChangeReason = 'measure' | 'resize' | 'scroll'

export type UseRectOptions = {
  observeResize?: boolean
  observeScroll?: boolean
  observeWindow?: boolean
  box?: ResizeObserverBoxOptions
  onChange?: (rect: ElementRect, reason: RectChangeReason) => void
}

const emptyRect: ElementRect = {
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  x: 0,
  y: 0,
  clientWidth: 0,
  clientHeight: 0,
  scrollWidth: 0,
  scrollHeight: 0,
  scrollLeft: 0,
  scrollTop: 0,
  scrollSizeWidth: 0,
  scrollSizeHeight: 0,
  restScrollWidth: 0,
  restScrollHeight: 0,
  canScrollX: false,
  canScrollY: false,
  atScrollStartX: true,
  atScrollStartY: true,
  atScrollEndX: true,
  atScrollEndY: true,
}

export const measureElement = (element: HTMLElement): ElementRect => {
  const bounds = element.getBoundingClientRect()
  const scrollSizeWidth = Math.max(element.scrollWidth - element.clientWidth, 0)
  const scrollSizeHeight = Math.max(
    element.scrollHeight - element.clientHeight,
    0,
  )
  const restScrollWidth = Math.max(scrollSizeWidth - element.scrollLeft, 0)
  const restScrollHeight = Math.max(scrollSizeHeight - element.scrollTop, 0)

  return {
    width: bounds.width,
    height: bounds.height,
    top: bounds.top,
    right: bounds.right,
    bottom: bounds.bottom,
    left: bounds.left,
    x: bounds.x,
    y: bounds.y,
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
    scrollSizeWidth,
    scrollSizeHeight,
    restScrollWidth,
    restScrollHeight,
    canScrollX: scrollSizeWidth > 0,
    canScrollY: scrollSizeHeight > 0,
    atScrollStartX: element.scrollLeft <= 0,
    atScrollStartY: element.scrollTop <= 0,
    atScrollEndX: restScrollWidth <= 1,
    atScrollEndY: restScrollHeight <= 1,
  }
}

const rectEquals = (left: ElementRect, right: ElementRect) => {
  return (Object.keys(left) as (keyof ElementRect)[]).every(
    (key) => left[key] === right[key],
  )
}

export const useRect = <ElementType extends HTMLElement = HTMLDivElement>({
  observeResize = true,
  observeScroll = true,
  observeWindow = true,
  box = 'border-box',
  onChange,
}: UseRectOptions = {}) => {
  const [element, setElement] = useState<ElementType | null>(null)
  const [rect, setRect] = useImmer<ElementRect>(emptyRect)
  const rectRef = useRef(rect)
  const onChangeRef = useRef(onChange)
  const frameRef = useRef<number | null>(null)
  const reasonRef = useRef<RectChangeReason>('measure')
  onChangeRef.current = onChange

  const ref: RefCallback<ElementType> = useCallback((node) => {
    setElement(node)
  }, [])

  const measure = useCallback(
    (reason: RectChangeReason = 'measure') => {
      if (!element) return null
      const nextRect = measureElement(element)
      if (!rectEquals(rectRef.current, nextRect)) {
        rectRef.current = nextRect
        setRect(nextRect)
        onChangeRef.current?.(nextRect, reason)
      }
      return nextRect
    },
    [element],
  )

  const scheduleMeasure = useCallback(
    (reason: RectChangeReason) => {
      reasonRef.current = reason
      if (frameRef.current !== null) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        measure(reasonRef.current)
      })
    },
    [measure],
  )

  useEffect(() => {
    if (!element) return
    measure()

    const resizeObserver = observeResize
      ? new ResizeObserver(() => scheduleMeasure('resize'))
      : null
    resizeObserver?.observe(element, { box })

    const handleScroll = () => scheduleMeasure('scroll')
    const handleWindowResize = () => scheduleMeasure('resize')

    if (observeScroll) {
      window.addEventListener('scroll', handleScroll, true)
    }
    if (observeWindow) {
      window.addEventListener('resize', handleWindowResize)
    }

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleWindowResize)
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [
    box,
    element,
    measure,
    observeResize,
    observeScroll,
    observeWindow,
    scheduleMeasure,
  ])

  return { ref, element, rect, measure }
}
