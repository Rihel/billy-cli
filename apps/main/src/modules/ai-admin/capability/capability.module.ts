import { Module } from '@nestjs/common'
import { AdminModule } from '../../admin/admin.module.js'
import { CapabilityServiceAdminController } from './capability.controller.js'
import { CapabilityServiceAdminService } from './capability.service.js'

/** 能力服务管理（main 本地）：`/ai-capability/*` 的唯一装配点 */
@Module({
  imports: [AdminModule],
  controllers: [CapabilityServiceAdminController],
  providers: [CapabilityServiceAdminService],
  exports: [CapabilityServiceAdminService],
})
export class CapabilityServiceAdminModule {}
