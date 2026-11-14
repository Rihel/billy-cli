import type { AiToolEventModel } from '@repo/shared'
import type { AnyToolSpec } from './tools.types.js'

/**
 * 工具配置的**数据结构与端口**（设计 §5.5）：只有"长什么样"和"注入什么 token"，没有逻辑。
 */

/** 配置行的形状（仓储读出来的结果；与实体解耦，测试可以直接造） */
export interface ToolConfigRow {
  enabled: boolean
  scope: string
  allowedAgents: string[] | null
  config: Record<string, unknown> | null
  limits: Record<string, unknown> | null
  title: string | null
  description: string | null
  /** 参数定义的 JSON Schema（代码声明的镜像；老行可能为 null） */
  paramSchema: Record<string, unknown> | null
  /**
   * 自定义事件声明的**镜像**（代码声明是唯一事实源；老行可能是空数组，见设计 §5.17）。
   *
   * 读出来的是 `AiToolEventModel[]`（入库时已归一化），与 `ToolSpec.events` 一一对应。
   */
  events: AiToolEventModel[] | null
  source: string
  /** 配置版本（`updated_at` 的 ISO；用于审计与缓存失效） */
  version: string
  /**
   * 秘钥**明文**（`{ 字段名: 明文 }`）。
   *
   * 明文入库是工程取舍（2026-10-01 决定）：提示串改为**读取时派生**（`hintOf`），
   * 所以这里不再有 `secretHints` 字段。
   */
  secrets: Record<string, string> | null
}

/** 配置来源（仓储实现它；测试给内存实现） */
export const TOOL_CONFIG_SOURCE = Symbol.for('ToolConfigSource')

export interface ToolConfigSource {
  load(spec: AnyToolSpec): Promise<ToolConfigRow | null>
}

/** env 上限的注入 token（生产由 `ai.module` 从 `agent` 配置取，测试给固定值） */
export const TOOL_ENV_CAPS = Symbol.for('ToolEnvCaps')

/** 时间线仓储的注入 token（分页回取用；避免 tools → runtime 的硬耦合） */
export const TIMELINE_REPOSITORY = Symbol.for('TimelineRepository')
