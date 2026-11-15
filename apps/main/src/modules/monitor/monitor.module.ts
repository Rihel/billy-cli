import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { MonitorModule as MonitorCoreModule, type MonitorModuleOptions } from '@repo/monitor'
import { AdminModule } from '../admin/admin.module.js'
import { MonitorAlertService } from './api/monitor-alert.service.js'
import { MonitorController } from './api/monitor.controller.js'
import { MonitorEngineService } from './api/monitor-engine.service.js'
import { MonitorHealthController } from './api/monitor-health.controller.js'
import { MonitorMetricService } from './api/monitor-metric.service.js'
import { MonitorRuleService } from './api/monitor-rule.service.js'
import { MonitorTestService } from './api/monitor-test.service.js'
import { AiMonitoringModule } from './ai-usage/ai-monitoring.module.js'

/**
 * 监控模块（main 侧）：引擎来自 `@repo/monitor`，这里只保留**控制面 HTTP**。
 *
 * 引擎（采集 / 评估 / 告警 / 通知）是与进程无关的一份实现，放在包里由两个 app 各装配一次；
 * main 额外承担告警 / 规则 / 指标的查询与配置入口（`api/**`，叠 `AdminAuthGuard`）。
 * runtime 只装配引擎、不开这些路由。
 */
@Module({
  imports: [
    MonitorCoreModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get<MonitorModuleOptions>('monitor')!,
    }),
    AdminModule,
    AiMonitoringModule,
  ],
  controllers: [MonitorHealthController, MonitorController],
  providers: [
    MonitorRuleService,
    MonitorAlertService,
    MonitorMetricService,
    MonitorEngineService,
    MonitorTestService,
  ],
  // 不额外 exports：核心模块是 global，组合根的 ERROR_ALERT_HOOK 直接注入 MonitorEngine
})
export class MonitorModule {}
