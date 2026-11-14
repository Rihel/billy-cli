import type { AgentInstructionsModel, AgentListModel } from '@repo/shared'
import { ALL_TOOL_MANIFESTS } from '@repo/tool-catalog'
import { AGENT_SPECS, DEFAULT_AGENT_KEY } from './static/agents/index.js'
import type { AgentSpec } from './static/agents/types.js'
import { createPromptEngine } from './static/core/prompts/index.js'
import { ALL_SKILLS } from './static/core/skills/skills.types.js'
import { TOOL_KEYS } from './static/core/tools/tool-keys.js'
import { expandToolSelectors, type ToolSelector } from './static/core/tools/tool-selector.js'
import type { ToolCategoryValue } from './static/core/tools/tools.types.js'
import { AgentNotFoundError } from './errors.js'

/**
 * **agent 静态声明目录**（`/agent/status|list|instructions` 的数据源）。
 *
 * 边界：只读**装配期静态声明**（agent 规格 / 提示词模板 / 工具 manifest），
 * 不 import `runtime/**`、Mastra、`AgentChatService` —— 因此它可以在只做 HTTP 查询的
 * main 里安全使用，不会把 agent loop 拉进来。
 *
 * 为什么自己渲染而不复用注册表：注册表是 `AiModule` 的装配产物（依赖 ToolRegistry /
 * SkillLoader / Mastra 实例）。main 只做查询，没必要为了一份静态文案把整条装配链拉起来；
 * 这里的工具清单来自 `@repo/tool-catalog`（与 `@ToolDecl` 同一份 manifest 源），
 * 因此「接口里看到的工具」与「运行时真正挂的工具」不会各写一份。
 */

const promptEngine = createPromptEngine()

/** 选择器展开用的最小信息（manifest 的 category 是字符串，这里按工具类别字面量收口） */
const selectorEntries = ALL_TOOL_MANIFESTS.map((manifest) => ({
  key: manifest.key,
  category: manifest.category as ToolCategoryValue,
}))

const manifestByKey = new Map(ALL_TOOL_MANIFESTS.map((manifest) => [manifest.key, manifest]))

/** 按 agent 的授权选择器展开成工具 key（保持 manifest 顺序；未知 key 由过滤兜住） */
const expandTools = (selectors: readonly ToolSelector[]): string[] =>
  expandToolSelectors(selectors, selectorEntries)

/** 提示词模板里那段「可用工具」的数据（与 ToolRegistry.describe 的同形投影） */
const toolMetaOf = (
  selectors: readonly ToolSelector[],
): Array<{
  key: string
  title: string
  description: string
}> =>
  expandTools(selectors).flatMap((key) => {
    const manifest = manifestByKey.get(key)
    return manifest
      ? [{ key: manifest.key, title: manifest.title, description: manifest.description }]
      : []
  })

/** 按 key 找静态声明；省略 key 用默认 agent。未知 key 抛 3303（不静默回落） */
export const resolveAgentSpec = (agentKey?: string): AgentSpec => {
  const target = agentKey ?? DEFAULT_AGENT_KEY
  const spec = AGENT_SPECS.find((item) => item.key === target)
  if (!spec) throw new AgentNotFoundError(target)
  return spec
}

/** 按 key 找静态声明；不存在返回 undefined（快照里可能引用已下线的 agent） */
export const findAgentSpec = (agentKey: string | null | undefined): AgentSpec | undefined =>
  agentKey ? AGENT_SPECS.find((item) => item.key === agentKey) : undefined

/** 已注册（静态声明）的 agent 数量 */
export const agentCount = (): number => AGENT_SPECS.length

/** agent 清单（`skills: ['*']` 用库里启用中的技能名现算） */
export const listAgents = (skillNames: readonly string[]): AgentListModel => ({
  defaultAgentKey: DEFAULT_AGENT_KEY,
  agents: AGENT_SPECS.map((spec) => {
    const declared = spec.skills ?? []
    return {
      key: spec.key,
      name: spec.name,
      description: spec.description,
      isDefault: spec.key === DEFAULT_AGENT_KEY,
      skills: declared.includes(ALL_SKILLS) ? [...skillNames] : [...declared],
      canSpawnSubAgents: expandTools(spec.tools).includes(TOOL_KEYS.runSubAgent),
    }
  }),
})

/** 渲染静态定义（提示词模板 + 实际授权的工具 manifest） */
export const instructionsOf = (spec: AgentSpec): string =>
  promptEngine.render(spec.prompt.template, {
    agentKey: spec.key,
    agentName: spec.name,
    tools: toolMetaOf(spec.tools),
    ...spec.prompt.data,
  })

/** 静态定义分支的完整出参（`source='definition'`） */
export const staticInstructions = (spec: AgentSpec): AgentInstructionsModel => ({
  agentKey: spec.key,
  name: spec.name,
  description: spec.description,
  instructions: instructionsOf(spec),
  source: 'definition',
  recordedAt: null,
})
