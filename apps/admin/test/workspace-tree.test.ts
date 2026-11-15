import { describe, expect, it } from 'vitest'
import { flattenWorkspaceRows } from '../src/app/(app)/(standalone)/main/ai/chat/files-panel.tsx'

/**
 * 工作区树的「拍平」是虚拟滚动的前提：折叠必须真的**少行**（而不是渲染出来再隐藏），
 * 缩进层级也必须跟着深度走 —— 这两条错了，树看起来就只是"文件少了"。
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
  it('全展开时按深度优先展开，depth 逐层递增', () => {
    const rows = flattenWorkspaceRows(tree as never, new Set())

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

  it('收起的目录只留自己那一行，子树整段不出现', () => {
    const rows = flattenWorkspaceRows(tree as never, new Set(['notes']))

    expect(rows.map((row) => row.path)).toEqual([
      'notes',
      'reports',
      'reports/deep',
      'reports/deep/c.md',
      'root.md',
    ])
  })

  it('收起父目录时，深处被折起来的子目录也不会漏出来', () => {
    // 父收起 + 子也标记为收起：父那一行之后不应再出现 reports/deep
    const rows = flattenWorkspaceRows(tree as never, new Set(['reports', 'reports/deep']))

    expect(rows.map((row) => row.path)).toEqual([
      'notes',
      'notes/a.md',
      'notes/b.md',
      'reports',
      'root.md',
    ])
  })

  it('目录行带直接子项数（收起时显示，区分空目录）', () => {
    const rows = flattenWorkspaceRows(tree as never, new Set(['notes']))
    const notes = rows.find((row) => row.path === 'notes')
    expect(notes?.childCount).toBe(2)
  })
})
