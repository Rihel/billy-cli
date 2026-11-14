import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common'
import { MonitorModule } from '../../monitor/monitor.module.js'
import { MonitorRegistry } from '../../monitor/engine/monitor.registry.js'
import { AiUsageModule } from '../../ai-usage/ai-usage.module.js'
import { AiUsageSource } from './ai-usage.source.js'
import { AI_USAGE_METRICS } from './ai-usage.metrics.js'
import { AI_USAGE_RULES } from './ai-usage.rules.js'

@Injectable()
export class AiMonitoringRegistration implements OnModuleInit {
  constructor(
    @Inject(MonitorRegistry) private readonly registry: MonitorRegistry,
    @Inject(AiUsageSource) private readonly source: AiUsageSource,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      sources: [this.source],
      metrics: AI_USAGE_METRICS,
      rules: AI_USAGE_RULES,
    })
  }
}

/** AI 监控定义：只负责把指标 / 规则注册进监控注册表 */
@Module({
  imports: [MonitorModule, AiUsageModule],
  providers: [AiUsageSource, AiMonitoringRegistration],
})
export class AiMonitoringModule {}
