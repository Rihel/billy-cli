import { describe, expect, it } from 'vitest'
import { cn } from '../src/lib/utils.ts'

describe('cn', () => {
  it('拼接多个类名', () => {
    expect(cn('px-2', 'py-1')).toBe('px-2 py-1')
  })

  it('忽略假值（false / undefined / null / 空串）', () => {
    expect(cn('px-2', false && 'hidden', undefined, null, '')).toBe('px-2')
  })

  it('条件对象语法按真值合并', () => {
    expect(cn('px-2', { hidden: false, block: true })).toBe('px-2 block')
  })

  it('同族 Tailwind 类后者覆盖前者（tailwind-merge 生效）', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
    expect(cn('text-sm', 'text-lg')).toBe('text-lg')
  })

  it('跨族类名不互相覆盖', () => {
    expect(cn('px-2', 'py-4')).toBe('px-2 py-4')
  })
})
