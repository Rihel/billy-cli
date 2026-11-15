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

/**
 * 工具面合并：**与执行分流保持一致**。
 *
 * 只有「真的走网关」的工具（`supports(key) === true`）才由网关目录决定是否出现；
 * 本地执行的工具（规划 / 子助手管理 / 技能库等）以本地注册机 + `ai_tools` 为准。
 *
 * 为什么必须分流：曾经这里是全量过滤（`local.filter(key => catalogKeys.has(key))`），
 * 于是 `generated.ts` 一滞后，`wait-sub-agent` 这种**根本不经过网关**的本地工具也会被
 * 远端目录削掉 —— 表现为「后台在册、模型调不到」（2026-11-15 实测）。
 *
 * `catalogKeys = null`（未配网关 / 网关抖动）时 fail-open：整份本地工具面原样放行。
 */
export const filterToolFace = (
  local: readonly string[],
  catalogKeys: ReadonlySet<string> | null,
  supports: (key: string) => boolean,
): string[] => {
  if (!catalogKeys) return [...local]
  return local.filter((key) => !supports(key) || catalogKeys.has(key))
}
