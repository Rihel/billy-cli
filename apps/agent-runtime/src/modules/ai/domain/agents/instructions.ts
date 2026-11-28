import type { ToolRegistry } from '../../tools/engine/tool.registry.js'
import { ALL_TOOLS } from '../../tools/engine/tools.types.js'
import type { GatewayToolCatalog } from '../../runtime/model/gateway-capability-catalog.js'
import type { AgentDefinition } from './types.js'

/**
 * 系统指令里的**工具清单**：本地编排工具 + 能力目录里的内部服务 / 网关能力。
 *
 * 外部服务（MCP / 手工登记）故意不列：提示词由 `tools.eta` 引导模型用 `tool-search` 自己找，
 * 找到后下一轮才进工具面。
 *
 * 两处消费（对话首轮 / `/agent/instructions` 预览）共用这一份，避免"页面上是一套、跑起来另一套"。
 */
export const renderAgentInstructions = async (
  definition: AgentDefinition,
  registry: ToolRegistry,
  catalog: GatewayToolCatalog | null | undefined,
  caller: { isAdmin: boolean; userId: string | null; conversationId: string },
): Promise<string> => {
  if (!catalog) return definition.instructions
  const local = registry.describe(definition.tools)
  const capabilities = await catalog.capabilities({
    isAdmin: caller.isAdmin,
    userId: caller.userId,
    rootAgentKey: definition.key,
    conversationId: caller.conversationId,
  })
  const seen = new Set(local.map((tool) => tool.key))
  const wantsAll = definition.tools.includes(ALL_TOOLS)
  const internal = (capabilities ?? [])
    .filter((capability) => capability.source === 'code')
    .filter((capability) => !seen.has(capability.key))
    .filter((capability) => wantsAll || definition.tools.includes(capability.key))
    .map((capability) => ({
      key: capability.key,
      title: capability.title,
      description: capability.description,
      category: 'core' as const,
    }))
  return definition.renderInstructions?.([...local, ...internal]) ?? definition.instructions
}
