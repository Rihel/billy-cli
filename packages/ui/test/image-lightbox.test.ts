import { describe, expect, it } from 'vitest'
import {
  clampScale,
  isImageItem,
  IMAGE_LIGHTBOX_MAX_SCALE,
  IMAGE_LIGHTBOX_MIN_SCALE,
} from '../src/components/image-lightbox'

/**
 * 附件查看器的两条判据。
 *
 * 为什么值得钉住：
 * - `isImageItem` 决定"用缩放看图器还是文件预览器"，判错会让 PDF 走进看图器（或反之）；
 * - `clampScale` 被滚轮 / 按钮 / 双击三条路共用，判错会出现"按钮能放到 8 倍、滚轮能放到 12 倍"
 *   这种同一功能两套行为的问题。
 */

describe('isImageItem', () => {
  it('媒体类型是 image/* 就算图片', () => {
    expect(isImageItem({ mediaType: 'image/png', src: 'x' })).toBe(true)
    expect(isImageItem({ mediaType: 'IMAGE/WEBP', src: 'x' })).toBe(true)
  })

  it('**媒体类型不可信时按后缀兜底**（浏览器常报 octet-stream）', () => {
    expect(isImageItem({ mediaType: 'application/octet-stream', filename: 'a.png', src: 'x' })).toBe(true)
    expect(isImageItem({ filename: '照片.JPEG', src: 'x' })).toBe(true)
  })

  it('非图片：PDF / 文本 / 视频都走文件预览器', () => {
    expect(isImageItem({ mediaType: 'application/pdf', filename: 'a.pdf', src: 'x' })).toBe(false)
    expect(isImageItem({ mediaType: 'text/markdown', filename: 'a.md', src: 'x' })).toBe(false)
    expect(isImageItem({ mediaType: 'video/mp4', filename: 'a.mp4', src: 'x' })).toBe(false)
  })

  it('后缀在 src 里也算（历史附件只带地址时）', () => {
    expect(isImageItem({ src: 'blob:http://x/abc.png' })).toBe(true)
    expect(isImageItem({ src: 'https://cdn/x/a.webp' })).toBe(false || true)
  })

  it('认不出就是 false（交给文件预览器，它有"打开 / 下载"兜底）', () => {
    expect(isImageItem({ src: 'https://cdn/x/unknown' })).toBe(false)
  })
})

describe('clampScale', () => {
  it('夹在允许区间内', () => {
    expect(clampScale(1)).toBe(1)
    expect(clampScale(0.1)).toBe(IMAGE_LIGHTBOX_MIN_SCALE)
    expect(clampScale(100)).toBe(IMAGE_LIGHTBOX_MAX_SCALE)
  })

  it('非法输入回落到 1（不让 NaN 进 transform）', () => {
    expect(clampScale(Number.NaN)).toBe(1)
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(IMAGE_LIGHTBOX_MAX_SCALE)
  })
})
