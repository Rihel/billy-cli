import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  CreateAlertRuleSchema,
  GetAlertRuleDetailSchema,
  PageQueryAlertLogSchema,
  PageQueryAlertRuleSchema,
  RemoveAlertRuleSchema,
  TestAlertSchema,
  UpdateAlertRuleSchema,
} from '@repo/shared'
import type {
  CreateAlertRuleDto,
  GetAlertRuleDetailDto,
  PageQueryAlertLogDto,
  PageQueryAlertRuleDto,
  RemoveAlertRuleDto,
  TestAlertDto,
  UpdateAlertRuleDto,
} from '@repo/shared'
import { Db, RedisStore } from '@repo/kits'
import { AdminAuthGuard } from '../admin/admin-auth.guard.js'
import { AlertLogRepository } from './alert-log.repository.js'
import { AlertRuleService } from './alert-rule.service.js'
import { AlertTrigger } from './alert-trigger.js'

/**
 * 健康检查路由（/monitor/health，免鉴权）：探活 DB / Redis，任一失败 degraded。
 * 不抛错（统一 POST 约定，供 Docker / k8s / 云平台探针调用）。
 */
@Controller('monitor')
export class MonitorHealthController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(RedisStore) private readonly redis: RedisStore,
  ) {}

  @Post('health')
  @HttpCode(200)
  async health() {
    const checks: Record<string, 'ok' | 'failed'> = {}
    let status: 'ok' | 'degraded' = 'ok'

    try {
      await this.db.dataSource.query('SELECT 1')
      checks.db = 'ok'
    } catch {
      checks.db = 'failed'
      status = 'degraded'
    }
    try {
      await this.redis.raw.ping()
      checks.redis = 'ok'
    } catch {
      checks.redis = 'failed'
      status = 'degraded'
    }

    return {
      status,
      uptimeSeconds: Math.round(process.uptime()),
      checks,
    }
  }
}

/**
 * 监控告警路由（/monitor/*，全部 admin 鉴权）：
 * - /monitor/rule/*        告警规则 CRUD（admin 管理）
 * - /monitor/log/page-query 告警记录查询（审计）
 * - /monitor/test          测试通知（手动验证通道）
 */
@Controller('monitor')
@UseGuards(AdminAuthGuard)
export class MonitorController {
  constructor(
    @Inject(AlertRuleService) private readonly alertRuleService: AlertRuleService,
    @Inject(AlertTrigger) private readonly alertTrigger: AlertTrigger,
    @Inject(AlertLogRepository) private readonly alertLogRepository: AlertLogRepository,
  ) {}

  @Post('rule/create')
  @HttpCode(200)
  ruleCreate(@Body({ schema: CreateAlertRuleSchema }) input: CreateAlertRuleDto) {
    return this.alertRuleService.create(input)
  }

  @Post('rule/page-query')
  @HttpCode(200)
  rulePageQuery(@Body({ schema: PageQueryAlertRuleSchema }) input: PageQueryAlertRuleDto) {
    return this.alertRuleService.page(input)
  }

  @Post('rule/detail')
  @HttpCode(200)
  ruleDetail(@Body({ schema: GetAlertRuleDetailSchema }) input: GetAlertRuleDetailDto) {
    return this.alertRuleService.get(input)
  }

  @Post('rule/update')
  @HttpCode(200)
  ruleUpdate(@Body({ schema: UpdateAlertRuleSchema }) input: UpdateAlertRuleDto) {
    return this.alertRuleService.update(input)
  }

  @Post('rule/remove')
  @HttpCode(200)
  ruleRemove(@Body({ schema: RemoveAlertRuleSchema }) input: RemoveAlertRuleDto) {
    return this.alertRuleService.remove(input)
  }

  @Post('log/page-query')
  @HttpCode(200)
  logPageQuery(@Body({ schema: PageQueryAlertLogSchema }) input: PageQueryAlertLogDto) {
    return this.alertLogRepository.page(input)
  }

  @Post('test')
  @HttpCode(200)
  test(@Body({ schema: TestAlertSchema }) input: TestAlertDto) {
    return this.alertTrigger.testNotify(input)
  }
}
