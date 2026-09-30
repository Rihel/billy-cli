import type { ToolsInput } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import type { InlineSkill } from '@mastra/core/skills'
import type { AgentTool } from '../tools/tools.types.js'

/**
 * **core bean 契约**：跨业务的「运行时能力」，用 `asTools()` 把能力交给 agent。
 *
 * 与「业务工具 bean」（`ai/tools/*.tool.ts`）的分界不是文件位置，而是**依赖方向**：
 * 业务工具体现某个业务模块的操作（注入那个模块的 service），core bean 提供的是
 * 与业务无关的运行时能力（规划、创建子 agent），它要碰会话与运行记录。
 * 把后者塞进业务工具 bean，会让业务模块反向依赖 AI 运行时 —— 方向就错了。
 *
 * 加一个 core bean = 写一个 `@Injectable()` 类 + 在 `ai.module.ts` 的 `AGENT_CORES` 登记一行。
 * 详情见 `docs/design/ai-agent.md` §3.14.1。
 */
export interface AgentCore {
  /** core bean 的 key（诊断 / 日志用；与它提供的工具 key 不是一回事） */
  readonly key: string
  /** 本 core 提供给 agent 的工具（0..n 个） */
  asTools(): readonly AgentTool[]
}

/**
 * 全部 core bean 的注入 token（与 `AGENT_TOOLS` 同一手法：Nest 多 provider 汇总成数组）。
 *
 * `ToolBuilder` 把两个来源拍平成一张 `key → 工具` 表；重复 key 会在启动期直接失败。
 */
export const AGENT_CORES = Symbol.for('AgentCores')

/**
 * **运行时信封**：编排层在发起一轮时放进 Mastra `requestContext` 的上下文。
 *
 * 为什么不让工具自己去找（注入会话服务 / 仓储）：那样子 agent 工具就得依赖 `ToolBuilder`
 * 才能知道"自己能给子 agent 什么工具"，而 `ToolBuilder` 又依赖 core bean → **装配成环**。
 * 由编排层算好、经 `requestContext` 传进去，环就断了，而且「子 agent 能用什么工具」这条规则
 * 只有一处定义（`AgentChatService`）。
 *
 * 用 `setRaw` / `getRaw` 存取（运行时键，不进 schema 校验，见 Mastra 的 `RequestContext` 注释）。
 */
/**
 * **这一轮实际使用的模型**（由编排层从库里解析出来，放进信封）。
 *
 * 与 `ai-model` 模块的 `ResolvedRuntimeModel` **结构一致**（不 import 它是为了不把 core 绑到那个模块）：
 * 编排层解析完直接塞进来，Mastra 的模型函数与子 agent 都从这里取 ——
 * **运行时不存在"没配也能用"的路径**（解析不出来就是 3406，见设计文档 §4.9）。
 */
export interface RuntimeModel {
  /** `ai_models.id` */
  id: string
  /** `<providerSlug>/<modelKey>`（Mastra 的模型标识形态，日志与快照里用它） */
  modelRef: string
  modelKey: string
  displayName: string
  /** 供应商地址（留空走官方端点） */
  baseURL?: string
  /** 供应商类型（`ai_providers.kind`）：运行时靠它判断走官方 SDK 还是通用 OpenAI 兼容 */
  providerKind: string
  /** 解密后的密钥（**只在内存里流转**） */
  apiKey: string
  contextWindow: number | null
}

export interface AgentRuntimeEnvelope {
  /** 当前会话（子 agent 的 run 与时间线都挂在这个会话上） */
  conversationId: string
  /** 当前这一轮（子 agent 拿它当父亲） */
  parentRunId: string
  /** 发起人（子 run 继承，审计用） */
  triggeredBy: string | null
  /** 当前深度（根 = 0；子 agent = 1） */
  depth: number
  /** **本轮使用的模型**（子 agent 继承它，不单独选模型） */
  model: RuntimeModel
  /** 算好的**子 agent 工具面**（全部工具 − 委派类工具） */
  childTools: ToolsInput
  /** 子 agent 的技能面（与父 agent 同一口径） */
  childSkills: readonly InlineSkill[]
  /**
   * **会话开局**的运行环境片段（操作系统 + 当前时间，已渲染成文本）；非首轮为 `undefined`。
   *
   * 为什么由编排层渲染好塞进来、而不是 core 自己拼：提示词文本**只走模板引擎**（本工程硬约定），
   * 而 core（`ai.mastra.ts`）刻意不依赖提示词引擎 —— 它只把这段文本追加到系统提示词后面。
   * 只在首轮出现的理由（前缀缓存）见 `prompts/environment.ts`。
   */
  environment?: string
  /** 当前这一轮的中止信号（用户停止要停整棵树） */
  abortSignal?: AbortSignal
}

/** 运行时信封在 `RequestContext` 里的键名 */
export const AGENT_RUNTIME_KEY = 'billy.agentRuntime'

/**
 * 读运行时信封。
 *
 * 返回 `null` 表示"这个工具不是被我们的编排层调起来的"（配置 / 装配错误）——
 * 调用方必须显式处理，不要伪造一个空信封让子 agent 跑在半真半假的状态里。
 */
export const readAgentRuntime = (
  requestContext: RequestContext | undefined,
): AgentRuntimeEnvelope | null => {
  if (!requestContext) return null
  const value = requestContext.getRaw(AGENT_RUNTIME_KEY)
  return (value as AgentRuntimeEnvelope | undefined) ?? null
}
