import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  AiMemoryListSchema,
  AiMemoryRemoveSchema,
  AiMemoryUpdateSchema,
  type AiMemoryListDto,
  type AiMemoryRemoveDto,
  type AiMemoryUpdateDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { MemoryService } from './memory.service.js'

/**
 * 长期记忆管理路由（`/ai-memory/*`，**全部后台管理员鉴权** + 全部 POST）。
 *
 * 只做 HTTP 边界：入参经 `@Body({ schema })` 校验后交给 service。
 * 错误码：3315 不存在 / 3316 超限 / 3317 内容不合法。
 */
@Controller('ai-memory')
@UseGuards(AdminAuthGuard)
export class MemoryController {
  constructor(@Inject(MemoryService) private readonly memories: MemoryService) {}

  /** 列表（分页 + 用户 / 类型 / 来源 / 启停 / 关键字筛选） */
  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: AiMemoryListSchema }) input: AiMemoryListDto) {
    return this.memories.page(input)
  }

  /** 更新（内容 / 类型 / 置顶 / 启停；归属与 key 不可改） */
  @Post('update')
  @HttpCode(200)
  update(@Body({ schema: AiMemoryUpdateSchema }) input: AiMemoryUpdateDto) {
    return this.memories.update(input)
  }

  /** 软删（数据仍在库里，后台不再列出） */
  @Post('remove')
  @HttpCode(200)
  async remove(@Body({ schema: AiMemoryRemoveSchema }) input: AiMemoryRemoveDto) {
    await this.memories.remove(input.id)
    return { removed: true }
  }
}
