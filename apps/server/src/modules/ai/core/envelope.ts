import type { SkillRef } from './skills/skills.types.js'
import type { Toolbox } from './tools/tools.types.js'

/**
 * **运行时信封**：编排层在发起一轮时放进 Mastra `requestContext` 的上下文。
 *
 * 为什么不让工具自己去找（注入会话服务 / 仓储）：子 agent 工具需要"子 agent 能用的工具面"，
 * 而那依赖注册机；若让工具自己注入注册机，装配会成环。由编排层算好、经信封传进去，
 * 环就断了，而且「子 agent 能用什么工具」这条规则只有一处定义（`AgentChatService`）。
 *
 * **信封现在属于主体**：`Toolbox` 与 `SkillRef` 都是我们自己的类型，不带 Mastra 词汇；
 * 与 `RequestContext` 的读写收在 `ai/mastra/context.adapter.ts`（适配器侧）。
 */

/**
 * **这一轮实际使用的模型**（由编排层从库里解析出来，放进信封）。
 *
 * 与 `ai-model` 模块的 `ResolvedRuntimeModel` **结构一致**（不 import 它是为了不把 core 绑到那个模块）：
 * 编排层解析完直接塞进来，Mastra 的模型函数与子 agent 都从这里取 ——
 * **运行时不存在"没配也能用"的路径**（解析不出来就是 3406）。
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
  /**
   * 这个模型的**输入模态**（`["text","image","file"]`；`null` = 未声明）。
   *
   * 直接来自模型实体的独立字段（不再从 `capabilities` 里猜字段名）。附件校验靠它 ——
   * 给收不了图的模型发图，最坏是上游静默忽略，用户以为模型看过了。
   */
  inputModalities: string[] | null
}

export interface AgentRuntimeEnvelope {
  /** 当前会话（子 agent 的 run 与时间线都挂在这个会话上） */
  conversationId: string
  /** 当前这一轮（子 agent 拿它当父亲） */
  parentRunId: string
  /** 发起人（子 run 继承，审计用） */
  triggeredBy: string | null
  /** 触发身份是不是管理员（工具作用域判定用；不由模型决定） */
  isAdmin: boolean
  /**
   * 本会话的**沙箱文件权限**（只读 / 可写）。
   *
   * 只决定沙箱内能不能写工作区；**不能借此逃出沙箱**（能不能出沙箱是部署配置）。
   */
  fileAccess: 'read-only' | 'workspace-write'
  /** 当前深度（根 = 0；子 agent = 1） */
  depth: number
  /** 调用方 agent key（子 agent 为 `sub:<名字>`）——审计用 */
  agentKey: string
  /** **根 agent key**：工具作用域按它判（子 agent 沿用父的判定，见设计 §5.7） */
  rootAgentKey: string
  /** **本轮使用的模型**（子 agent 继承它，不单独选模型） */
  model: RuntimeModel
  /** 算好的**子 agent 工具面**（全部 − 委派类 − `child: deny`） */
  childToolbox: Toolbox
  /** 子 agent 的技能面（与父 agent 同一口径） */
  skills: readonly SkillRef[]
  /**
   * **本轮真正送进模型的系统指令全文**（基础指令 + 首轮运行环境，已渲染）。
   *
   * 为什么由编排层渲染好塞进来、而不是 core 自己拼：提示词文本**只走模板引擎**（本工程硬约定），
   * 而 Mastra 适配器刻意不依赖提示词引擎 —— 它只把这段文本当成系统指令用。
   * 编排层同一份文本还会**落一条 `system` 时间线快照**，于是"模型看到的"与"库里存的"永远是同一个字符串。
   */
  systemPrompt?: string
  /** 当前这一轮的中止信号（用户停止要停整棵树） */
  abortSignal?: AbortSignal
}

/** 运行时信封在 `RequestContext` 里的键名 */
export const AGENT_RUNTIME_KEY = 'billy.agentRuntime'
