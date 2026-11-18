import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  CapabilityServiceIdSchema,
  CapabilityServiceListSchema,
  CapabilityServiceSaveSchema,
  CapabilityServiceStatusSchema,
  CapabilityServiceTestSchema,
} from '@repo/shared'
import type {
  CapabilityServiceIdDto,
  CapabilityServiceListDto,
  CapabilityServiceSaveDto,
  CapabilityServiceStatusDto,
  CapabilityServiceTestDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { CapabilityServiceAdminService } from './capability.service.js'

/**
 * 能力服务管理路由（`/ai-capability/*`，全部后台管理员鉴权 + 全部 POST + 无路径参数）。
 *
 * 只做 HTTP 边界：入参校验后交给 service；登记的写方是能力网关。
 */
@Controller('ai-capability')
@UseGuards(AdminAuthGuard)
export class CapabilityServiceAdminController {
  constructor(
    @Inject(CapabilityServiceAdminService) private readonly services: CapabilityServiceAdminService,
  ) {}

  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: CapabilityServiceListSchema }) input: CapabilityServiceListDto) {
    return this.services.list(input)
  }

  /** 保存 = 登记（`source:'manual'`）；同一个接口既是新建也是更新 */
  @Post('save')
  @HttpCode(200)
  save(@Body({ schema: CapabilityServiceSaveSchema }) input: CapabilityServiceSaveDto) {
    return this.services.save(input)
  }

  @Post('remove')
  @HttpCode(200)
  remove(@Body({ schema: CapabilityServiceIdSchema }) input: CapabilityServiceIdDto) {
    return this.services.remove(input)
  }

  /** 启停：下线一个服务只有这一个开关 */
  @Post('status')
  @HttpCode(200)
  status(@Body({ schema: CapabilityServiceStatusSchema }) input: CapabilityServiceStatusDto) {
    return this.services.setStatus(input)
  }

  /** 只测连通，不登记 */
  @Post('test')
  @HttpCode(200)
  test(@Body({ schema: CapabilityServiceTestSchema }) input: CapabilityServiceTestDto) {
    return this.services.test(input)
  }

  /** 拉对方清单（`POST {baseUrl}/manifest`），返回内容给页面确认后再保存 */
  @Post('pull-manifest')
  @HttpCode(200)
  pullManifest(@Body({ schema: CapabilityServiceTestSchema }) input: CapabilityServiceTestDto) {
    return this.services.pullManifest(input)
  }
}
