import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  CapabilityServiceIdSchema,
  CapabilityServiceListSchema,
  CapabilityServiceSaveSchema,
  CapabilityServiceMcpPullSchema,
  CapabilityServiceStatusSchema,
  CapabilityServiceTestSchema,
  ServiceGrantListSchema,
  ServiceGrantSetSchema,
} from '@repo/shared'
import type {
  CapabilityServiceIdDto,
  CapabilityServiceListDto,
  CapabilityServiceMcpPullDto,
  CapabilityServiceSaveDto,
  CapabilityServiceStatusDto,
  CapabilityServiceTestDto,
  ServiceGrantListDto,
  ServiceGrantSetDto,
} from '@repo/shared'
import { requestContext } from '@repo/kits'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { CapabilityServiceAdminService } from './capability.service.js'
import { ServiceGrantAdminService } from './service-grant.service.js'

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
    @Inject(ServiceGrantAdminService) private readonly grants: ServiceGrantAdminService,
  ) {}

  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: CapabilityServiceListSchema }) input: CapabilityServiceListDto) {
    return this.services.list(input)
  }

  /** 保存 = 登记（`source:'manual'`）；同一个接口既是新建也是更新 */
  @Post('save')
  @HttpCode(200)
  async save(@Body({ schema: CapabilityServiceSaveSchema }) input: CapabilityServiceSaveDto) {
    const saved = await this.services.save(input)
    // 新登记的外部服务默认授权给登记人；已有服务再次保存不会扩大授权
    const adminId = requestContext.get('adminId')
    if (adminId && saved.source === 'manual') await this.grants.ensureGrant(adminId, input.service)
    return saved
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

  /** 服务级授权：全部授权行（页面一次拉全） */
  @Post('grants/list')
  @HttpCode(200)
  listGrants(@Body({ schema: ServiceGrantListSchema }) _input: ServiceGrantListDto) {
    return this.grants.list()
  }

  /** 覆盖式设置某个管理员可用的外部服务/MCP */
  @Post('grants/set')
  @HttpCode(200)
  setGrants(@Body({ schema: ServiceGrantSetSchema }) input: ServiceGrantSetDto) {
    return this.grants.set(input)
  }

  /** 从 MCP server 拉工具清单（网关做握手 + tools/list），返回给页面确认后再保存 */
  @Post('pull-mcp')
  @HttpCode(200)
  pullMcp(@Body({ schema: CapabilityServiceMcpPullSchema }) input: CapabilityServiceMcpPullDto) {
    return this.services.pullMcp(input)
  }

  /** 拉对方清单（`POST {baseUrl}/manifest`），返回内容给页面确认后再保存 */
  @Post('pull-manifest')
  @HttpCode(200)
  pullManifest(@Body({ schema: CapabilityServiceTestSchema }) input: CapabilityServiceTestDto) {
    return this.services.pullManifest(input)
  }
}
