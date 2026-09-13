import { Global, Module } from '@nestjs/common'
import { Telemetry } from './telemetry.js'

/**
 * 基础能力：遥测埋点（无配置）。
 * Telemetry 构造器带可选窗口参数，用工厂装配避免 Nest 解析数值参数。
 */
@Global()
@Module({
  providers: [{ provide: Telemetry, useFactory: () => new Telemetry() }],
  exports: [Telemetry],
})
export class TelemetryModule {}
