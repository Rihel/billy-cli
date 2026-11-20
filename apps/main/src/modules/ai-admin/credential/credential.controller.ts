import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  CredentialBindSchema,
  CredentialIdSchema,
  CredentialListSchema,
  CredentialUpdateInjectSchema,
} from '@repo/shared'
import type {
  CredentialBindDto,
  CredentialIdDto,
  CredentialListDto,
  CredentialUpdateInjectDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { PersonalCredentialService } from './credential.service.js'

/**
 * 个人凭据管理面（`/ai-credential/*`）：后台管理员鉴权、全 POST、无路径参数。
 *
 * 只做 HTTP 边界：入参校验 + 调 service。**响应里没有明文**——
 * 凭据值对任何角色都不开放（超管也一样，只能看元数据、吊销、触发验证）。
 */
@Controller('ai-credential')
@UseGuards(AdminAuthGuard)
export class PersonalCredentialController {
  constructor(
    @Inject(PersonalCredentialService) private readonly service: PersonalCredentialService,
  ) {}

  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: CredentialListSchema }) input: CredentialListDto) {
    return this.service.list(input)
  }

  @Post('detail')
  @HttpCode(200)
  detail(@Body({ schema: CredentialIdSchema }) input: CredentialIdDto) {
    return this.service.detail(input)
  }

  @Post('create')
  @HttpCode(200)
  create(@Body({ schema: CredentialBindSchema }) input: CredentialBindDto) {
    return this.service.bind(input)
  }

  @Post('update-inject')
  @HttpCode(200)
  updateInject(@Body({ schema: CredentialUpdateInjectSchema }) input: CredentialUpdateInjectDto) {
    return this.service.updateInject(input)
  }

  @Post('remove')
  @HttpCode(200)
  remove(@Body({ schema: CredentialIdSchema }) input: CredentialIdDto) {
    return this.service.revoke(input)
  }
}
