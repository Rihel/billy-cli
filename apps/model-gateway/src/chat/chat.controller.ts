import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'
import { InternalTokenGuard } from '../http/internal-token.guard.js'
import { ChatService } from './chat.service.js'

/**
 * canonical 对话入口（只在私有网络；由 runtime 调用）。
 *
 * 路径里带 `modelId`：网关不需要解析请求体来路由，多模态 base64 不用额外 parse。
 */
@Controller('v1/models')
@UseGuards(InternalTokenGuard)
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  @Post(':modelId/chat/completions')
  @HttpCode(200)
  async completions(
    @Param('modelId') modelId: string,
    @Body() body: unknown,
    @Res() response: Response,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    await this.chat.handle(modelId, body, response, headers)
  }
}
