import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  AiProviderKeyCreateSchema,
  AiProviderKeyIdSchema,
  AiProviderKeyListSchema,
  AiProviderKeyUpdateSchema,
  type AiProviderKeyCreateDto,
  type AiProviderKeyIdDto,
  type AiProviderKeyListDto,
  type AiProviderKeyUpdateDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../admin/index.js'
import { AiProviderKeyService } from './ai-provider-key.service.js'

/** 上游 key 池管理（管理员）：列表不回明文，新增/轮换/停用/删除 */
@Controller('ai-model/provider-key')
@UseGuards(AdminAuthGuard)
export class AiProviderKeyController {
  constructor(@Inject(AiProviderKeyService) private readonly keys: AiProviderKeyService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: AiProviderKeyListSchema }) input: AiProviderKeyListDto) {
    return this.keys.list(input)
  }

  @Post('create')
  @HttpCode(200)
  create(@Body({ schema: AiProviderKeyCreateSchema }) input: AiProviderKeyCreateDto) {
    return this.keys.create(input)
  }

  @Post('update')
  @HttpCode(200)
  update(@Body({ schema: AiProviderKeyUpdateSchema }) input: AiProviderKeyUpdateDto) {
    return this.keys.update(input)
  }

  @Post('remove')
  @HttpCode(200)
  async remove(@Body({ schema: AiProviderKeyIdSchema }) input: AiProviderKeyIdDto) {
    await this.keys.remove(input)
    return { removed: true }
  }
}
