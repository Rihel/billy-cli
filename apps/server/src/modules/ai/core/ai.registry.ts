import { TOOL_KEYS } from '../tools/tool-keys.js'
import { AgentNotFoundError } from './ai.errors.js'
import type { AgentDefinition, AgentRegistry as AgentRegistryShape } from './ai.types.js'

/**
 * 注册表的注入 token。
 *
 * 做成 bean 而不是让服务直接 import 定义清单：注册表是**装配产物**（由声明渲染而来），
 * 注入后服务只依赖抽象，单测可以塞一份只有一两个 agent 的注册表进来。
 */
export const AGENT_REGISTRY = Symbol.for('AgentRegistry')

/**
 * 构建 agent 注册表（纯逻辑，无 IO，可单测）。
 *
 * **启动期就报错**的两种装配错误（宁可起不来，也不要带着坏配置跑）：
 * 1. `key` 重复 —— 后者会静默覆盖前者，前端选了"分析助手"却拿到"通用助手"；
 * 2. 默认 `defaultKey` 不在清单里 —— 省略 agentKey 的调用会全部 404。
 *
 * 工具 key 的合法性由装配层用工具池校验（注册表不知道有哪些工具，见 `tools/index.ts`）。
 */
export const createAgentRegistry = (
  definitions: readonly AgentDefinition[],
  defaultKey: string,
): AgentRegistryShape => {
  if (definitions.length === 0) {
    throw new Error('AI agent 注册表为空：至少需要一个 agent 定义')
  }

  const byKey = new Map<string, AgentDefinition>()
  for (const definition of definitions) {
    if (byKey.has(definition.key)) {
      throw new Error(`AI agent key 重复：${definition.key}`)
    }
    if (!definition.key.trim()) {
      throw new Error('AI agent key 不能为空')
    }
    byKey.set(definition.key, definition)
  }

  if (!byKey.has(defaultKey)) {
    throw new Error(`AI 默认 agent 未注册：${defaultKey}`)
  }

  const resolve = (agentKey?: string): AgentDefinition => {
    const target = agentKey ?? defaultKey
    const definition = byKey.get(target)
    // 未知 key 必须在这里收口：不能让 Mastra 的 getAgent 原始异常漏到 HTTP 边界
    if (!definition) throw new AgentNotFoundError(target)
    return definition
  }

  return {
    defaultKey,
    get: (agentKey) => byKey.get(agentKey),
    resolve,
    all: () => definitions,
    keys: () => definitions.map((definition) => definition.key),
    list: () => ({
      defaultAgentKey: defaultKey,
      agents: definitions.map((definition) => ({
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isDefault: definition.key === defaultKey,
        skills: [...definition.skills],
        // 子 agent 是运行期由工具动态创建的（不在装配期声明，故这里只有能力开关，没有名单）
        canSpawnSubAgents: definition.tools.includes(TOOL_KEYS.runSubAgent),
      })),
    }),
  }
}
