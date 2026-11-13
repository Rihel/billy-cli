import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  GetMonitorAlertDetailSchema,
  ListMonitorRuleSchema,
  MonitorMetricLatestQuerySchema,
  MonitorMetricSeriesSchema,
  PageQueryMonitorAlertSchema,
  PageQueryMonitorLogSchema,
  ResetMonitorRuleSchema,
  TestAlertSchema,
  UpdateMonitorRuleSchema,
} from '@repo/shared'
import type {
  GetMonitorAlertDetailDto,
  ListMonitorRuleDto,
  MonitorMetricLatestQueryDto,
  MonitorMetricSeriesDto,
  PageQueryMonitorAlertDto,
  PageQueryMonitorLogDto,
  ResetMonitorRuleDto,
  TestAlertDto,
  UpdateMonitorRuleDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { MonitorAlertService } from './monitor-alert.service.js'
import { MonitorEngineService } from './monitor-engine.service.js'
import { MonitorMetricService } from './monitor-metric.service.js'
import { MonitorRuleService } from './monitor-rule.service.js'
import { MonitorTestService } from './monitor-test.service.js'

/** 监控路由（/monitor/*，全部 admin 鉴权） */
@Controller('monitor')
@UseGuards(AdminAuthGuard)
export class MonitorController {
  constructor(
    @Inject(MonitorRuleService) private readonly rules: MonitorRuleService,
    @Inject(MonitorAlertService) private readonly alerts: MonitorAlertService,
    @Inject(MonitorMetricService) private readonly metrics: MonitorMetricService,
    @Inject(MonitorEngineService) private readonly engine: MonitorEngineService,
    @Inject(MonitorTestService) private readonly testService: MonitorTestService,
  ) {}

  @Post('rule/definitions')
  @HttpCode(200)
  ruleDefinitions() {
    return this.rules.definitions()
  }

  @Post('rule/list')
  @HttpCode(200)
  ruleList(@Body({ schema: ListMonitorRuleSchema }) input: ListMonitorRuleDto) {
    return this.rules.list(input)
  }

  @Post('rule/update')
  @HttpCode(200)
  ruleUpdate(@Body({ schema: UpdateMonitorRuleSchema }) input: UpdateMonitorRuleDto) {
    return this.rules.update(input)
  }

  @Post('rule/reset')
  @HttpCode(200)
  ruleReset(@Body({ schema: ResetMonitorRuleSchema }) input: ResetMonitorRuleDto) {
    return this.rules.reset(input)
  }

  @Post('alert/page-query')
  @HttpCode(200)
  alertPageQuery(@Body({ schema: PageQueryMonitorAlertSchema }) input: PageQueryMonitorAlertDto) {
    return this.alerts.page(input)
  }

  @Post('alert/detail')
  @HttpCode(200)
  alertDetail(@Body({ schema: GetMonitorAlertDetailSchema }) input: GetMonitorAlertDetailDto) {
    return this.alerts.detail(input)
  }

  @Post('metric/definitions')
  @HttpCode(200)
  metricDefinitions() {
    return this.metrics.definitions()
  }

  @Post('metric/series')
  @HttpCode(200)
  metricSeries(@Body({ schema: MonitorMetricSeriesSchema }) input: MonitorMetricSeriesDto) {
    return this.metrics.series(input)
  }

  @Post('metric/latest')
  @HttpCode(200)
  metricLatest(
    @Body({ schema: MonitorMetricLatestQuerySchema }) input: MonitorMetricLatestQueryDto,
  ) {
    return this.metrics.latest(input)
  }

  @Post('engine/status')
  @HttpCode(200)
  engineStatus() {
    return this.engine.status()
  }

  @Post('log/page-query')
  @HttpCode(200)
  logPageQuery(@Body({ schema: PageQueryMonitorLogSchema }) input: PageQueryMonitorLogDto) {
    return this.alerts.logsPage(input)
  }

  @Post('test')
  @HttpCode(200)
  test(@Body({ schema: TestAlertSchema }) input: TestAlertDto) {
    return this.testService.send(input)
  }
}
