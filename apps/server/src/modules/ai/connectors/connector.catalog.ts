import type { ConnectorCatalogDecl } from './connector.types.js'

/**
 * **内置连接器目录**（设计 `docs/design/ai-connector.md` §3.3）。
 *
 * 目录是代码里的常量，只做三件事：渲染后台卡片、给表单提供字段、给驱动提供默认值。
 * 它**不含凭证，也不决定启停**——那些在实例上（`ai_connectors`）。
 *
 * 加一种型号 = 这里加一条 + `drivers/` 里加一个实现（或在现有驱动里加字段）。
 */
export const POSTGRES_CATALOG: ConnectorCatalogDecl = {
  kind: 'postgres',
  name: 'PostgreSQL',
  description: '连一个 PostgreSQL 库，查表结构与只读查询',
  driver: 'sql',
  transport: 'db',
  category: 'database',
  phase: 'available',
  authHint: '建议新建一个只读账号（代码挡不住超级用户函数，账号权限是第一道闸）',
  defaults: { dialect: 'postgres', port: 5432 },
  fields: [
    { key: 'host', label: '主机', type: 'text', secret: false, required: true },
    { key: 'port', label: '端口', type: 'number', secret: false, required: true },
    { key: 'database', label: '库名', type: 'text', secret: false, required: true },
    { key: 'user', label: '账号', type: 'text', secret: false, required: true },
    { key: 'password', label: '密码', type: 'password', secret: true, required: true },
  ],
}

/** MySQL：同一个 `sql` 驱动，方言不同 */
export const MYSQL_CATALOG: ConnectorCatalogDecl = {
  kind: 'mysql',
  name: 'MySQL',
  description: '连一个 MySQL 库，查表结构与只读查询',
  driver: 'sql',
  transport: 'db',
  category: 'database',
  phase: 'available',
  authHint: '建议新建一个只读账号（代码挡不住超级用户函数，账号权限是第一道闸）',
  defaults: { dialect: 'mysql', port: 3306 },
  fields: [
    { key: 'host', label: '主机', type: 'text', secret: false, required: true },
    { key: 'port', label: '端口', type: 'number', secret: false, required: true },
    { key: 'database', label: '库名', type: 'text', secret: false, required: true },
    { key: 'user', label: '账号', type: 'text', secret: false, required: true },
    { key: 'password', label: '密码', type: 'password', secret: true, required: true },
  ],
}

/** Redis：只读三个工具，键前缀限定范围 */
export const REDIS_CATALOG: ConnectorCatalogDecl = {
  kind: 'redis',
  name: 'Redis',
  description: '连一个 Redis，按前缀只读地扫键、读字符串与哈希',
  driver: 'redis',
  transport: 'db',
  category: 'database',
  phase: 'available',
  authHint: '填地址即可；有密码的一起填。建议只读账号或只读实例',
  defaults: { port: 6379 },
  fields: [
    { key: 'host', label: '主机', type: 'text', secret: false, required: true },
    { key: 'port', label: '端口', type: 'number', secret: false, required: true },
    { key: 'db', label: '库编号', type: 'number', secret: false, required: false },
    { key: 'keyPrefix', label: '键前缀', type: 'text', secret: false, required: false, help: '留空 = 不限；建议填业务前缀' },
    { key: 'password', label: '密码', type: 'password', secret: true, required: false },
  ],
}

/**
 * 飞书 CLI：命令行 + 内嵌技能文档（设计 §3.14）。
 *
 * 和数据库类连接器的差别：它没有"工具清单"，能力面只有一个受限的 `run`；
 * 文档由 CLI 内嵌、模型按需用 `skills list/read` 读，不走我们的技能目录。
 * server 镜像默认预装 lark-cli，驱动不做运行时安装。
 */
export const LARK_CLI_CATALOG: ConnectorCatalogDecl = {
  kind: 'lark-cli',
  name: '飞书 CLI',
  description: '通过官方 lark-cli 操作飞书：消息、文档、多维表格、表格、日历、邮件、任务等 20+ 业务域',
  driver: 'lark-cli',
  transport: 'process',
  category: 'office',
  phase: 'available',
  authHint:
    '填飞书开放平台应用的 App ID / App Secret；用户级操作需再走一次 auth login（可在对话里让助手发起）。server 镜像已预装 lark-cli。',
  defaults: { brand: 'feishu', identity: 'auto', timeoutMs: 30_000 },
  fields: [
    { key: 'appId', label: 'App ID', type: 'text', secret: false, required: true, placeholder: 'cli_xxx' },
    { key: 'appSecret', label: 'App Secret', type: 'password', secret: true, required: true },
    {
      key: 'brand',
      label: '品牌',
      type: 'text',
      secret: false,
      required: false,
      placeholder: 'feishu',
      help: '国内飞书填 feishu（默认），国际版填 lark',
    },
    {
      key: 'identity',
      label: '默认身份',
      type: 'text',
      secret: false,
      required: false,
      placeholder: 'auto',
      help: 'auto（默认）/ user / bot；只影响业务域命令，可用 --as 覆盖',
    },
  ],
}

/** 全部内置型号（`/ai-connector/catalog` 返回它） */
export const CONNECTOR_CATALOG: readonly ConnectorCatalogDecl[] = [
  POSTGRES_CATALOG,
  MYSQL_CATALOG,
  REDIS_CATALOG,
  LARK_CLI_CATALOG,
]

/** 按 kind 取型号 */
export const catalogEntryOf = (kind: string): ConnectorCatalogDecl | null =>
  CONNECTOR_CATALOG.find((entry) => entry.kind === kind) ?? null
