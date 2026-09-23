import type { PromptData, PromptEngine } from '../prompts/index.js'
import type { ToolBuilder } from '../tools/tool.builder.js'
import type { AgentDefinition, AgentSpec } from '../core/ai.types.js'
import { assistantAgent } from './assistant.agent.js'

/**
 * 全部**顶层** agent 声明：**唯一登记处**（前端能选的就是这些）。
 *
 * 新增一个 agent = 在 `agents/` 加一个 `<名字>.agent.ts` + 在这里加一行
 * （+ `prompts/templates/<模板>.eta`）——不需要改 core 的任何装配代码。
 *
 * ⚠️ **子 agent 不在这里登记**：它们由主 agent 在运行期调用 `run-sub-agent` 工具动态创建
 * （提示词由主 agent 现写，工具面 = 全部 − 委派类），详见 `docs/design/ai-agent.md` §3.14。
 */
export const AGENT_SPECS: readonly AgentSpec[] = [assistantAgent]

/** 默认 agent：前端未选择 / 请求省略 `agentKey` 时的落点 */
export const DEFAULT_AGENT_KEY = assistantAgent.key

/**
 * 把声明渲染成可装配的 agent 定义。
 *
 * 关键一步是**把实际授权的工具清单注入模板**：提示词里那段"可用工具"由
 * `toolBuilder.describe(spec.tools)` 渲染而来，所以「写进提示词的工具」与
 * 「真正挂上去的工具」永远是同一份清单。工具 key 写错会在这里（bootstrap 期）直接抛错，
 * 不会拖到用户提问时才暴露。
 */
export const createAgentDefinitions = (
  prompts: PromptEngine,
  toolBuilder: ToolBuilder,
): AgentDefinition[] =>
  AGENT_SPECS.map((spec) => {
    const data: PromptData = {
      agentKey: spec.key,
      agentName: spec.name,
      tools: toolBuilder.describe(spec.tools),
      ...spec.prompt.data,
    }
    return {
      key: spec.key,
      name: spec.name,
      description: spec.description,
      tools: spec.tools,
      skills: spec.skills ?? [],
      model: spec.model,
      instructions: prompts.render(spec.prompt.template, data),
    }
  })
