/** AI Agent 业务配置（应用层）：默认模型标识 + 密钥 + 可选兼容端点 */
export const AgentConfig = Symbol.for('AgentConfig')

export interface AgentConfig {
  /** 默认模型标识（`provider/model`）；未配置时 AI 能力整体不可用 */
  model?: string
  /** 模型 API Key；未配置时 AI 能力整体不可用 */
  apiKey?: string
  /** OpenAI 兼容端点地址（自建网关 / 代理）；留空走 provider 默认端点 */
  baseURL?: string

  // ── 上下文策略（schema 与默认值在 apps/server/src/app-config.ts；详见设计文档 §3.9）──
  /** 触发线：估算用量超过「模型窗口 × 本比例」就开始裁剪/压缩 */
  contextTriggerRatio: number
  /** 裁剪目标 */
  contextTrimTargetRatio: number
  /** 压缩目标 */
  contextCompactTargetRatio: number
  /** 最近几轮永不裁 */
  contextKeepRecentTurns: number
  /** 单条工具结果给模型的视图上限（相对窗口） */
  contextToolResultMaxRatio: number
  /** 未知模型的保守窗口 */
  contextFallbackWindow: number
  /** 按模型覆盖窗口（最高优先） */
  contextModelWindows: Record<string, number>
  /** 是否开启可恢复执行（durable）：逐步落快照，崩溃后可从快照续跑 */
  durableEnabled: boolean
  /** 心跳超时（ms）：超过即认为这一轮已无人管 */
  heartbeatTimeoutMs: number
  /** 单轮总时长上限（ms） */
  runTimeoutMs: number
  /** 看门狗扫描间隔（ms） */
  watchdogIntervalMs: number
  /** 是否多实例部署（true 时启动自检要求 Redis） */
  multiInstance: boolean

  // ── 子 agent（§3.14.7）──
  /** 同一父 run 下允许创建的子 agent 个数上限 */
  subAgentMaxPerRun: number
  /** 子 agent 深度上限 */
  subAgentMaxDepth: number
  /** 单个子 agent 的步数上限（0 = 沿用 `AGENT_MAX_STEPS`） */
  subAgentMaxSteps: number
  /** 单个子 agent 的墙钟上限（ms；0 = 沿用 `runTimeoutMs`） */
  subAgentTimeoutMs: number

  // ── 命令执行（工具组 `RunCommandTool`，§3.15）──
  /**
   * 是否允许 agent 在本机执行命令行命令。
   *
   * 关掉时工具仍在（装配期工具池必须非空），但每次调用返回"已被关闭"的结论 ——
   * 模型能理解并改口，好过遇到一个不存在的工具。
   */
  commandEnabled: boolean
  /** 单条命令的时长**默认值与硬上限**（ms）：模型传更小就听它的，传更大一律夹到这里 */
  commandTimeoutMs: number
  /** 单条流（stdout / stderr 各自）的输出上限（字节）；超出即截断并终止命令 */
  commandMaxOutputBytes: number
  /** 命令的工作根目录（缺省 = 服务进程工作目录）；agent 传入的 `cwd` 只能在这个目录之内 */
  commandWorkDir?: string

  // ── 工具引擎（设计 ai-agent-tool-engine.md §5.5 / §5.6）──
  /** 单次给模型的工具出参上限（字节）**硬上限**（后台可改工具级阈值，但改不出这个上限） */
  toolPageBytesMax: number
  /** 每轮取页次数**硬上限** */
  toolMaxPagesPerTurnMax: number
}

/**
 * 「模型 + 密钥」齐全才算可用。
 *
 * 不把未配置当成启动失败：模板允许 clone 后先跑通其余功能，
 * 未配置时接口返回 3301 明确告知原因，前端据此展示配置指引。
 */
export const isAgentConfigured = (config: AgentConfig): boolean =>
  Boolean(config.model && config.apiKey)

/** Mastra 模型标识：`provider/model`（model router 靠这个前缀选 provider，故类型上锁死） */
export type AgentModelId = `${string}/${string}`

/** 已确认可用的模型配置（`model` / `apiKey` 必填，由 `isAgentConfigured` 收口） */
export interface ResolvedAgentModel {
  model: AgentModelId
  apiKey: string
  baseURL?: string
}

/**
 * 校验模型标识格式并收窄类型。
 *
 * `provider/model` 是硬格式要求（如 `deepseek/deepseek-chat`）：漏了斜杠 Mastra 无法定位
 * provider，报错会出现在**第一次对话**而不是启动时。默认模型与 agent 覆盖模型共用本函数。
 */
export const toAgentModelId = (modelId: string): AgentModelId => {
  if (!modelId.includes('/')) {
    throw new Error(
      `模型标识必须是 provider/model 形式（如 deepseek/deepseek-chat），当前值: ${JSON.stringify(modelId)}`,
    )
  }
  return modelId as AgentModelId
}

/** 解析并校验模型配置 */
export const resolveAgentModel = (config: AgentConfig): ResolvedAgentModel => ({
  model: toAgentModelId(config.model ?? ''),
  apiKey: config.apiKey ?? '',
  baseURL: config.baseURL,
})
