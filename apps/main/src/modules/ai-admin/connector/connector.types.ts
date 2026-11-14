import type { z } from 'zod'

/**
 * main 侧连接器管理模块的**本地类型**（设计 `docs/design/ai-connector.md` §3.4）。
 *
 * 为什么要另起一份、不复用 `modules/ai/connectors/connector.types.ts`：
 * 那份类型把「发现能力（`describe`）」与「执行能力（`invoke`）」绑在驱动上，属于
 * agent-runtime 的会话运行面；main 只做控制面，既不该 import Mastra，也不该持有
 * 工具注册机。这里只保留控制面真正需要的四样东西：
 *
 * 1. 目录声明（页面渲染卡片与表单）；
 * 2. 配置契约（校验 + 默认值）；
 * 3. 密钥声明（脱敏提示串）；
 * 4. 连接探活（`test` 只验证连接配置，不注册工具）。
 *
 * **边界**：本模块没有 `describe` / `invoke` / `ToolRegistry`，也没有驱动实例的
 * 连接池与授权状态；同步工具由 agent-runtime 读同一张表后自行完成
 * （见 `connector.notifier.ts` 的事件契约）。
 */

/** 传输形态（对齐 `ConnectorTransport` 字典的取值） */
export type ConnectorTransportValue = 'http' | 'db' | 'process' | 'none'

/** 基础层授权（对齐 `ConnectorAuthBase` 字典的取值） */
export type ConnectorAuthBaseValue = 'none' | 'secret' | 'install+secret'

/** 主体层授权（对齐 `ConnectorAuthSubject` 字典的取值） */
export type ConnectorAuthSubjectValue = 'none' | 'oauth' | 'cli-login'

/** 字段声明：页面据此渲染表单，脱敏据此挑出密钥字段 */
export interface ConnectorFieldDecl {
  key: string
  label: string
  type: 'text' | 'password' | 'url' | 'number'
  /** true → 进 `secrets`；false → 进 `config` */
  secret: boolean
  required?: boolean
  placeholder?: string
  help?: string
}

/**
 * 目录条目：内置型号的声明（代码，不是数据）。
 *
 * 一条型号 = 一份表单 + 一份默认值；实例是数据（`ai_connectors`）。
 */
export interface ConnectorCatalogDecl {
  kind: string
  name: string
  description: string
  /** 驱动标识（`sql` / `redis` / `lark-cli`）：决定配置契约与探活方式 */
  driver: string
  transport: ConnectorTransportValue
  category: string
  phase: 'available' | 'coming_soon'
  authHint: string | null
  fields: readonly ConnectorFieldDecl[]
  /** 型号级默认值（合并进 `config` 后再交给配置契约解析） */
  defaults?: Record<string, unknown>
}

/**
 * 一种驱动的控制面契约。
 *
 * 刻意与运行期驱动分开：运行期驱动多了 `describe` / `invoke` / 连接池 / 授权状态，
 * 这里只要「怎么校验配置」「哪些字段是密钥」「探活怎么做」。
 */
export interface ConnectorSpec {
  driver: string
  transport: ConnectorTransportValue
  /** 配置定义：每个字段都有默认值（`parse({})` 必须成功） */
  config: z.ZodType<Record<string, unknown>>
  /** 密钥字段声明（页面渲染 + 脱敏都靠它） */
  secrets: readonly ConnectorFieldDecl[]
  auth: {
    readonly base: ConnectorAuthBaseValue
    readonly subject?: ConnectorAuthSubjectValue
  }
}

/** 一次探活要用到的输入（密钥只在这一次探活内使用，不落日志） */
export interface ConnectorRuntime {
  /** 实例 id（日志与池身份用；不要拿可复用的 key 当身份） */
  instanceId: string
  /** 实例 key（日志用） */
  key: string
  config: Record<string, unknown>
  secrets: Record<string, string>
}

/** 探活结论：`message` 是给人看的原文（写进 `last_error`） */
export interface ConnectorProbeResult {
  ok: boolean
  message?: string
}

/**
 * 探活端口（可替换实现：单测传 fake，生产用 `ConnectorProbeService`）。
 *
 * 只做连接配置测试：SQL 连一次执行 `SELECT 1`，Redis 发一次 `PING`，
 * lark-cli 只校验配置与密钥（命令行不在 main 执行）。
 */
export interface ConnectorProbePort {
  probe(driver: string, runtime: ConnectorRuntime): Promise<ConnectorProbeResult>
}

/** 探活端口的 DI token（main 本地命名空间，避免与 runtime 的同名 token 混淆） */
export const CONNECTOR_PROBE = Symbol.for('MainConnectorProbe')
