import { Agent } from '@mastra/core/agent'
import type { ToolsInput } from '@mastra/core/agent'
import type { InlineSkill } from '@mastra/core/skills'
import type { RequestContext } from '@mastra/core/request-context'
import { toAgentModelId, type AgentModelId } from '../core/ai.config.js'
import type { AgentRuntimeEnvelope, RuntimeModel } from '../core/ai.core.types.js'
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
  tools: ToolsInput
  skills: InlineSkill[]
  durable?: boolean
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
  })

/**
 * 主 agent 的模型解析：**从信封取**，构造期（Mastra 不带 requestContext 求值）给占位。
 *
 * `decision` 由调用方注入（`core/ai.model-decision.ts` 的纯函数负责"官方适配还是通用兼容"），
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
