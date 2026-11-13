import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OverlayScrollbar, thumbBox } from '../src/components/overlay-scrollbar.tsx'

/**
 * 覆盖式滚动条：几何用纯函数钉住，组件只钉「渲染两个隐藏滑块 + 不碰原生滚动」。
 * 真实位置依赖布局，jsdom 量不出来，交给界面验收。
 */
describe('thumbBox（滑块几何）', () => {
  it('内容不溢出 → 不画滑块', () => {
    expect(thumbBox(100, 100, 0)).toEqual({ length: 0, offset: 0 })
    expect(thumbBox(80, 100, 0)).toEqual({ length: 0, offset: 0 })
  })

  it('内容一半 → 滑块占半轨，位置随滚动线性移动', () => {
    expect(thumbBox(200, 100, 0)).toEqual({ length: 50, offset: 0 })
    expect(thumbBox(200, 100, 50)).toEqual({ length: 50, offset: 25 })
    expect(thumbBox(200, 100, 100)).toEqual({ length: 50, offset: 50 })
  })

  it('滑块有最短长度（内容极长时不至于细成一条线）', () => {
    expect(thumbBox(100000, 100, 0).length).toBe(24)
  })

  it('越界的滚动位置被夹在轨道内', () => {
    expect(thumbBox(200, 100, -10).offset).toBe(0)
    expect(thumbBox(200, 100, 999).offset).toBe(50)
  })

  it('1px 的假溢出（取整 / 滚动条占位）不画', () => {
    expect(thumbBox(101, 100, 0)).toEqual({ length: 0, offset: 0 })
  })

  it('容器尺寸为 0（未布局）时不画', () => {
    expect(thumbBox(200, 0, 0)).toEqual({ length: 0, offset: 0 })
  })
})

describe('OverlayScrollbar', () => {
  afterEach(() => {
    cleanup()
  })

  it('渲染两个默认隐藏的滑块，不接管滚动', () => {
    const { container } = render(<OverlayScrollbar />)
    const overlays = container.querySelectorAll<HTMLElement>('.scrollbar-overlay')

    expect(overlays).toHaveLength(2)
    for (const overlay of overlays) {
      expect(overlay.dataset.visible).toBe('false')
    }
  })
})
