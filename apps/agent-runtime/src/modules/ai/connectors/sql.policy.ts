import { ToolDeniedError } from '../core/tools/tools.types.js'

/**
 * 只读 SQL 的判定（设计 `docs/design/ai-connector.md` §3.11）。
 *
 * 这是**第二道闸**：第一道是"连接用只读低权账号"（代码挡不住超级用户函数，
 * 比如 `pg_read_file` / `COPY … TO PROGRAM`），第三道是会话级只读事务。
 *
 * 判据只有两条，刻意保守：
 * 1. 去掉注释与字符串之后，只允许**单条**语句（分号后不能再有内容）；
 * 2. 首关键字必须是 `select / with / explain / show / describe / desc`。
 */

/** 去掉注释与字符串字面量（只为"看关键字与分号"，不用于执行） */
export const stripSqlNoise = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim()

/** 首关键字 */
export const sqlLeadKeyword = (sql: string): string => {
  const match = /^([a-z]+)/i.exec(stripSqlNoise(sql))
  return match ? match[1].toLowerCase() : ''
}

const READ_ONLY_KEYWORDS = new Set(['select', 'with', 'explain', 'show', 'describe', 'desc'])

/** 校验一条 SQL 是否允许执行；不允许时抛 `ToolDeniedError('invalid-input')` */
export const assertReadOnlySql = (sql: string): void => {
  if (!sql.trim()) {
    throw new ToolDeniedError('invalid-input', 'SQL 不能为空', '给一条 SELECT 查询')
  }
  const stripped = stripSqlNoise(sql).replace(/;\s*$/, '')
  if (stripped.includes(';')) {
    throw new ToolDeniedError('invalid-input', '只允许单条语句', '把多条语句拆成多次调用')
  }
  const lead = sqlLeadKeyword(sql)
  if (!READ_ONLY_KEYWORDS.has(lead)) {
    throw new ToolDeniedError(
      'invalid-input',
      '只允许只读查询（SELECT / WITH / EXPLAIN / SHOW / DESCRIBE）',
      '需要写数据请走业务接口，连接器不给写权限',
    )
  }
}
