import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  AiModelCreateSchema,
  AiModelIdSchema,
  AiModelListSchema,
  AiModelUpdateSchema,
  AiProviderCreateSchema,
  AiProviderIdSchema,
  AiProviderListSchema,
  AiProviderTestSchema,
  AiProviderUpdateSchema,
} from '@repo/shared'
import type {
  AiModelCreateDto,
  AiModelIdDto,
  AiModelListDto,
  AiModelUpdateDto,
  AiProviderCreateDto,
  AiProviderIdDto,
  AiProviderListDto,
  AiProviderTestDto,
  AiProviderUpdateDto,
} from '@repo/shared'
import { AdminAuthGuard } from '../admin/admin-auth.guard.js'
import { AiModelService } from './ai-model.service.js'

/**
 * AI 模型管理路由（`/ai-model/*`，**全部后台管理员鉴权** + 全部 POST，见设计文档 §4.8.4）。
 *
 * 只做 HTTP 边界：入参经 `@Body({ schema })` 校验后原样交给 service，业务逻辑全在 service。
 * `provider/test` 与 `provider/sync` 的"成功 / 失败"都通过返回值表达
 * （`sync` 失败抛 3403，`test` 失败回 `{ ok: false, error }`）；`remove` 与 agent 会话删除一致，
 * 返回 `{ removed: true }`。
 */
@Controller('ai-model')
@UseGuards(AdminAuthGuard)
export class AiModelController {
  constructor(@Inject(AiModelService) private readonly aiModelService: AiModelService) {}

  // ─────────────────────────────── 供应商 ───────────────────────────────

  @Post('provider/list')
  @HttpCode(200)
  listProviders(@Body({ schema: AiProviderListSchema }) input: AiProviderListDto) {
    return this.aiModelService.listProviders(input)
  }

  @Post('provider/create')
  @HttpCode(200)
  createProvider(@Body({ schema: AiProviderCreateSchema }) input: AiProviderCreateDto) {
    return this.aiModelService.createProvider(input)
  }

  @Post('provider/detail')
  @HttpCode(200)
  detailProvider(@Body({ schema: AiProviderIdSchema }) input: AiProviderIdDto) {
    return this.aiModelService.detailProvider(input)
  }

  @Post('provider/update')
  @HttpCode(200)
  updateProvider(@Body({ schema: AiProviderUpdateSchema }) input: AiProviderUpdateDto) {
    return this.aiModelService.updateProvider(input)
  }

  @Post('provider/remove')
  @HttpCode(200)
  async removeProvider(@Body({ schema: AiProviderIdSchema }) input: AiProviderIdDto) {
    await this.aiModelService.removeProvider(input)
    return { removed: true }
  }

  @Post('provider/sync')
  @HttpCode(200)
  syncProvider(@Body({ schema: AiProviderIdSchema }) input: AiProviderIdDto) {
    return this.aiModelService.syncProvider(input)
  }

  @Post('provider/test')
  @HttpCode(200)
  testProvider(@Body({ schema: AiProviderTestSchema }) input: AiProviderTestDto) {
    return this.aiModelService.testProvider(input)
  }

  // ─────────────────────────────── 模型 ───────────────────────────────

  @Post('model/list')
  @HttpCode(200)
  listModels(@Body({ schema: AiModelListSchema }) input: AiModelListDto) {
    return this.aiModelService.listModels(input)
  }

  @Post('model/create')
  @HttpCode(200)
  createModel(@Body({ schema: AiModelCreateSchema }) input: AiModelCreateDto) {
    return this.aiModelService.createModel(input)
  }

  @Post('model/update')
  @HttpCode(200)
  updateModel(@Body({ schema: AiModelUpdateSchema }) input: AiModelUpdateDto) {
    return this.aiModelService.updateModel(input)
  }

  @Post('model/remove')
  @HttpCode(200)
  async removeModel(@Body({ schema: AiModelIdSchema }) input: AiModelIdDto) {
    await this.aiModelService.removeModel(input)
    return { removed: true }
  }
}
