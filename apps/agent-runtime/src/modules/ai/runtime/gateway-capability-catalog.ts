import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { CapabilityGatewayClient } from '@repo/internal-sdk'
import type { CapabilityInfo } from '@repo/contracts'
import type { ToolCallerIdentity } from '../core/tools/tools.types.js'

/**
 * 模型面生效窗口：后台停用/启用一个能力后，**最多 5 秒**反映到工具面（设计 §6.3 的验收口径）。
 * 没有事件通道（`ai.capability.changed` 未实现），这里用 5s TTL 兜住；网关侧读内存是即时的。
 */
const CACHE_TTL_MS = 5_000

/**
 * 消费网关的运行时能力目录（`POST /v1/capabilities/list`）。
 *
 * 目录是能力的**唯一事实源**：`resolveTools` 用它装配工具面，编排层用它渲染系统指令里的
 * 内置能力清单。未配置 `TOOL_GATEWAY_URL` 时返回 null；gateway 抖动 fail-open，
 * 因为"网关暂时不可用"不该让整个对话没有工具可用。
 */
@Injectable()
export class GatewayToolCatalog {
  private readonly cache = new Map<string, { at: number; capabilities: CapabilityInfo[] }>()

  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  /** 这次身份的完整能力目录（含外部服务 / MCP 的工具；未配置网关返回 null） */
  async capabilities(caller: ToolCallerIdentity): Promise<CapabilityInfo[] | null> {
    const url = process.env.TOOL_GATEWAY_URL?.trim()
    if (!url) return null
    const cacheKey = `${caller.isAdmin ? 'admin' : 'user'}:${caller.userId ?? '-'}:${caller.rootAgentKey}`
    const cached = this.cache.get(cacheKey)
    const now = Date.now()
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.capabilities

    const token =
      process.env.TOOL_GATEWAY_TOKEN?.trim() ||
      process.env.TOOL_INTERNAL_TOKEN?.trim() ||
      'dev-tool-token'
    try {
      const client = new CapabilityGatewayClient({ baseUrl: url, token, timeoutMs: 5_000 })
      const response = await client.listCapabilities({
        caller: {
          conversationId: 'catalog',
          runId: 'catalog',
          userId: caller.userId,
          isAdmin: caller.isAdmin,
          agentKey: caller.rootAgentKey,
          rootAgentKey: caller.rootAgentKey,
          depth: 0,
        },
        agentKey: caller.rootAgentKey,
        depth: 0,
      })
      // 目录给的 key 就是工具名，直接用作模型面 key
      this.cache.set(cacheKey, { at: now, capabilities: response.capabilities })
      return response.capabilities
    } catch (error) {
      this.logger.warn('ai.tool_catalog.unavailable', {
        reason: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
}
