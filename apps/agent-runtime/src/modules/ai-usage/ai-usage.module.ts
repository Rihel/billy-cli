import { Module } from '@nestjs/common'
import { AiUsageRollupService, AiUsageService } from '@repo/ai-data'

/** AI 用量：日表汇总 + 查询（只读；汇总调度由 main 负责） */
@Module({
  providers: [AiUsageRollupService, AiUsageService],
  exports: [AiUsageService, AiUsageRollupService],
})
export class AiUsageModule {}
