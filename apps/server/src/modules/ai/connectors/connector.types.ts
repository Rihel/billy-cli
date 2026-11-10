import type { z } from 'zod'

/**
 * **连接器驱动抽象**（设计 `docs/design/ai-connector.md` §3.4）。
 *
 * 一个驱动回答四个问题，对应六个成员：
 * - 怎么配（`config` / `secrets`）、怎么授权（`auth`）；
 * - 能力从哪来（`describe`）、怎么调（`invoke`）；
 * - 就绪吗（`probe`）、要不要准备与回收（`prepare` / `dispose`）。
 *
 * 三条不变量（写成注释，改代码前先读）：
 * 1. **没有常驻会话的状态机**：每次调用现取；池与缓存是驱动内部的事；
 * 2. 可调用物都是工具、都走网关；文档都是技能、都走技能系统；
 * 3. 能力是"描述出来"的：驱动只交 `Capability[]`，转成工具与技能是运行时统一做的。
 *
 * 本文件**不许 import `@mastra/*`**（`pnpm check:mastra` 会拦）。
 */

/** 连接器对外提供的东西只有两种：可调用的工具、可阅读的技能文档 */
export type Capability =
  | {
      readonly kind: 'tool'
      /** 连接器内的名字（最终工具 key 由我们拼接） */
      readonly name: string
      readonly title: string
      readonly description: string
      /** 给模型的 JSON Schema（`z.fromJSONSchema` 转成入参校验） */
      readonly inputSchema: Record<string, unknown>
      /** 只给页面与告警看，不参与运行时判定 */
      readonly risk?: 'read' | 'write'
    }
  | {
      readonly kind: 'skill-pack'
      readonly dir: string
      readonly name: string
      readonly description: string
    }

/** 字段声明：页面据此渲染表单，脱敏据此取字段（不在两处各写一遍） */
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

/** 一次操作要用到的全部输入（密钥只在这一次操作内使用） */
export interface ConnectorRuntime {
  /** 实例 id（池 / dispose 用它；不要用可复用的 key 做身份） */
  instanceId: string
  /** 实例 key（日志与工具 key 前缀用） */
  key: string
  config: Record<string, unknown>
  secrets: Record<string, string>
  signal?: AbortSignal
}

/** 驱动实现（内置：sql / redis / lark-cli；mcp-http / rest 见设计） */
export interface ConnectorDriver {
  readonly kind: string
  /** 只给页面筛选用 */
  readonly transport: ConnectorTransportValue
  /** 配置定义：每个字段都要有默认值（`parse({})` 必须成功） */
  readonly config: z.ZodType<Record<string, unknown>>
  /** 密钥字段（页面渲染 + 脱敏都用它） */
  readonly secrets: readonly ConnectorFieldDecl[]
  /** 授权要求：声明式，界面照着决定「填表 / 跳链接 / 先装」 */
  readonly auth: {
    readonly base: 'none' | 'secret' | 'install+secret'
    readonly subject?: 'none' | 'oauth' | 'cli-login'
  }
  describe(rt: ConnectorRuntime): Promise<Capability[]>
  invoke(rt: ConnectorRuntime, tool: string, input: unknown): Promise<unknown>
  probe(rt: ConnectorRuntime): Promise<{ ok: boolean; message?: string }>
  prepare?(rt: ConnectorRuntime): Promise<void>
  dispose?(instanceId: string): Promise<void>
}

export type ConnectorTransportValue = 'http' | 'db' | 'process' | 'none'

/** 驱动表（`ai.module.ts` 装配，按 kind 索引） */
export const CONNECTOR_DRIVERS = Symbol.for('ConnectorDrivers')
export type ConnectorDriverMap = ReadonlyMap<string, ConnectorDriver>

/** 目录条目：内置型号的声明（代码，不是数据） */
export interface ConnectorCatalogDecl {
  kind: string
  name: string
  description: string
  driver: string
  transport: ConnectorTransportValue
  category: string
  phase: 'available' | 'coming_soon'
  authHint: string | null
  fields: readonly ConnectorFieldDecl[]
  /**
   * 型号级默认值（合并进 `config`，再交给驱动解析）。
   *
   * 为什么放在型号上：`dialect` 这种区分 PG / MySQL 的字段不是"用户要填的表单字段"，
   * 但它决定驱动连谁——写在型号里才不会出现「选了 MySQL、却用 Postgres 协议连 3306」。
   */
  defaults?: Record<string, unknown>
}
