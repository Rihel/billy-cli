import { Inject, Injectable } from '@nestjs/common'
import { ALL_TOOL_MANIFESTS } from '@repo/tool-catalog'
import type { ToolCaller, ToolManifest } from '@repo/contracts'
import { ToolConfigService } from '../config/tool.config.service.js'

/**
 * 工具目录（运行时）。
 *
 * **定义唯一来源是 `@repo/tool-catalog`**；这里只负责按调用者过滤、转成 manifest。
 * DB 只存 enabled / limits / 配置（下一步接 `ai_tools`），不存 schema。
 */
@Injectable()
export class ToolCatalogService {
  private readonly manifests: readonly ToolManifest[] = ALL_TOOL_MANIFESTS

  constructor(@Inject(ToolConfigService) private readonly toolConfig: ToolConfigService) {}

  async list(input: {
    caller: ToolCaller
    agentKey: string
    depth: number
  }): Promise<ToolManifest[]> {
    const available: ToolManifest[] = []
    for (const manifest of this.manifests) {
      const effective = await this.toolConfig.effective(manifest.key)
      if (!effective.enabled) continue
      const scope = effective.scope ?? manifest.scope
      if (scope === 'admin' && !input.caller.isAdmin) continue
      if (scope === 'user' && input.caller.isAdmin) continue
      if (
        scope === 'agent' &&
        !(effective.allowedAgents ?? []).includes(input.caller.agentKey) &&
        !(effective.allowedAgents ?? []).includes(input.caller.rootAgentKey)
      ) {
        continue
      }
      available.push({ ...manifest, scope: scope as ToolManifest['scope'] })
    }
    return available
  }
}
