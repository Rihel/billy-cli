import { Inject, Injectable } from '@nestjs/common'
import { Telemetry, type TelemetryWindow } from '@repo/kits'
import type { MetricSource } from '../definitions/metric.types.js'

/**
 * Telemetry 源：消费 `drainCompleted()` 取走已结束窗口。
 * 调用一次就取走窗口，采集服务必须缓存、不能重复调用。
 */
@Injectable()
export class TelemetrySource implements MetricSource<TelemetryWindow[]> {
  readonly key = 'telemetry'

  constructor(@Inject(Telemetry) private readonly telemetry: Telemetry) {}

  async read(): Promise<TelemetryWindow[]> {
    return this.telemetry.drainCompleted()
  }
}
