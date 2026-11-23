import {
  Body,
  ConflictException,
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
  AgentConversationCancelSchema,
  AgentInstructionsSchema,
  AgentRunStopSchema,
  AgentRunQueueRemoveResultSchema,
  AgentRunQueueRemoveSchema,
  AgentRunQueueUpdateSchema,
  AgentTimelineStatusSchema,
  toAgentRunQueueItem,
  type AgentChatDto,
  type AgentChatResumeDto,
  type AgentConversationCancelDto,
  type AgentInstructionsDto,
  type AgentRunQueueRemoveDto,
  type AgentRunQueueUpdateDto,
  type AgentRunStopDto,
  type AgentTimelineStatusDto,
} from '@repo/shared'
import type { Response } from 'express'
import { AgentService } from '../agents/service.js'
import { AgentChatService } from '../runtime/chat.service.js'
import { AgentConversationService } from '../runtime/conversation.service.js'
import { AgentTimelineService } from '../runtime/timeline.service.js'
import { ConversationRunQueue } from '../runtime/run-queue.service.js'

/** main 的内部会话入口：身份由 main 鉴权后通过内部 token + 头传入 */
@Controller('internal/agent')
export class AgentInternalController {
  constructor(
    @Inject(AgentChatService) private readonly chat: AgentChatService,
    @Inject(AgentService) private readonly agents: AgentService,
    @Inject(AgentConversationService) private readonly conversations: AgentConversationService,
    @Inject(AgentTimelineService) private readonly timelines: AgentTimelineService,
    @Inject(ConversationRunQueue) private readonly runQueue: ConversationRunQueue,
  ) {}

  /**
   * 能力状态：main 的 `/agent/status` 代理到这里。
   *
   * 静态声明（agent 规格 / 提示词 / 技能 * 展开）只在本进程有一份，
   * 控制面不再复制 —— 想知道「有哪些 agent、能不能用」，只能问执行面。
   */
  @Post('status')
  @HttpCode(200)
  status(@Headers('x-internal-token') token: string | undefined) {
    this.requireToken(token)
    return this.agents.status()
  }

  /** agent 清单：main 的 `/agent/list` 代理到这里 */
  @Post('list')
  @HttpCode(200)
  list(@Headers('x-internal-token') token: string | undefined) {
    this.requireToken(token)
    return this.agents.list()
  }

  /** 运行时内建工具清单：main 的工具配置页用它（不再持有 manifest 快照） */
  @Post('tools')
  @HttpCode(200)
  tools(@Headers('x-internal-token') token: string | undefined) {
    this.requireToken(token)
    return this.agents.tools()
  }

  /** 静态系统指令：main 只在「会话还没有快照」时用它补默认值 */
  @Post('instructions')
  @HttpCode(200)
  instructions(
    @Body({ schema: AgentInstructionsSchema }) input: AgentInstructionsDto,
    @Headers('x-internal-token') token: string | undefined,
  ) {
    this.requireToken(token)
    return this.agents.instructions(input)
  }

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

  /**
   * 取消会话内所有进行中的 run + 队列项。
   *
   * main 删会话前调用：runs / timelines / conversation_run_queue 的写方是 runtime，
   * main 不再自己 `UPDATE runs` / 插 timeline。
   */
  @Post('conversation/cancel')
  @HttpCode(200)
  cancelConversation(
    @Body({ schema: AgentConversationCancelSchema }) input: AgentConversationCancelDto,
    @Headers('x-internal-token') token: string | undefined,
  ) {
    this.requireToken(token)
    return this.conversations.cancelActiveConversation(input.conversationId, input.operator)
  }

  /** 追加控制面状态事件（改名 / 文件权限变更）；timeline 写方收口到 runtime */
  @Post('timeline/status')
  @HttpCode(200)
  async appendTimelineStatus(
    @Body({ schema: AgentTimelineStatusSchema }) input: AgentTimelineStatusDto,
    @Headers('x-internal-token') token: string | undefined,
  ): Promise<{ ok: true }> {
    this.requireToken(token)
    await this.timelines.appendStatus(input.conversationId, input.payload)
    return { ok: true }
  }

