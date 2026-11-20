import { describe, expect, it } from 'vitest'
import { grantStateOf, splitDesired } from '../src/lib/batch-grant'

/**
 * 批量授权的差量判据（node 环境，纯函数）。
 *
 * 为什么值得锁：这两个函数错了，表现是**多授 / 漏收**，界面上看不出来 ——
 * 例如把「部分已授」当成「未授」，一次保存就会把其他条目的授权悄悄收回。
 */
describe('批量授权：主体状态判据', () => {
  const map = new Map<string, Set<string>>([
    ['skill-a', new Set(['user-1', 'user-2'])],
    ['skill-b', new Set(['user-1'])],
    ['skill-c', new Set()],
  ])

  it('全部已授 → all', () => {
    expect(grantStateOf(map, ['skill-a', 'skill-b'], 'user-1')).toBe('all')
  })

  it('部分已授 → some（半选，点一下是全部授予）', () => {
    expect(grantStateOf(map, ['skill-a', 'skill-c'], 'user-1')).toBe('some')
  })

  it('一个都没授 → none', () => {
    expect(grantStateOf(map, ['skill-b', 'skill-c'], 'user-2')).toBe('none')
  })

  it('没有任何授权数据 / 没选条目时一律 none', () => {
    expect(grantStateOf(undefined, ['skill-a'], 'user-1')).toBe('none')
    expect(grantStateOf(map, [], 'user-1')).toBe('none')
  })

  it('条目不在授权表里（没查到）按未授处理，不能算成全部已授', () => {
    expect(grantStateOf(map, ['skill-a', 'skill-missing'], 'user-1')).toBe('some')
  })
})

describe('批量授权：差量拆分', () => {
  it('勾选 → add，取消勾选 → remove，没动过的不出现', () => {
    const desired = new Map<string, 'all' | 'none'>([
      ['user-1', 'all'],
      ['user-2', 'none'],
    ])
    expect(splitDesired(desired)).toEqual({ add: ['user-1'], remove: ['user-2'] })
  })

  it('没有改动时两份差量都是空', () => {
    expect(splitDesired(new Map())).toEqual({ add: [], remove: [] })
  })
})
