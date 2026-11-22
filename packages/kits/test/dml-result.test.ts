import { describe, expect, it } from 'vitest'
import { affectedRowsOf } from '../src/db/dml-result.js'

/**
 * TypeORM 的 PostgresQueryRunner 对 DML 返回 `[rows, affected]` 结构化结果，
 * 而 SELECT 返回普通 rows 数组。这个工具是两处判断「有没有命中」的唯一入口。
 */
describe('affectedRowsOf', () => {
  it('DML 的 [rows, affected] 形状取第一项', () => {
    expect(affectedRowsOf<{ id: string }>([[{ id: 'a' }], 1])).toEqual([{ id: 'a' }])
    // 「一行都没更新」必须得到空数组 —— 裸 rows.length 会得到 2
    expect(affectedRowsOf([[], 0])).toEqual([])
  })

  it('SELECT 的普通 rows 数组原样返回', () => {
    expect(affectedRowsOf([{ id: 'a' }, { id: 'b' }])).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(affectedRowsOf([])).toEqual([])
  })

  it('非数组输入（驱动变化 / undefined）返回空数组，不抛错', () => {
    expect(affectedRowsOf(undefined)).toEqual([])
    expect(affectedRowsOf(null)).toEqual([])
    expect(affectedRowsOf({ rows: [] })).toEqual([])
  })
})