  /** 修改用户排队消息（main 只做归属校验，写口在 runtime） */
  @Post('run-queue/update')
  @HttpCode(200)
  async updateRunQueue(
    @Body({ schema: AgentRunQueueUpdateSchema }) input: AgentRunQueueUpdateDto,
    @Headers('x-internal-token') token: string | undefined,
  ) {
    this.requireToken(token)
    const row = await this.runQueue.updateUserItem(
      input.conversationId,
      input.queueId,
      input.message,
    )
    if (!row) throw new ConflictException('该队列项已开始执行，不能再修改')
    return toAgentRunQueueItem(row)
  }

  /** 删除用户排队消息（条件更新，幂等语义由调用方决定） */
  @Post('run-queue/remove')
  @HttpCode(200)
  async removeRunQueue(
    @Body({ schema: AgentRunQueueRemoveSchema }) input: AgentRunQueueRemoveDto,
    @Headers('x-internal-token') token: string | undefined,
  ) {
    this.requireToken(token)
    return AgentRunQueueRemoveResultSchema.parse({
      removed: await this.runQueue.cancelUserItem(input.conversationId, input.queueId),
    })
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
    return this.chat.stopRun(owner.id, input)
  }

  @Get('run/stream')
  async resumeCurrentRun(
    @Query('sinceRev') sinceRev: string,
    @Query('conversationId') conversationId: string,
    @Headers('x-main-client-id') clientId: string | undefined,
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-admin-id') adminId: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const owner = this.requireOwner(token, userId, adminId)
    const resumed = await this.chat.resumeCurrentRun(
      owner.id,
      parseSinceRev(sinceRev),
      response,
      conversationId?.trim() || undefined,
      clientId?.trim() || undefined,
    )
    if (!resumed) response.status(204).end()
  }

  @Get('run/:runId/stream')
  async resumeRun(
    @Param('runId') runId: string,
    @Query('sinceRev') sinceRev: string,
    @Headers('x-main-client-id') clientId: string | undefined,
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-admin-id') adminId: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const owner = this.requireOwner(token, userId, adminId)
    const resumed = await this.chat.resumeRun(
      owner.id,
      runId,
      parseSinceRev(sinceRev),
      response,
      clientId?.trim() || undefined,
    )
    if (!resumed) response.status(204).end()
  }

  /** 当前进行中那一轮的快照（刷新先渲染已完成内容，再接 sinceRev 增量） */
  @Get('run/snapshot')
  async snapshotCurrentRun(
    @Query('conversationId') conversationId: string,
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-admin-id') adminId: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const owner = this.requireOwner(token, userId, adminId)
    const snapshot = await this.chat.snapshotCurrentRun(
      owner.id,
      conversationId?.trim() || undefined,
    )
    if (!snapshot) {
      response.status(204).end()
      return
    }
    response.json(snapshot)
  }

  /** 指定 run 的快照（知道 runId 时用；没有进行中的流回 204） */
  @Get('run/:runId/snapshot')
  async snapshotRun(
    @Param('runId') runId: string,
    @Headers('x-user-id') userId: string | undefined,
    @Headers('x-admin-id') adminId: string | undefined,
    @Headers('x-internal-token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const owner = this.requireOwner(token, userId, adminId)
    const snapshot = await this.chat.snapshotRun(owner.id, runId)
    if (!snapshot) {
      response.status(204).end()
      return
    }
    response.json(snapshot)
  }

  /** 只校验内部令牌（目录类查询不需要调用方身份） */
  private requireToken(token: string | undefined): void {
    const expected = process.env.AGENT_INTERNAL_TOKEN
    if (!expected || token !== expected) throw new UnauthorizedException('内部令牌不合法')
  }

  private requireOwner(
    token: string | undefined,
    userId: string | undefined,
    adminId: string | undefined,
  ): { id: string; isAdmin: boolean } {
    this.requireToken(token)
    const id = userId || adminId
    if (!id) throw new UnauthorizedException('缺少调用方身份')
    return { id, isAdmin: !userId && Boolean(adminId) }
  }
}

/** `sinceRev` 查询参数：非法 / 缺省 → undefined（= 先给快照，再补增量） */
const parseSinceRev = (value: string | undefined): number | undefined => {
  if (value === undefined || value === '') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
