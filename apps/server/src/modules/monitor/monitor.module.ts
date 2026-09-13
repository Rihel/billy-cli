import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { AlertLogRepository } from './alert-log.repository.js'
import { AlertRuleRepository } from './alert-rule.repository.js'
import { AlertRuleService } from './alert-rule.service.js'
import { AlertTrigger } from './alert-trigger.js'
import { ConfigService } from '@nestjs/config'
import { MonitorConfig } from './config.js'
import { MonitorController, MonitorHealthController } from './monitor.controller.js'

/**
 * 监控告警模块：告警规则 CRUD + 告警触发（事件规则 / 指标规则）+ 审计日志 + 健康检查。
 * AlertTrigger 对外导出，供组合根注册为全局异常过滤器的「技术错误告警」钩子。
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
    AlertRuleRepository,
    AlertLogRepository,
    AlertRuleService,
    AlertTrigger,
  ],
  exports: [AlertTrigger, AlertRuleService, AlertLogRepository],
})
export class MonitorModule {}
