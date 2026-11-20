import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import { SkillGrantListSchema, SkillGrantSetSchema } from '@repo/shared'
import type { SkillGrantListDto, SkillGrantSetDto } from '@repo/shared'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { SkillGrantService } from './skill-grant.service.js'

/** 技能授权管理接口（挂在 `/ai-skill/grants/*`，管理员鉴权） */
@Controller('ai-skill/grants')
@UseGuards(AdminAuthGuard)
export class SkillGrantController {
  constructor(@Inject(SkillGrantService) private readonly service: SkillGrantService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: SkillGrantListSchema }) input: SkillGrantListDto) {
    return this.service.list(input)
  }

  /** 覆盖式设置：`principals: []` 即收回该技能的全部授权 */
  @Post('set')
  @HttpCode(200)
  set(@Body({ schema: SkillGrantSetSchema }) input: SkillGrantSetDto) {
    return this.service.set(input)
  }
}
