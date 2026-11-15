import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  GatewayUsageListSchema,
  GatewayUsageReconcileSchema,
  GatewayUsageSummaryQuerySchema,
  type GatewayUsageListDto,
  type GatewayUsageReconcileDto,
  type GatewayUsageSummaryQueryDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../admin/index.js'
import { GatewayUsageService } from './gateway-usage.service.js'

/** 模型网关调用账（管理员）：明细 / 汇总 / 与 runs.usage 对账 */
@Controller('agent/usage/gateway')
@UseGuards(AdminAuthGuard)
export class GatewayUsageController {
  constructor(@Inject(GatewayUsageService) private readonly usage: GatewayUsageService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: GatewayUsageListSchema }) input: GatewayUsageListDto) {
    return this.usage.list(input)
  }

  @Post('summary')
  @HttpCode(200)
  summary(@Body({ schema: GatewayUsageSummaryQuerySchema }) input: GatewayUsageSummaryQueryDto) {
    return this.usage.summary(input)
  }

  @Post('reconcile')
  @HttpCode(200)
  reconcile(@Body({ schema: GatewayUsageReconcileSchema }) input: GatewayUsageReconcileDto) {
    return this.usage.reconcile(input)
  }
}
