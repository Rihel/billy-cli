/**
 * 读 `dataSource.query()` 执行 DML（`UPDATE ... RETURNING` / `INSERT ... RETURNING`）的结果。
 *
 * **TypeORM 的 PostgresQueryRunner 对 DML 返回的是 `[rows, affected]` 这个结构化结果**，
 * 不是 rows 数组本身。直接写 `rows.length` 会恒为 2，把「一行都没更新」
 * 误判成「更新成功」—— 条件更新（CAS）、租约释放、快照写入的「有没有命中」判断会全部失真。
 * `SELECT` 仍然返回普通 rows 数组，所以本函数两种形状都接受。
 *
 * 用法：
 * ```ts
 * const rows = affectedRowsOf<{ id: string }>(await db.dataSource.query(sql, params))
 * if (rows.length === 0) // 没命中
 * ```
 */
export const affectedRowsOf = <T>(result: unknown): T[] => {
  if (!Array.isArray(result)) return []
  const [first, second] = result
  // [rows, affected] 形状：第一项是数组、第二项是数字
  if (Array.isArray(first) && typeof second === 'number') return first as T[]
  return result as T[]
}
