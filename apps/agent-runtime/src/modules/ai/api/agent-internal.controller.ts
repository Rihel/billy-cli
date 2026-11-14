import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common'
import {
  AgentChatResumeSchema,
  AgentChatSchema,
  AgentRunStopSchema,
  type AgentChatDto,
  type AgentChatResumeDto,
  type AgentRunStopDto,
} from '@repo/shared'
import type { Response } from 'express'
import { AgentChatService } from '../runtime/chat.service.js'

/** main 的内部会话入口：身份由 main 鉴权后通过内部 token + 头传入 */
@Controller('internal/agent')
export class AgentInternalController {
  constructor(@Inject(AgentChatService) private readonly chat: AgentChatService) {}

  @Post('chat')
  @HttpCode(200)
  chatOnce(
    @Body({ schema: AgentChatSchema }) input: AgentChatDto,
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-admin-id') adminId: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
  ) {
    const owner = this.requireOwner(token, userId, adminId)
    return this.chat.chat(owner.id, input, owner.isAdmin)
  }

  @Post('chat/stream')
  @HttpCode(200)
  async chatStream(
    @Body({ schema: AgentChatSchema }) input: AgentChatDto,
    @Headers('x-main-client-id') clientId: string | undefined,
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-admin-id') adminId: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const owner = this.requireOwner(token, userId, adminId)
    await this.chat.chatStream(
      owner.id,
      input,
      response,
      owner.isAdmin,
      clientId?.trim() || undefined,
    )
  }

  @Post('chat/resume')
  @HttpCode(200)
  async chatResume(
    @Body({ schema: AgentChatResumeSchema }) input: AgentChatResumeDto,
    @Headers('x-main-client-id') clientId: string | undefined,
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-admin-id') adminId: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const owner = this.requireOwner(token, userId, adminId)
    await this.chat.resumeChat(
      owner.id,
      input,
      response,
      owner.isAdmin,
      clientId?.trim() || undefined,
    )
  }

  @Post('run/stop')
  @HttpCode(200)
  stopRun(
    @Body({ schema: AgentRunStopSchema }) input: AgentRunStopDto,
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-admin-id') adminId: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
  ) {
    const owner = this.requireOwner(token, userId, adminId)
    return this.chat.stopRun(owner.id, input.runId)
  }

  @Get('run/stream')
  async resumeCurrentRun(
    @Query('offset') offset: string,
    @Query('conversationId') conversationId: string,
    @Headers('x-main-client-id') clientId: string | undefined,
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-admin-id') adminId: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const owner = this.requireOwner(token, userId, adminId)
    const from = Number.parseInt(offset ?? '0', 10)
    const resumed = await this.chat.resumeCurrentRun(
      owner.id,
      Number.isFinite(from) && from > 0 ? from : 0,
      response,
      conversationId?.trim() || undefined,
      clientId?.trim() || undefined,
    )
    if (!resumed) response.status(204).end()
  }

  @Get('run/:runId/stream')
  async resumeRun(
    @Param('runId') runId: string,
    @Query('offset') offset: string,
    @Headers('x-main-client-id') clientId: string | undefined,
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-admin-id') adminId: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const owner = this.requireOwner(token, userId, adminId)
    const from = Number.parseInt(offset ?? '0', 10)
    const resumed = await this.chat.resumeRun(
      owner.id,
      runId,
      Number.isFinite(from) && from > 0 ? from : 0,
      response,
      clientId?.trim() || undefined,
    )
    if (!resumed) response.status(204).end()
  }

  private requireOwner(
    token: string | undefined,
    userId: string | undefined,
    adminId: string | undefined,
  ): { id: string; isAdmin: boolean } {
    const expected = process.env.AGENT_INTERNAL_TOKEN
    if (!expected || token !== expected) throw new UnauthorizedException('内部令牌不合法')
    const id = userId || adminId
    if (!id) throw new UnauthorizedException('缺少调用方身份')
    return { id, isAdmin: !userId && Boolean(adminId) }
  }
}
