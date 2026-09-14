import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm'
import { formatTime } from '@repo/shared'

/**
 * 把 QueryBuilder 还原成「可直接粘进 psql 执行」的完整 SQL。
 *
 * TypeORM 的 `getQuery()` 只给带 `$1/$2` 或 `?` 占位符的语句，排查慢查询 / 复杂 join 时
 * 还得手动对应参数。本函数按占位符顺序把参数值填回去：
 * `Date` 走 {@link formatTime}（与实体时间列精度一致）、`null` → `NULL`、
 * 数字 / 布尔原样、字符串加单引号并转义。
 *
 * **仅用于调试输出**，不要拿返回值去执行 —— 手写转义永远不如绑定参数安全。
 */
export function getFullSqlStatement<T extends ObjectLiteral>(
  builder: SelectQueryBuilder<T>,
): string {
  const [sql, params] = builder.getQueryAndParameters()
  let index = 0

  return sql.replace(/\?/g, () => {
    if (index >= params.length) return '?'
    let value: unknown = params[index++]

    if (value instanceof Date) {
      value = formatTime(value)
    }
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    return `'${String(value).replace(/'/g, "''")}'`
  })
}
