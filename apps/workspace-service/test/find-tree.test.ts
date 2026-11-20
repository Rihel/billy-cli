import { describe, expect, it } from 'vitest'
import { buildFindTreeCommand, parseFindTree } from '../src/workspace/workspace-runtime.service.js'

/** 一次 find 取整棵树（替代逐文件 docker exec）：命令拼装与输出解析 */
describe('buildFindTreeCommand', () => {
  it('用 -not -path 排除噪音目录（不用括号分组，dash 下更稳）', () => {
    const command = buildFindTreeCommand('/workspace', 8, ['node_modules', '.git'])
    expect(command).toContain('-maxdepth 8')
    expect(command).toContain("-not -path '*/node_modules/*'")
    expect(command).toContain("-not -path '*/.git/*'")
    expect(command).not.toContain('\\(')
    expect(command).toContain("-printf '%P\\t%s\\t%T@\\n'")
  })

  it('非法目录名被忽略（防注入），路径里的单引号被转义', () => {
    const command = buildFindTreeCommand("/work/it's", 4, ['bad name', 'ok-dir'])
    expect(command).toContain('*/ok-dir/*')
    expect(command).not.toContain('bad name')
    expect(command).toContain(String.raw`'/work/it'\''s'`)
  })
})

describe('parseFindTree', () => {
  it('解析 路径 / 字节数 / mtime（秒 → 毫秒），坏行跳过', () => {
    const entries = parseFindTree(
      [
        'a.txt\t12\t1700000000.123',
        'dir/b.md\t34\t1700000001.5',
        'broken-line',
        '',
        'x\tNaN\t1',
      ].join('\n'),
    )
    expect(entries).toEqual([
      { path: 'a.txt', size: 12, mtime: 1700000000123 },
      { path: 'dir/b.md', size: 34, mtime: 1700000001500 },
    ])
  })
})
