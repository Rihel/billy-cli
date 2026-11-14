import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import { AiToolKeySchema, AiToolListSchema, AiToolUpdateSchema } from '@repo/shared'
import type { AiToolKeyDto, AiToolListDto, AiToolUpdateDto } from '@repo/shared'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { AiToolAdminService } from './tool-admin.service.js'

/**
 * 工具配置路由（`/ai-tool/*`，**全部后台管理员鉴权** + 全部 POST）。
 *
 * 只做 HTTP 边界：入参经 `@Body({ schema })` 校验后交给 service，业务逻辑全在 service。
 * 路由与旧 `modules/ai` 的实现保持一致，前端无需改动。
 *
 * 注意：**工具调用期的拒绝不走这里** —— 那是工具结论，落在时间线上，不是接口错误。
 * 这里的错误码只有 3407（工具未注册 / runtime 工具不可编辑）与 3408（配置值不合法）。
 */
@Controller('ai-tool')
@UseGuards(AdminAuthGuard)
export class AiToolAdminController {
  constructor(@Inject(AiToolAdminService) private readonly tools: AiToolAdminService) {}

  /** 列表（代码声明工具 + runtime 自带工具，支持关键字 / 类别 / 开关 / 来源筛选） */
  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: AiToolListSchema }) input: AiToolListDto) {
    return this.tools.list(input)
  }

  /** 详情（含默认值、秘钥提示串） */
  @Post('detail')
  @HttpCode(200)
  detail(@Body({ schema: AiToolKeySchema }) input: AiToolKeyDto) {
    return this.tools.detail(input.toolKey)
  }

  /** 更新（省略的字段 = 不改；`secrets` 给空串 = 清空该秘钥） */
  @Post('update')
  @HttpCode(200)
  update(@Body({ schema: AiToolUpdateSchema }) input: AiToolUpdateDto) {
    return this.tools.update(input)
  }

  /**
   * 执行环境能力（只读）：沙箱是否可用、部署允许哪些执行环境。
   *
   * 与配置分开：这是**探测出来的事实**，页面不能改，只能据此提示或切换。
   */
  @Post('workspace')
  @HttpCode(200)
  workspace() {
    return this.tools.workspaceStatus()
  }

  /** 恢复默认（清掉人工覆盖，回到代码声明） */
  @Post('reset')
  @HttpCode(200)
  reset(@Body({ schema: AiToolKeySchema }) input: AiToolKeyDto) {
    return this.tools.reset(input.toolKey)
  }
}
