import { AuditEntity } from '@repo/kits'
import { ConnectorAuthBase, ConnectorAuthSubject, ConnectorKind, ConnectorStatus, ConnectorTransport } from '@repo/shared'
import { Column, Entity, Index } from 'typeorm'

/**
 * **连接器实例**（设计 `docs/design/ai-connector.md` §3.2）。
 *
 * 一行 = 一个外部能力来源（一个库、一个 MCP 地址、一个命令行工具）。
 * 不可变的东西（怎么连、怎么调、能力从哪来）在驱动的代码里；这里只存**值**。
 *
 * 五条口径：
 * - **密钥明文入库**（沿用 2026-10-01 的工程取舍）：接口只回 `hintOf` 派生的提示串；
 * - **`status` 只是"上次测试的结论"**，不是实时连接状态（本期不做常驻会话，见 §3.7）；
 * - **`allowed_tools` 是白名单**（null = 全开），工具太多时用它收口；
 * - **工具行不在这里**：连接器产出的工具仍写在 `ai_tools`（`origin='connector'` + `connector_id`）；
 * - **软删后 key 可复用**：唯一索引带 `deleted_at IS NULL` 条件（与 `ai_tools` 同口径）。
 */
@Entity('ai_connectors')
@Index('uk_connector_key', ['key'], { unique: true, where: 'deleted_at IS NULL' })
@Index('idx_connector_enabled', ['enabled'])
export class AiConnectorEntity extends AuditEntity {
  /** 实例 key：小写字母 / 数字 / 连字符，1~32 位；产出的工具 key 用它做前缀 */
  @Column({ name: 'key', type: 'varchar', length: 32 })
  key!: string

  /** 显示名 */
  @Column({ name: 'name', type: 'varchar', length: 64 })
  name!: string

  /** 目录型号（`postgres` / `mysql` / `redis`）：页面据此渲染表单 */
  @Column({ name: 'catalog_kind', type: 'varchar', length: 32, default: '' })
  catalogKind = ''

  /** 驱动标识：`sql` / `redis` / `mcp-http` / `rest`（代码里的实现） */
  @Column({ name: 'driver', type: 'varchar', length: 32 })
  driver!: string

  /** 来源：内置目录 / 管理员自建 */
  @Column({ name: 'kind', type: 'varchar', length: 16, default: ConnectorKind._source.Builtin.value })
  kind: string = ConnectorKind._source.Builtin.value

  /** 传输形态（冗余列，只给页面筛选） */
  @Column({ name: 'transport', type: 'varchar', length: 16, default: ConnectorTransport._source.None.value })
  transport: string = ConnectorTransport._source.None.value

  /** 基础层授权（一期只有 none / secret） */
  @Column({ name: 'auth_base', type: 'varchar', length: 16, default: ConnectorAuthBase._source.None.value })
  authBase: string = ConnectorAuthBase._source.None.value

  /** 主体层授权（一期恒 none；二期做用户授权） */
  @Column({ name: 'auth_subject', type: 'varchar', length: 16, default: ConnectorAuthSubject._source.None.value })
  authSubject: string = ConnectorAuthSubject._source.None.value

  /** 非密钥配置（地址 / 库名 / 超时）；空 = 用驱动默认值 */
  @Column({ name: 'config', type: 'jsonb', nullable: true })
  config: Record<string, unknown> | null = null

  /** 密钥明文（`{ 字段名: 明文 }`）；接口只回提示串 */
  @Column({ name: 'secrets', type: 'jsonb', nullable: true })
  secrets: Record<string, string> | null = null

  /** 总开关：关掉后它产出的工具全部不可调 */
  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled = true

  /** 上次测试的结论 */
  @Column({ name: 'status', type: 'varchar', length: 16, default: ConnectorStatus._source.Unknown.value })
  status: string = ConnectorStatus._source.Unknown.value

  /** 最近一次失败的原文（脱敏后） */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null = null

  /** 最近一次测试 / 同步时间 */
  @Column({ name: 'last_checked_at', type: 'timestamp', precision: 3, nullable: true })
  lastCheckedAt: Date | null = null

  /** 上次同步到的工具数（页面用，避免每次 count ai_tools） */
  @Column({ name: 'tool_count', type: 'int', default: 0 })
  toolCount = 0

  /** 工具白名单（null = 全开） */
  @Column({ name: 'allowed_tools', type: 'jsonb', nullable: true })
  allowedTools: string[] | null = null

  /**
   * 驱动自己的**授权状态快照**（如 lark-cli 的 HOME：配置文件 + 用户 token）。
   *
   * 为什么要存库：pod 是无状态的、不挂 PVC；CLI 的 token 在磁盘上，
   * 进程一换就丢。驱动在调用前 hydrate 到临时目录、调用后 diff 写回这里。
   * 结构由驱动自己解释，别在上层遍历。
   */
  @Column({ name: 'auth_state', type: 'jsonb', nullable: true })
  authState: Record<string, unknown> | null = null

  /** 授权状态的版本号：写回用 CAS（`version` 不匹配说明别的实例先写了） */
  @Column({ name: 'auth_state_version', type: 'int', default: 0 })
  authStateVersion = 0
}
