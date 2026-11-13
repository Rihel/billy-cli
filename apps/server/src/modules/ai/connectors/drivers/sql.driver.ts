import { Injectable } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { z } from 'zod'
import { ToolDeniedError } from '../../core/tools/tools.types.js'
import { assertReadOnlySql } from '../sql.policy.js'
import type {
  Capability,
  ConnectorDriver,
  ConnectorFieldDecl,
  ConnectorRuntime,
} from '../connector.types.js'

/**
 * **数据库驱动（PostgreSQL / MySQL）**（设计 `docs/design/ai-connector.md` §3.11）。
 *
 * 三个工具写死在驱动里（不需要对端发现）：`list_tables` / `describe_table` / `query`。
 *
 * 三道闸，缺一不可：
 * 1. **账号必须低权限只读**（部署要求，代码管不了超级用户函数）；
 * 2. `assertReadOnlySql`：只放行单条只读语句；
 * 3. 会话级只读事务 + 语句超时 + 行数上限。
 *
 * 连接用 TypeORM 的 `DataSource`（每个实例一个，`dispose` 时销毁）——这样不用直接依赖
 * `pg` / `mysql2` 的类型；方言差异（事务语法、information_schema、占位符、返回形状）都在这一个文件里。
 */

const SqlConfig = z.object({
  dialect: z.enum(['postgres', 'mysql']).default('postgres'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65_535).default(5432),
  database: z.string().min(1).default('postgres'),
  user: z.string().min(1).default('postgres'),
  /** 单条查询的时长上限（ms） */
  statementTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
  /** 单次最多返回多少行（超出截断并在结果里标注） */
  maxRows: z.number().int().positive().max(5_000).default(200),
})

type SqlConfigValue = z.infer<typeof SqlConfig>

const QUERY_INPUT = {
  type: 'object',
  properties: {
    sql: { type: 'string', description: '一条只读 SQL（SELECT / WITH / EXPLAIN / SHOW）' },
  },
  required: ['sql'],
} as const

const DESCRIBE_INPUT = {
  type: 'object',
  properties: { table: { type: 'string', description: '表名' } },
  required: ['table'],
} as const

@Injectable()
export class SqlDriver implements ConnectorDriver {
  readonly kind = 'sql'
  readonly transport = 'db' as const
  readonly config = SqlConfig
  readonly secrets: readonly ConnectorFieldDecl[] = [
    { key: 'password', label: '密码', type: 'password', secret: true, required: true },
  ]
  readonly auth = { base: 'secret' as const, subject: 'none' as const }

  /** 每个实例一个连接池；键是实例 id（`key` 可复用，不能当身份） */
  private readonly pools = new Map<string, Promise<DataSource>>()

  async describe(): Promise<Capability[]> {
    return [
      {
        kind: 'tool',
        name: 'list_tables',
        title: '列出表',
        description: '列出当前库里的表与视图（只读）',
        inputSchema: { type: 'object', properties: {} },
        risk: 'read',
      },
      {
        kind: 'tool',
        name: 'describe_table',
        title: '看表结构',
        description: '看一张表的列名、类型、是否可空（只读）',
        inputSchema: DESCRIBE_INPUT,
        risk: 'read',
      },
      {
        kind: 'tool',
        name: 'query',
        title: '只读查询',
        description: '执行一条只读 SQL，最多返回配置里定的行数（默认 200）',
        inputSchema: QUERY_INPUT,
        risk: 'read',
      },
    ]
  }

  async invoke(rt: ConnectorRuntime, tool: string, input: unknown): Promise<unknown> {
    const config = SqlConfig.parse(rt.config)
    switch (tool) {
      case 'list_tables':
        return this.runReadOnly(rt, config, this.listTablesSql(config), 500)
      case 'describe_table': {
        const { table } = z.object({ table: z.string().min(1).max(128) }).parse(input)
        return this.runReadOnly(rt, config, this.describeTableSql(config, table), 500)
      }
      case 'query': {
        const { sql } = z.object({ sql: z.string().min(1).max(20_000) }).parse(input)
        assertReadOnlySql(sql)
        return this.runReadOnly(rt, config, sql)
      }
      default:
        throw new ToolDeniedError('unknown-tool', `驱动 ${this.kind} 没有工具 ${tool}`)
    }
  }

  async probe(rt: ConnectorRuntime): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.runReadOnly(rt, SqlConfig.parse(rt.config), 'SELECT 1 AS ok', 1)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  async dispose(instanceId: string): Promise<void> {
    const pool = this.pools.get(instanceId)
    this.pools.delete(instanceId)
    if (!pool) return
    try {
      await (await pool).destroy()
    } catch {
      // 已断开就算了：回收不该抛错
    }
  }

