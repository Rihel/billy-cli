import { describe, expect, it } from 'vitest'
import { flattenWorkspaceRows } from '../src/app/(app)/(standalone)/main/ai/chat/files-panel.tsx'

/**
 * 工作区树的「拍平」是虚拟滚动的前提：展开必须真的**多行**、收起必须真的**少行**
 * （而不是渲染出来再隐藏），缩进层级也必须跟着深度走 —— 这两条错了，树看起来就只是"文件少了"。
 *
 * 默认口径：**空集合 = 全部收起**，只出第一层。
 */
const file = (path: string) => ({
  name: path.split('/').pop() ?? path,
  path,
  type: 'file' as const,
  file: { path, bytes: 1, mtime: '2026-11-15T00:00:00.000Z' },
})

const dir = (path: string, children: ReturnType<typeof file>[] | unknown[]) => ({
  name: path.split('/').pop() ?? path,
  path,
  type: 'dir' as const,
  children: children as never,
})

const tree = [
  dir('notes', [file('notes/a.md'), file('notes/b.md')]),
  dir('reports', [dir('reports/deep', [file('reports/deep/c.md')])]),
  file('root.md'),
]

describe('flattenWorkspaceRows（工作区树 → 可见行）', () => {
  it('空集合 = 全部收起，只出第一层', () => {
    const rows = flattenWorkspaceRows(tree as never, new Set())

    expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual([
      '0:notes',
      '0:reports',
      '0:root.md',
    ])
  })

  it('展开的目录按深度优先出子树，depth 逐层递增', () => {
    const rows = flattenWorkspaceRows(tree as never, new Set(['notes', 'reports', 'reports/deep']))

    expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual([
      '0:notes',
      '1:notes/a.md',
      '1:notes/b.md',
      '0:reports',
      '1:reports/deep',
      '2:reports/deep/c.md',
      '0:root.md',
    ])
  })

  it('展开父目录不会顺带展开子目录', () => {
    const rows = flattenWorkspaceRows(tree as never, new Set(['notes', 'reports']))

    expect(rows.map((row) => row.path)).toEqual([
      'notes',
      'notes/a.md',
      'notes/b.md',
      'reports',
      'reports/deep',
      'root.md',
    ])
  })

  it('目录行带直接子项数（收起时显示，区分空目录）', () => {
    const rows = flattenWorkspaceRows(tree as never, new Set())
    const notes = rows.find((row) => row.path === 'notes')
    expect(notes?.childCount).toBe(2)
  })
})
