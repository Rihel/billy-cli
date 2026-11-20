import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module.js'
import { MarketController } from './market.controller.js'
import { MarketRepository } from './market.repository.js'
import { MarketService } from './market.service.js'

/** AI 市场模块（v1 只做 MCP 区；CLI / 技能个人区随用户端开放） */
@Module({
  imports: [AdminModule],
  controllers: [MarketController],
  providers: [MarketRepository, MarketService],
  exports: [MarketService],
})
export class MarketModule {}
