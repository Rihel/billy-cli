import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PromptAttachmentChip } from '../src/components/prompt-attachments.tsx'

afterEach(cleanup)

/**
 * 附件小卡：图片地址失效时**退回文件图标**，而不是给用户一个破图。
 *
 * 触发场景很真实：桶名 / 端口配错、预签名过期、对象被删 —— 地址拼出来是 404。
 * 文件名与大小仍然要看得见（用户得知道"我发过这个文件"）。
 */
describe('PromptAttachmentChip', () => {
  const item = {
    key: 'a',
    filename: 'image.png',
    mediaType: 'image/png',
    bytes: 898_063,
    previewUrl: 'http://localhost:9000/billy-cli/missing.png',
  }

  it('图片能加载时渲染缩略图（原生 img，不走 Next 优化）', () => {
    const { container } = render(<PromptAttachmentChip item={item} />)
    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe(item.previewUrl)
    expect(screen.getByText('image.png')).toBeDefined()
    expect(screen.getByText('877.0 KB')).toBeDefined()
  })

  it('图片加载失败后退回文件图标，文件名与大小仍在', () => {
    const { container } = render(<PromptAttachmentChip item={item} />)
    const image = container.querySelector('img')
    expect(image).not.toBeNull()

    fireEvent.error(image!)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('image.png')).toBeDefined()
    expect(screen.getByText('877.0 KB')).toBeDefined()
  })

  it('没有预览地址的图片直接出文件图标（不发无意义的请求）', () => {
    const { container } = render(
      <PromptAttachmentChip item={{ ...item, previewUrl: undefined }} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('image.png')).toBeDefined()
  })
})
