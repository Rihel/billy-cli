import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { ToolGatewayClient } from '@repo/internal-sdk'
import type { ToolCallerIdentity } from '../core/tools/tools.types.js'

/** 与 gateway 的配置缓存对齐：工具开关改完最多 30 秒反映到模型工具面 */
const CACHE_TTL_MS = 30_000

/**
 * 消费 gateway 的运行时工具目录（`POST /v1/tools/list`）。
 *
 * server 仍是当前的单体编排层：本地注册机负责执行与参数定义，这里只用 gateway 返回的 key
 * 做**运行时授权 / 开关过滤**；拆出 facade 后，同一份目录也可以直接用来构造远端工具面。
 *
 * 未配置 `TOOL_GATEWAY_URL` 时返回 null（保持本地路径）；gateway 抖动 fail-open，
 * 因为"网关暂时不可用"不该让整个对话没有工具可用。
 */
@Injectable()
export class GatewayToolCatalog {
  private readonly cache = new Map<string, { at: number; keys: Set<string> }>()

  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  async allowedKeys(caller: ToolCallerIdentity): Promise<Set<string> | null> {
    const url = process.env.TOOL_GATEWAY_URL?.trim()
    if (!url) return null
    const cacheKey = `${caller.isAdmin ? 'admin' : 'user'}:${caller.rootAgentKey}`
    const cached = this.cache.get(cacheKey)
    const now = Date.now()
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.keys

    const token =
      process.env.TOOL_GATEWAY_TOKEN?.trim() ||
      process.env.TOOL_INTERNAL_TOKEN?.trim() ||
      'dev-tool-token'
    try {
      const client = new ToolGatewayClient({ baseUrl: url, token, timeoutMs: 5_000 })
      const response = await client.listTools({
        version: 1,
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
      const keys = new Set(response.tools.map((tool) => tool.key))
      this.cache.set(cacheKey, { at: now, keys })
      return keys
    } catch (error) {
      this.logger.warn('ai.tool_catalog.unavailable', {
        reason: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
}
