import { Inject, Injectable } from '@nestjs/common'
import type { MetricSource, SourceContext } from '../../monitor/definitions/metric.types.js'
import { AiUsageService, type AiUsageDayData } from '../../ai-usage/ai-usage.service.js'

/** AI 用量日表源：按窗口日期读 ai_usage_daily + 维度表 */
@Injectable()
export class AiUsageSource implements MetricSource<AiUsageDayData> {
  readonly key = 'ai-usage'

  constructor(@Inject(AiUsageService) private readonly usage: AiUsageService) {}

  async read(ctx: SourceContext): Promise<AiUsageDayData> {
    return this.usage.day(ctx.window.key)
  }
}
