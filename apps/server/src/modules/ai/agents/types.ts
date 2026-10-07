import type { AgentListModel } from '@repo/shared'

/**
 * 单个 agent 的**应用层定义**（策略）：它是谁、能做什么、用哪套提示词。
 *
 * 刻意只描述「业务意图」，不含任何框架细节（模型对象、Mastra 实例构造都留在 core）——
 * 于是新增 agent 只需在 `agents/` 加一个本类型的常量文件，不碰装配代码。
 */
export interface AgentDefinition {
  /**
   * 对外标识 **agent key**：数据结构字段 / 数据库列 / 前端选择器都用它（全局唯一，注册时校验）。
   *
   * 与 Mastra 的 `Agent.id` 是同一个字符串：装配时由我们映射过去（Mastra 的字段叫 id 是它的接口，
   * 我们的领域词汇统一叫 key，避免两套词混用）。
   */
  key: string
  /** 展示名（前端选择器） */
  name: string
  /** 一句话职责说明（前端选择器渲染；也提醒后来者这个 agent 的边界） */
  description: string
  /**
   * 允许调用的**工具 key 子集**。
   *
   * 能力边界写在这里、而不是靠提示词约束：只读 agent 拿不到写工具，
   * 模型再怎么"想"也调不动（提示词只负责「什么时候用」）。
   * 引用不存在的工具 key 会在 bootstrap 期直接报错（见 `ai.registry.ts` 的校验）。
   */
  tools: readonly string[]
  /**
   * 允许使用的**技能名子集**（`core/skills/catalog/<name>/SKILL.md`）。
   *
   * 与 tools 同一思路：技能也是按角色授权的；未知技能名在装配期报错（见 `SkillLoader.resolve`）。
   */
  skills: readonly string[]
  /** 系统提示词（渲染产物：文本来自 `core/prompts/templates/*.eta`） */
  instructions: string
  /** 覆盖默认模型（多模型时用；本轮留位，装配处已支持） */
  model?: string
}

/**
 * agent 的**未渲染声明**（`agents/*.agent.ts` 写的就是它）。
 *
 * 与 `AgentDefinition` 的差别只有提示词：声明里写「模板名 + 变量」，装配期由
 * `prompts` 引擎渲染成 `instructions` 文本 —— 这样「可用工具」那段能从实际授权清单生成，
 * 提示词与权限不会各写一份、互相漂移。
 */
export interface AgentSpec {
  /** agent key（见 `AgentDefinition.key`） */
  key: string
  name: string
  description: string
  /** 允许调用的工具 key 子集（从 `tools/tool-keys.ts` 取，避免手写魔数） */
  tools: readonly string[]
  /** 允许使用的技能名子集（`core/skills/catalog/<name>/`；未知名字装配期报错） */
  skills?: readonly string[]
  /** 提示词模板：`templates/<template>.eta` + 自定义变量 */
  prompt: { template: string; data?: Record<string, unknown> }
  /** 覆盖默认模型 */
  model?: string
}

/** agent 注册表：按 id 取定义 + 对外清单（前端 agent 选择器的数据源） */
export interface AgentRegistry {
  /** 默认 agent 的 key（前端未选择 / 请求省略 agentKey 时使用） */
  readonly defaultKey: string
  /** 按 key 取定义；不存在返回 undefined */
  get: (agentKey: string) => AgentDefinition | undefined
  /** 解析目标 agent（省略即默认）；**未知 key 抛 `AgentNotFoundError`** */
  resolve: (agentKey?: string) => AgentDefinition
  /** 全部对外画像（按注册顺序） */
  list: () => AgentListModel
  /** 全部定义（装配 Mastra 用） */
  all: () => readonly AgentDefinition[]
  /** 全部 key（日志 / 诊断用） */
  keys: () => string[]
}
