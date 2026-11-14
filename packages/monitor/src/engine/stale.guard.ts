import { Injectable } from '@nestjs/common'
import type { MetricDefinition } from '../definitions/metric.types.js'

/** 样本陈旧判断：最新样本超过指标声明的 staleAfterSeconds 就不再评估 */
@Injectable()
export class StaleGuard {
  isStale(metric: MetricDefinition, latestWindowEnd: Date | null, now: Date): boolean {
    if (!latestWindowEnd) return true
    return now.getTime() - latestWindowEnd.getTime() > metric.staleAfterSeconds * 1000
  }
}
