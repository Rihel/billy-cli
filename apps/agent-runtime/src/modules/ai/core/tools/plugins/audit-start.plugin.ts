import { Injectable } from '@nestjs/common'
import type { ToolCallContext, ToolPlugin } from '../tools.types.js'

/** 记开始时间与配置版本（耗时统计与审计都要；重放时能解释"当时用的是哪版配置"） */
@Injectable()
export class AuditStartPlugin implements ToolPlugin {
  readonly name = 'audit-start'

  pre(ctx: ToolCallContext): void {
    ctx.startedAt = ctx.clock.now()
    ctx.configVersion = ctx.settings.version
  }
}
