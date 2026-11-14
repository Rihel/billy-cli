import { Module } from '@nestjs/common'
import { AiUsageRollupService } from './ai-usage.rollup.service.js'
import { AiUsageScheduler } from './ai-usage.scheduler.js'
import { AiUsageService } from './ai-usage.service.js'

/** AI 用量：日表汇总 + 查询，不反向依赖 AI 业务模块 */
@Module({
  providers: [AiUsageRollupService, AiUsageService, AiUsageScheduler],
  exports: [AiUsageService, AiUsageRollupService],
})
export class AiUsageModule {}
