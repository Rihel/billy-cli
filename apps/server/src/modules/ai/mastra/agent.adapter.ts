import { createDeepSeek } from '@ai-sdk/deepseek'
import { Agent } from '@mastra/core/agent'
import { resolveModelConfig } from '@mastra/core/llm'
import type { ToolsInput } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import { toAgentModelId, type AgentModelId } from '../core/config.js'
import { decideModelForMastra } from '../core/model-decision.js'
import type { AgentRuntimeEnvelope, RuntimeModel } from '../core/envelope.js'
import { readEnvelope } from './context.adapter.js'

/**
 * **Agent 构造**（适配器，设计 §5.8）：主 agent 与临时子 agent 的 `new Agent(...)` 只在这里出现。
 *
 * 两条与"模型从哪来"绑定的口径（设计 §4.9）：
 * - **模型每次调用从信封里取**（编排层已经从库里解析好）—— 构造期拿不到信封时给**占位模型**，
 *   绝不在构造期抛错（Mastra 构造 durable agent 时会不带 requestContext 求值一次，早先在这里
 *   抛错把服务启动打挂过）；
 * - 真正"没配模型"的收口在编排层（`AgentChatService.resolveRuntimeModel`），解析不出来连流都不建。
 */

/** 占位模型：地址指向本机一个不监听的端口 —— 万一真被用到会立刻连接失败，而不是静默打到真实供应商 */
const PLACEHOLDER_MODEL: { id: AgentModelId; url?: string; apiKey: string } = {
  id: toAgentModelId('placeholder/not-configured'),
  url: 'http://127.0.0.1:1/v1',
  apiKey: 'placeholder',
}

/**
 * `RuntimeModel` → **可直接交给模型的实例**（调用时传给 `agent.stream(..., { model })`）。
 *
 * ## 为什么要有这个函数
 *
 * 我们每轮用哪个模型是**运行时按会话选的**（存在请求信封里），而 Agent 是在装配期建的 ——
 * 所以模型只能"调用时给"。Mastra 允许把 Agent 的 `model` 写成动态参数（函数）来实现这件事，
 * 但**传实例比依赖动态参数更可靠**：动态参数那条路要 Mastra 自己去解析配置，
 * 中间多一层（见下面那次事故），而实例是直接可调的。
 *
 * ## 那次事故（2026-10-07）——**根因在 Mastra，不在这个函数**
 *
 * 症状：发图后模型回答"我没收到图片"，看着像"模型不支持读图"。
 * 实测：`@mastra/core@1.69.0` 在 **`durable: true`**（崩溃恢复，线上默认开）时，
 * 会把多模态消息的 `content` 数组**压平成纯字符串** —— 出站请求只有 **156 字节**、
 * `content: "看图"`，图片被静默丢掉；同一份输入在 `1.78.0` 上是含 `image_url` 的正常请求。
 *
 * 排查时一度误判成"动态 model 参数形态"的问题（当时没意识到 durable 才是变量），
 * 所以**这一条别当结论用**：先看 durable 相关的回归测试
 * （`ai-mastra-contract.test.ts` 的"durable 下的多模态"）。
 *
 * ## 用自己的决定链，不另写判断
 *
 * "走官方适配还是通用兼容"、"官方适配不能传 url"（传了会丢掉思考字段）这些规则都在
 * `decideModelForMastra` 里（那里被单测钉住），这里只负责把它翻译成模型实例。
 */
export const toMastraModelInstance = async (
  model: RuntimeModel,
): Promise<{
  /** 传给 `agent.stream(..., { model })` 的实例 */
  instance: unknown
  /** 传给 `new Agent({ model })` 的描述（占位或按调用求值都用它） */
  config: { id: AgentModelId; url?: string; apiKey: string }
}> => {
  const decision = decideModelForMastra(model)
  /**
   * 官方适配：必须用 provider 自己的工厂，**不能**传 `url`（见 `decideModelForMastra` 的注释）。
   * 目前唯一接官方适配的是 DeepSeek，所以这里只需认它；将来新增官方适配时**必须同步扩这里**，
   * 否则那个供应商会掉到通用兼容层（思考等私有字段随之丢失）。
   */
  if (decision.officialAdapter && model.providerKind === 'deepseek') {
    return {
      instance: createDeepSeek({ apiKey: model.apiKey })(model.modelKey as never),
      config: decision.model,
    }
  }
  // 其余：交给 Mastra 的模型解析（它认识 `id` / `url` / `apiKey` 这套配置）
  return {
    instance: await resolveModelConfig(decision.model as never),
    config: decision.model,
  }
}

/** `RuntimeModel` → Mastra 的模型描述（`url` 留空即走官方端点） */
export const toMastraModel = (model: RuntimeModel): { id: AgentModelId; url?: string; apiKey: string } => ({
  id: toAgentModelId(model.modelRef),
  ...(model.baseURL ? { url: model.baseURL } : {}),
  apiKey: model.apiKey,
})

export interface MastraAgentOptions {
  id: string
  name: string
  /** 系统指令：可以是固定文本，也可以按调用求值（主 agent 用后者：拿信封里的渲染全文） */
  instructions: string | ((args: { requestContext: RequestContext }) => string)
  /** 模型：按调用从信封取（主 agent），或固定（临时子 agent 继承父这一轮的模型） */
  model: (args: { requestContext: RequestContext }) => { id: AgentModelId; url?: string; apiKey: string }
  /**
   * 工具面：静态表，或**按请求求值**的函数。
   *
   * 函数形态要能读这一轮的 `requestContext`（信封里有调用身份）：工具面按身份过滤，
   * 没授权的工具根本不出现；返回值可以是 Promise（读配置缓存是异步的）。
   */
  tools:
    | ToolsInput
    | (() => ToolsInput)
    | ((args: { requestContext: RequestContext }) => ToolsInput | Promise<ToolsInput>)
  /** 技能目录路径（交给 Mastra 的技能加载机制，见 `toMastraSkills`） */
  skills: string[]
  durable?: boolean
  /** 对话记忆（durable resume 需要它把工具结果续回消息列表；不传则不启用记忆） */
  memory?: import('@mastra/core/memory').MastraMemory
}

/** 造一个 Mastra Agent（主 agent 与临时子 agent 共用） */
export const createMastraAgent = (options: MastraAgentOptions): Agent =>
  new Agent({
    id: options.id,
    name: options.name,
    instructions: options.instructions,
    model: options.model,
    tools: options.tools,
    skills: options.skills,
    ...(options.durable ? { durable: true } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
  })

/**
 * 主 agent 的模型解析：**从信封取**，构造期（Mastra 不带 requestContext 求值）给占位。
 *
 * `decision` 由调用方注入（`core/model-decision.ts` 的纯函数负责"官方适配还是通用兼容"），
 * 适配器不掺业务判断。
 */
export const modelFromEnvelope = (
  resolve: (model: RuntimeModel) => { id: AgentModelId; url?: string; apiKey: string },
  onMissing: (envelope: AgentRuntimeEnvelope | null) => void,
) => {
  return ({
    requestContext,
  }: {
    requestContext: RequestContext
  }): { id: AgentModelId; url?: string; apiKey: string } => {
    const envelope = readEnvelope(requestContext)
    if (!envelope) {
      onMissing(null)
      return PLACEHOLDER_MODEL
    }
    return resolve(envelope.model)
  }
}
