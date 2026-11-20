import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import { MarketItemKeySchema, MarketItemListSchema, MarketItemSaveSchema } from '@repo/shared'
import type { MarketItemKeyDto, MarketItemListDto, MarketItemSaveDto } from '@repo/shared'
import { AdminAuthGuard } from '../admin/admin-auth.guard.js'
import { MarketService } from './market.service.js'

/** AI 市场接口（`/ai-market/*`，管理员鉴权；v1 只做 MCP 区收录） */
@Controller('ai-market')
@UseGuards(AdminAuthGuard)
export class MarketController {
  constructor(@Inject(MarketService) private readonly service: MarketService) {}

  @Post('list')
  @HttpCode(200)
  list(@Body({ schema: MarketItemListSchema }) input: MarketItemListDto) {
    return this.service.list(input)
  }

  @Post('save')
  @HttpCode(200)
  save(@Body({ schema: MarketItemSaveSchema }) input: MarketItemSaveDto) {
    return this.service.save(input)
  }

  @Post('remove')
  @HttpCode(200)
  remove(@Body({ schema: MarketItemKeySchema }) input: MarketItemKeyDto) {
    return this.service.remove(input)
  }
}
