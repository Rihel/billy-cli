import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AdminModule } from '../admin/admin.module.js'
import { MonitorConfig } from './config.js'
import { AlertDeliveryService } from './engine/alert-delivery.service.js'
import { AlertLifecycleService } from './engine/alert-lifecycle.service.js'
import { AlertLogRepository } from './engine/alert-log.repository.js'
import { AlertRepository } from './engine/alert.repository.js'
import { AlertStreamService } from './engine/alert-stream.service.js'
import { CleanupService } from './engine/cleanup.service.js'
import { DerivedMetricService } from './engine/derived-metric.service.js'
import { EventRuleService } from './engine/event-rule.service.js'
import { MetricCollectService } from './engine/metric-collect.service.js'
import { MetricRegistry } from './engine/metric.registry.js'
import { MetricSampleRepository } from './engine/metric-sample.repository.js'
import { MonitorEngine } from './engine/monitor.engine.js'
import { MonitorInstanceService } from './engine/instance.service.js'
import { MonitorRegistry } from './engine/monitor.registry.js'
import { MonitorRuleRepository } from './engine/monitor-rule.repository.js'
import { MonitorTimeline } from './engine/monitor.timeline.js'
import { RuleEvaluatorService } from './engine/rule-evaluator.service.js'
import { RuleRegistry } from './engine/rule.registry.js'
import { SeedService } from './engine/seed.service.js'
import { SilenceService } from './engine/silence.service.js'
import { StaleGuard } from './engine/stale.guard.js'
import { StreamStateService } from './engine/stream-state.service.js'
import { ProcessSource } from './sources/process.source.js'
import { TelemetrySource } from './sources/telemetry.source.js'
import { MonitorAlertService } from './api/monitor-alert.service.js'
import { MonitorController } from './api/monitor.controller.js'
import { MonitorEngineService } from './api/monitor-engine.service.js'
import { MonitorHealthController } from './api/monitor-health.controller.js'
import { MonitorMetricService } from './api/monitor-metric.service.js'
import { MonitorRuleService } from './api/monitor-rule.service.js'
import { MonitorTestService } from './api/monitor-test.service.js'

/**
 * 监控模块：指标采集 / 样本、规则评估、告警生命周期、通知、API。
 * 业务模块通过 import 本模块拿到 MonitorRegistry 注册定义；本模块不 import 业务模块。
 */
@Module({
  imports: [AdminModule],
  controllers: [MonitorHealthController, MonitorController],
  providers: [
    {
      provide: MonitorConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<import('./config.js').MonitorConfig>('monitor'),
    },
    TelemetrySource,
    ProcessSource,
    MetricRegistry,
    RuleRegistry,
    MonitorRegistry,
    MonitorRuleRepository,
    MetricSampleRepository,
    AlertRepository,
    AlertLogRepository,
    SilenceService,
    AlertStreamService,
    StaleGuard,
    StreamStateService,
    DerivedMetricService,
    MetricCollectService,
    AlertLifecycleService,
    AlertDeliveryService,
    EventRuleService,
    CleanupService,
    SeedService,
    MonitorTimeline,
    MonitorInstanceService,
    RuleEvaluatorService,
    MonitorEngine,
    MonitorRuleService,
    MonitorAlertService,
    MonitorMetricService,
    MonitorEngineService,
    MonitorTestService,
  ],
  exports: [MonitorEngine, MonitorRegistry],
})
export class MonitorModule {}
