import { describe, expect, it } from 'vitest'
import {
  ancestorDirsOf,
  buildPreviewTree,
  flattenPreviewTree,
} from '../src/components/file-preview-dialog'

/**
 * 预览弹窗左侧文件树的拍平（侧栏与手机抽屉共用同一份行数据）。
 *
 * 默认口径与右栏文件树一致：**空集合 = 全部收起**，只出第一层；
 * 展开某个目录才把它自己的子目录 / 文件拍进来（下一层仍保持收起）。
 */
const item = (path: string) => ({
  id: `id:${path}`,
  filename: path.split('/').pop() ?? path,
  mediaType: 'text/markdown',
  bytes: 1,
  path,
  url: null,
})

const items = [item('a/x.md'), item('a/b/y.md'), item('root.md')]

const rowsOf = (expanded: string[]): string[] =>
  flattenPreviewTree(buildPreviewTree(items), new Set(expanded)).map((row) =>
    row.type === 'dir' ? `dir:${row.depth}:${row.path}` : `file:${row.depth}:${row.item.path}`,
  )

describe('flattenPreviewTree（预览弹窗文件树）', () => {
  it('空集合 = 全部收起，只出第一层', () => {
    expect(rowsOf([])).toEqual(['dir:0:a', 'file:0:root.md'])
  })

  it('展开父目录得到它自己的子目录与文件，下一层仍收起', () => {
    expect(rowsOf(['a'])).toEqual(['dir:0:a', 'dir:1:a/b', 'file:1:a/x.md', 'file:0:root.md'])
  })

  it('逐层展开，depth 跟深度走', () => {
    expect(rowsOf(['a', 'a/b'])).toEqual([
      'dir:0:a',
      'dir:1:a/b',
      'file:2:a/b/y.md',
      'file:1:a/x.md',
      'file:0:root.md',
    ])
  })
})

describe('ancestorDirsOf（打开预览时自动展开到当前文件）', () => {
  it('由浅到深给出所有祖先目录，不含文件名', () => {
    expect(ancestorDirsOf('a/b/c.md')).toEqual(['a', 'a/b'])
  })

  it('根目录下的文件没有祖先目录', () => {
    expect(ancestorDirsOf('root.md')).toEqual([])
  })

  it('开头多余的斜杠与空段不算目录', () => {
    expect(ancestorDirsOf('/a//c.md')).toEqual(['a'])
  })
})
