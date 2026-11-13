import { AuditEntity } from '@repo/kits'
import { ToolScope, ToolSource } from '@repo/shared'
import type { AiToolEventModel } from '@repo/shared'
import { Column, Entity, Index } from 'typeorm'

/**
 * **AI 工具配置**（配置类数据，设计 `docs/design/ai-agent-tool-engine.md` §5.5）。
 *
 * 一行 = 一个**注册工具**的可变部分：开关、作用域、限额、工具专属配置、秘钥、文案覆盖。
 * 不可变的那些（参数定义、配置 schema、默认值、执行体）留在代码声明（`ToolSpec`）里 ——
 * 配置的合法性只有声明知道，所以表里只存"值"。
 *
 * 五条口径：
 * - **基础信息是代码声明的镜像**：`title` / `description` / `category` / `param_schema` 由启动期的
 *   种子同步**全量覆盖**写入（代码是唯一事实源）—— 页面只读展示，不提供编辑；
 * - **`config` 允许稀疏**：只存被改过的字段，读取时由 `spec.config.parse(...)` 补默认值；
 *   种子写入时会把 `config.parse({})` 的完整默认值落进去（"没配过"与"配成默认值"要能区分）；
 * - **秘钥明文入库**（工程取舍，2026-10-01 定）：`secrets` 存明文，接口只回从明文派生的提示串；
 *   日志与出参由 `redact` 插件脱敏；
 * - **`source` 只描述"配置"**：`manual` = 人改过配置（种子不覆盖配置），基础信息照样按代码刷新；
 * - **代码里删掉的工具保留配置行**：只记 `last_seen_at`，因为历史 run 的时间线还引用着这个 key。
 */
@Entity('ai_tools')
// 软删感知的唯一键（照 `ai_models` / `ai_providers` 的口径：删掉后可重建同一个 key）
@Index('uk_tool_key', ['toolKey'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_tool_enabled', ['enabled'])
@Index('idx_tool_connector', ['connectorId'])
export class AiToolEntity extends AuditEntity {
  /**
   * **来源**：`code`（代码声明）/ `connector`（连接器产出）。
   *
   * 与 `source` 是两条轴：`source` 记"配置是谁改的"，`origin` 记"工具从哪来"。
   * 种子同步只处理 `origin='code'` 的行（设计 `ai-connector.md` §3.2）。
   */
  @Column({ name: 'origin', type: 'varchar', length: 16, default: 'code' })
  origin = 'code'

  /** 产出它的连接器（`origin='connector'` 时必填）；**追溯只认这一列**，不解析 key */
  @Column({ name: 'connector_id', type: 'varchar', length: 20, nullable: true })
  connectorId: string | null = null

  /** 对方的原始工具名（调用时原样回传；key 变了不影响调用） */
  @Column({ name: 'remote_tool_name', type: 'varchar', length: 128, nullable: true })
  remoteToolName: string | null = null

  /** 工具 key（`modules/ai/tools/tool-keys.ts` 是唯一事实源） */
  @Column({ name: 'tool_key', type: 'varchar', length: 64 })
  toolKey!: string

  /** 标题（**代码声明的镜像**，启动期全量写入；不提供编辑） */
  @Column({ name: 'title', type: 'varchar', length: 128, nullable: true })
  title: string | null = null

  /** 说明（同上） */
  @Column({ name: 'description', type: 'text', nullable: true })
  description: string | null = null

  /** 参数定义的 JSON Schema（**代码声明的镜像**：页面只读展示"模型看到的入参长什么样"） */
  @Column({ name: 'param_schema', type: 'jsonb', nullable: true })
  paramSchema: Record<string, unknown> | null = null

  /**
   * 自定义事件声明（**代码声明的镜像**，设计 §5.17）：启动期全量覆盖写，页面只读。
   *
   * 与 `param_schema` 同一口径：不可变的基础信息留在代码、启动期镜像入库，
   * 于是"这个工具会往流里吐什么"在库里查得到、也能与代码声明对账。
   * 用 `'[]'` 作默认值而不是 NULL：事件是**列表**，"没有事件"与"还没同步过"能区分开。
   */
  @Column({ name: 'events', type: 'jsonb', default: () => "'[]'" })
  events: AiToolEventModel[] = []

  /**
   * 类别（`core` / `business` / `runtime` / `connector`，见 `ToolCategory` 字典）：**冗余列**，由种子同步从声明写过来。
   *
   * 为什么冗余：后台页要按类别筛选与展示，而类别只存在于代码声明里 —— 不落列就没法在 SQL 里筛，
   * 只能先分页再过滤（分页就假了）。它永远是"声明说了算"，人工改不了。
   */
  @Column({ name: 'category', type: 'varchar', length: 16, default: 'core' })
  category = 'core'

  /** 总开关 */
  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled = true

  /** 作用域：见 `ToolScope` 字典 */
  @Column({
    name: 'scope',
    type: 'varchar',
    length: 16,
    default: ToolScope._source.All.value,
  })
  scope: string = ToolScope._source.All.value

  /** `scope='agent'` 时生效的 agent key 清单 */
  @Column({ name: 'allowed_agents', type: 'jsonb', nullable: true })
  allowedAgents: string[] | null = null

  /** 工具专属配置值（稀疏；不含秘钥） */
  @Column({ name: 'config', type: 'jsonb', nullable: true })
  config: Record<string, unknown> | null = null

  /**
   * 秘钥（`{ 字段名: 明文 }`）—— **明文入库**。
   *
   * 工程取舍（2026-10-01 用户决定）：自建 / 内网场景下把"能否直接查库排障"排在"防库泄露"之前。
   * 代价如实记录：**库被读走就等于密钥泄露**（备份、只读账号、日志转储同理）。
   * 补偿措施只有两条：接口不回明文（只回派生的提示串），日志与工具出参走 `redact` 脱敏。
   */
  @Column({ name: 'secrets', type: 'jsonb', nullable: true })
  secrets: Record<string, string> | null = null

  /** 限额：每轮次数、时间窗限流、页大小、每轮取页次数（null = 不限） */
  @Column({ name: 'limits', type: 'jsonb', nullable: true })
  limits: Record<string, unknown> | null = null

  /** 来源：见 `ToolSource` 字典（`seed` 会被种子同步更新，`manual` 不会） */
  @Column({
    name: 'source',
    type: 'varchar',
    length: 16,
    default: ToolSource._source.Seed.value,
  })
  source: string = ToolSource._source.Seed.value

  /** 最后一次在代码声明里出现的时间（"本次未见"看它；不自动禁用、不自动删除） */
  @Column({ name: 'last_seen_at', type: 'timestamp', precision: 3, nullable: true })
  lastSeenAt: Date | null = null
}