  private async dataSourceOf(rt: ConnectorRuntime, config: SqlConfigValue): Promise<DataSource> {
    const existing = this.pools.get(rt.instanceId)
    if (existing) return existing

    const creating = (async () => {
      const ds = new DataSource({
        type: config.dialect,
        host: config.host,
        port: config.port,
        username: config.user,
        password: rt.secrets.password ?? '',
        database: config.database,
        entities: [],
        synchronize: false,
        // 连接池参数两家的名字不一样：PG 是 max，MySQL 是 connectionLimit（传错 mysql2 会警告）
        extra: config.dialect === 'postgres' ? { max: 2 } : { connectionLimit: 2 },
      } as never)
      await ds.initialize()
      return ds
    })()

    this.pools.set(rt.instanceId, creating)
    try {
      return await creating
    } catch (error) {
      this.pools.delete(rt.instanceId)
      throw new ToolDeniedError(
        'upstream',
        `连不上数据库：${messageOf(error)}`,
        '检查地址、库名与账号密码',
      )
    }
  }

  /** 只读事务里跑一条语句（带超时与行数上限） */
  private async runReadOnly(
    rt: ConnectorRuntime,
    config: SqlConfigValue,
    sql: string,
    maxRows = config.maxRows,
  ): Promise<unknown> {
    const ds = await this.dataSourceOf(rt, config)
    const runner = ds.createQueryRunner()
    await runner.connect()
    try {
      await runner.query(
        config.dialect === 'postgres' ? 'BEGIN READ ONLY' : 'START TRANSACTION READ ONLY',
      )
      // 数值来自已校验的配置，直接内联（SET 不支持参数占位）
      const timeout = Math.trunc(config.statementTimeoutMs)
      await runner.query(
        config.dialect === 'postgres'
          ? `SET LOCAL statement_timeout = ${timeout}`
          : `SET SESSION max_execution_time = ${timeout}`,
      )
      const raw = (await runner.query(sql)) as unknown
      await runner.query('ROLLBACK')

      const records = normalizeRows(raw, config.dialect)
      const truncated = records.length > maxRows
      return toTable(records.slice(0, maxRows), truncated)
    } catch (error) {
      await runner.query('ROLLBACK').catch(() => undefined)
      if (error instanceof ToolDeniedError) throw error
      throw new ToolDeniedError('upstream', `查询失败：${messageOf(error)}`)
    } finally {
      await runner.release()
    }
  }

  private listTablesSql(config: SqlConfigValue): string {
    if (config.dialect === 'mysql') {
      return `SELECT table_schema, table_name, table_type
                FROM information_schema.tables
               WHERE table_schema = DATABASE()
               ORDER BY table_name`
    }
    return `SELECT table_schema, table_name, table_type
              FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
             ORDER BY table_schema, table_name`
  }

  private describeTableSql(config: SqlConfigValue, table: string): string {
    const escaped = table.replace(/'/g, "''")
    if (config.dialect === 'mysql') {
      return `SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns
               WHERE table_schema = DATABASE() AND table_name = '${escaped}'
               ORDER BY ordinal_position`
    }
    return `SELECT column_name, data_type, is_nullable, column_default
              FROM information_schema.columns
             WHERE table_name = '${escaped}'
             ORDER BY ordinal_position`
  }
}

/**
 * 结果压成**列式**（`columns` + 二维 `rows`）。
 *
 * 为什么不用对象数组：一页 26 张表 × 15 列时，每行都把 `column_name` / `data_type` 这些
 * 键名重复一遍，token 全花在键名上。列式只写一次表头，同样的数据大约省一半以上。
 */
const toTable = (records: unknown[], truncated: boolean) => {
  const first = records[0]
  const columns =
    first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first) : []
  const rows = records.map((row) =>
    Array.isArray(row)
      ? row
      : columns.map((column) => (row as Record<string, unknown>)[column] ?? null),
  )
  return { columns, rows, truncated }
}

/** MySQL 的 `query()` 返回 `[rows, fields]`，PG 直接返回 rows */
const normalizeRows = (raw: unknown, dialect: SqlConfigValue['dialect']): unknown[] => {
  if (Array.isArray(raw) && dialect === 'mysql' && Array.isArray(raw[0])) {
    return raw[0] as unknown[]
  }
  return Array.isArray(raw) ? raw : []
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
