import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { AiUsageRollupService, AiUsageService } from '@repo/ai-data'
import { AiUsageScheduler } from './ai-usage.scheduler.js'
import { GatewayUsageController } from './gateway-usage.controller.js'
import { GatewayUsageService } from './gateway-usage.service.js'

/** AI 用量：日表汇总 + 查询，不反向依赖 AI 业务模块 */
@Module({
  // 网关用量查询只有管理员能看：AdminAuthGuard 依赖 AdminService
  imports: [AdminModule],
  controllers: [GatewayUsageController],
  providers: [AiUsageRollupService, AiUsageService, AiUsageScheduler, GatewayUsageService],
  exports: [AiUsageService, AiUsageRollupService],
})
export class AiUsageModule {}
