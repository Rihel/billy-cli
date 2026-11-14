import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { AiToolEntity } from '@repo/db'
import type { ToolRuntimeSettings } from '@repo/contracts'

export interface EffectiveToolConfig extends ToolRuntimeSettings {
  /** `null` = 库里没有配置行，scope 用代码声明 */
  scope: string | null
  allowedAgents: string[] | null
  enabled: boolean
}

/** 配置缓存 TTL：与 server 的 ToolConfigService 同口径（改完最多 5 秒生效） */
const CACHE_TTL_MS = 5_000

/**
 * 读 `ai_tools`（gateway 是只读方；写方仍是 server 管理端）。
 *
 * 行不存在时返回代码默认值，不阻断调用；`enabled=false` 在策略里拒绝。
 * secrets 只放在内存 / 内部请求里，绝不进日志或审计。
 */
@Injectable()
export class ToolConfigService {
  private readonly cache = new Map<string, { at: number; value: EffectiveToolConfig }>()

  constructor(@Inject(Db) private readonly db: Db) {}

  async effective(toolKey: string): Promise<EffectiveToolConfig> {
    const cached = this.cache.get(toolKey)
    const now = Date.now()
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.value

    const repo = this.db.getRepository(AiToolEntity)
    const row = await repo.findOne({ where: { toolKey } })
    const value: EffectiveToolConfig = row
      ? {
          enabled: row.enabled,
          scope: row.scope,
          allowedAgents: row.allowedAgents,
          config: (row.config ?? {}) as Record<string, unknown>,
          limits: (row.limits ?? {}) as Record<string, unknown>,
          secrets: (row.secrets ?? {}) as Record<string, string>,
          version: row.updatedAt?.toISOString() ?? 'code-default',
        }
      : {
          enabled: true,
          scope: null,
          allowedAgents: null,
          config: {},
          limits: {},
          secrets: {},
          version: 'code-default',
        }
    this.cache.set(toolKey, { at: now, value })
    return value
  }

  invalidate(toolKey?: string): void {
    if (toolKey) this.cache.delete(toolKey)
    else this.cache.clear()
  }
}
