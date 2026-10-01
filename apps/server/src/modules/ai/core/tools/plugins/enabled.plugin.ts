import { Injectable } from '@nestjs/common'
import type { ToolCallContext, ToolOutcome, ToolPlugin } from '../tools.types.js'

/** 总开关：关掉时给"已被管理员关闭"的结论，不抛错（模型能理解并改口） */
@Injectable()
export class EnabledPlugin implements ToolPlugin {
  readonly name = 'enabled'

  pre(ctx: ToolCallContext): ToolOutcome<never> | void {
    // 治理级开关（配置表）与能力级开关（工具自己的 `config.enabled`）**都开**才放行：
    // 后者让 `AGENT_COMMAND_ENABLED=false` 这类部署边界仍然管用（见 command.tool 的 normalize）
    const capabilityEnabled = (ctx.settings.config as { enabled?: boolean }).enabled !== false
    if (ctx.settings.enabled && capabilityEnabled) return
    return {
      ok: false,
      reason: 'disabled',
      message: `\`${ctx.toolKey}\` 已被管理员关闭`,
      hint: '换用其它工具，或如实告诉用户这个能力当前不可用',
      retryable: false,
    }
  }
}
