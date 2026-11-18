import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { CapabilityGatewayClient } from '@repo/internal-sdk'
import { isRemoteToolKey, type CapabilityInfo } from '@repo/contracts'
import type { ToolCallerIdentity } from '../core/tools/tools.types.js'

/**
 * 模型面生效窗口：后台停用/启用一个能力后，**最多 5 秒**反映到工具面（设计 §6.3 的验收口径）。
 * 没有事件通道（`ai.capability.changed` 未实现），这里用 5s TTL 兜住；网关侧读内存是即时的。
 */
const CACHE_TTL_MS = 5_000

/**
 * 消费网关的运行时能力目录（`POST /v1/capabilities/list`）。
 *
 * server 仍是当前的单体编排层：本地注册机负责执行与参数定义，这里只用 gateway 返回的 key
 * 做**运行时授权 / 开关过滤**；拆出 facade 后，同一份目录也可以直接用来构造远端工具面。
 *
 * 未配置 `TOOL_GATEWAY_URL` 时返回 null（保持本地路径）；gateway 抖动 fail-open，
 * 因为"网关暂时不可用"不该让整个对话没有工具可用。
 */
@Injectable()
export class GatewayToolCatalog {
  private readonly cache = new Map<string, { at: number; capabilities: CapabilityInfo[] }>()

  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  async allowedKeys(caller: ToolCallerIdentity): Promise<Set<string> | null> {
    const capabilities = await this.capabilities(caller)
    if (!capabilities) return null
    return new Set(
      capabilities
        .filter((capability) => isRemoteToolKey(capability.key))
        .map((capability) => capability.key),
    )
  }

  /** 这次身份的完整能力目录（含外部服务 / MCP 的工具；未配置网关返回 null） */
  async capabilities(caller: ToolCallerIdentity): Promise<CapabilityInfo[] | null> {
    const url = process.env.TOOL_GATEWAY_URL?.trim()
    if (!url) return null
    const cacheKey = `${caller.isAdmin ? 'admin' : 'user'}:${caller.rootAgentKey}`
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

/**
 * 工具面合并：**目录只约束走网关的工具**。
 *
 * - 本地编排工具（`plan/*`、`agent/*`、`skill/*`）不在别名表里，视为本地工具，目录管不着；
 * - 走网关的工具（别名表里的 17 个）必须在目录里才出现，停用/越权时自然消失；
 * - 目录不可用（null）时 fail-open，整份本地工具面放行。
 */
export const applyCatalogToToolFace = (
  local: readonly string[],
  catalogKeys: ReadonlySet<string> | null,
): string[] => {
  if (!catalogKeys) return [...local]
  return local.filter((key) => !isRemoteToolKey(key) || catalogKeys.has(key))
}
