import { Module, type DynamicModule } from '@nestjs/common'
import type { z } from 'zod'
import type { InfraModuleAsyncOptions } from '@repo/kits'
import { MonitorConfig, MonitorConfigSchema } from './config.js'
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

/** MonitorModule.forRoot 入参 = MonitorConfigSchema 的输入类型 */
export type MonitorModuleOptions = z.input<typeof MonitorConfigSchema>

/** 模块内所有引擎服务（与 app 无关，两个进程共用） */
const MONITOR_PROVIDERS = [
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
]

/**
 * 对外导出：组合根要 `MonitorEngine`（技术告警钩子），main 的 api 层要仓储 / 注册表。
 * 其余引擎内部件（采集、清理、种子）只在本模块内协作，不对外暴露。
 */
const MONITOR_EXPORTS = [
  MonitorConfig,
  MonitorEngine,
  MonitorRegistry,
  AlertRepository,
  AlertLogRepository,
  MetricSampleRepository,
  MonitorRuleRepository,
  MetricRegistry,
  RuleRegistry,
  AlertLifecycleService,
  MonitorInstanceService,
  RuleEvaluatorService,
  StaleGuard,
]

/**
 * 监控引擎（指标采集 / 规则评估 / 告警生命周期 / 通知）。
 *
 * 从 `apps/main` 与 `apps/agent-runtime` 里原有的同源复制抽成独立包：两个进程都要
 * 「监控自己」，引擎必须共用一份，否则改一次规则要动两处、最终一定会漂移。
 *
 * 边界：
 * - 本包**不含 HTTP API**（告警 / 规则 / 指标的查询与配置在 main 的 `modules/monitor/api`）；
 * - 不 import 任何 app 业务模块；业务模块通过 `MonitorRegistry` 注册定义；
 * - 配置由 `forRoot` / `forRootAsync` 提供并校验（`MonitorConfigSchema`）。
 */
@Module({})
export class MonitorModule {
  static forRoot(options: MonitorModuleOptions = {}): DynamicModule {
    return {
      module: MonitorModule,
      // 全局：注册表要能被其它模块（如 runtime 的 AiMonitoringModule）直接注入；
      // 引擎在进程内只能有一份实例，重复装配会造出第二个注册表
      global: true,
      providers: [
        { provide: MonitorConfig, useValue: MonitorConfigSchema.parse(options) },
        ...MONITOR_PROVIDERS,
      ],
      exports: MONITOR_EXPORTS,
    }
  }

  /** 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 */
  static forRootAsync(options: InfraModuleAsyncOptions<MonitorModuleOptions>): DynamicModule {
    return {
      module: MonitorModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: MonitorConfig,
          inject: options.inject ?? [],
          // 惰性取到的分片同样校验 + 补默认值（与 forRoot 同一条路径）
          useFactory: async (...args: unknown[]) =>
            MonitorConfigSchema.parse(await options.useFactory(...args)),
        },
        ...MONITOR_PROVIDERS,
      ],
      exports: MONITOR_EXPORTS,
    }
  }
}
