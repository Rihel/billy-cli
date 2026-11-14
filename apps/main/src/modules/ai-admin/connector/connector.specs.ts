import { z } from 'zod'
import type { ConnectorSpec } from './connector.types.js'

/**
 * **连接器配置契约**（main 侧）：一种驱动一份 zod schema + 密钥声明。
 *
 * 这里抄的是 runtime 驱动的 `config` / `secrets` / `auth` 三段（设计 §3.4 / §3.11），
 * 刻意**不抄** `describe` / `invoke` / 连接池 / 授权状态：
 * - 配置合法性是控制面的事（保存前就要拦住坏配置）；
 * - 能力发现与执行是运行期的事（agent-runtime 的 `ConnectorSyncService` 负责）。
 *
 * 两边口径必须一致：schema 的字段名、默认值、密钥字段都照抄 runtime 驱动；
 * 改这里时同步改 runtime 侧，否则会出现「main 存得下、runtime 读出来解析失败」。
 */

/** `sql` 驱动（PostgreSQL / MySQL）：地址 + 账号，密码在 `secrets` */
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

/** `redis` 驱动：地址 + 只读前缀，密码可选 */
const RedisConfig = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65_535).default(6379),
  /** 逻辑库编号 */
  db: z.number().int().min(0).max(15).default(0),
  /** 键前缀（空 = 不限）；只约束读，不改变实际 key */
  keyPrefix: z.string().default(''),
  /** 单次最多返回多少条（scan / hgetall） */
  maxItems: z.number().int().positive().max(1_000).default(100),
  commandTimeoutMs: z.number().int().positive().max(30_000).default(5_000),
})

/** `lark-cli` 驱动：App ID 是配置，App Secret 是密钥 */
const LarkCliConfig = z.object({
  /** 飞书应用的 App ID（不是密钥，可以明文展示） */
  appId: z.string().trim().default(''),
  /** 国内飞书=`feishu`，国际版=`lark` */
  brand: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['feishu', 'lark']))
    .default('feishu'),
  /** 默认身份：auto（有用户授权就用户，否则应用）/ user / bot */
  identity: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['auto', 'user', 'bot']))
    .default('auto'),
  /** 单次命令的超时（毫秒） */
  timeoutMs: z.number().int().positive().max(120_000).default(30_000),
})

/** 驱动表：按驱动标识索引（与 runtime 的 `CONNECTOR_DRIVERS` 同键） */
export const CONNECTOR_SPECS: ReadonlyMap<string, ConnectorSpec> = new Map<string, ConnectorSpec>([
  [
    'sql',
    {
      driver: 'sql',
      transport: 'db',
      config: SqlConfig,
      secrets: [{ key: 'password', label: '密码', type: 'password', secret: true, required: true }],
      auth: { base: 'secret', subject: 'none' },
    },
  ],
  [
    'redis',
    {
      driver: 'redis',
      transport: 'db',
      config: RedisConfig,
      secrets: [],
      auth: { base: 'none', subject: 'none' },
    },
  ],
  [
    'lark-cli',
    {
      driver: 'lark-cli',
      transport: 'process',
      config: LarkCliConfig,
      secrets: [
        {
          key: 'appSecret',
          label: 'App Secret',
          type: 'password',
          secret: true,
          required: true,
          help: '飞书开放平台应用的 App Secret；只写进该实例自己的 CLI 配置，接口不会回显',
        },
      ],
      auth: { base: 'install+secret', subject: 'cli-login' },
    },
  ],
])

/** 按驱动取契约（未知驱动返回 null） */
export const specOfDriver = (driver: string): ConnectorSpec | null =>
  CONNECTOR_SPECS.get(driver) ?? null
