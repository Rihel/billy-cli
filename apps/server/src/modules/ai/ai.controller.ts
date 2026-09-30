import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import {
  AgentChatSchema,
  AgentRunStopSchema,
  AgentConversationCreateSchema,
  AgentConversationIdSchema,
  AgentConversationListSchema,
  AgentRunIdSchema,
  AgentRunListSchema,
  AgentTimelineListSchema,
  type AgentRunIdDto,
  type AgentRunListDto,
  type AgentChatDto,
  type AgentRunStopDto,
  type AgentConversationCreateDto,
  type AgentConversationIdDto,
  type AgentConversationListDto,
  type AgentTimelineListDto,
} from '@repo/shared'
import type { Response } from 'express'
import { requestContext } from '../../common/index.js'
import { AnyAuthGuard } from '../auth/index.js'
import { AgentService } from './core/ai.service.js'
import { AiModelService } from '../ai-model/index.js'
import { AgentChatService } from './runtime/chat.service.js'
import { AgentConversationService } from './runtime/conversation.service.js'
import { AgentRunService } from './runtime/run.service.js'
import { AgentTimelineService } from './runtime/timeline.service.js'

/**
 * AI 路由（`/agent/*`，前台用户鉴权；全部 POST + 显式 `@HttpCode(200)`）。
 *
 * 分两组：
 * - **装配查询**（status / list）：AI 能力状态与 agent 清单；
 * - **会话读写**（conversation/*、timeline/list）：会话增删查与时间线查询。
 *   归属一律由服务端从鉴权上下文取 userId（`this.ownerId()`），**不接受前端传**。
 *
 * 对话与流式推送（建流 / 重连 / 停止）在后续步骤接入，见设计文档 §3.13 与 §5。
 */
@Controller('agent')
@UseGuards(AnyAuthGuard)
export class AiController {
  constructor(
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(AiModelService) private readonly modelService: AiModelService,
    @Inject(AgentConversationService)
    private readonly conversations: AgentConversationService,
    @Inject(AgentTimelineService) private readonly timelines: AgentTimelineService,
    @Inject(AgentRunService) private readonly runs: AgentRunService,
    @Inject(AgentChatService) private readonly chat: AgentChatService,
  ) {}

  /**
   * 当前身份 id：**前台用户优先，其次管理员**。
   *
   * 为什么不用 `currentUserId()`：AI 能力对两端都开放（会话页在 **admin** 里，带的是管理员 token），
   * 而 `currentUserId()` 在管理员身份下会**抛错**（`currentAdminId()` 反之亦然）。
   * 与 SSE 订阅同一套做法：从请求上下文里读，读到谁就是谁。
   */
  private ownerId(): string {
    const userId = requestContext.get('userId')
    if (userId) return userId
    const adminId = requestContext.get('adminId')
    if (adminId) return adminId
    // 走到这里说明守卫放行了却没写身份（真正的编程错误，而不是"没登录"）
    throw new Error('Authenticated request context is unavailable')
  }

  @Post('status')
  @HttpCode(200)
  status() {
    return this.agentService.status()
  }

  @Post('list')
  @HttpCode(200)
  list() {
    return this.agentService.list()
  }

  /**
   * 本轮**可选的模型**（会话页选择器的数据源）。
   *
   * 只回"供应商启用 + 模型启用"的（§4.9）—— 也就是说，选择器里能看到的每一个模型，
   * 都是后台配过的、确定能用的；库空时返回空数组（前端据此提示"先去后台配模型"）。
   */
  @Post('models')
  @HttpCode(200)
  models() {
    return this.modelService.listAvailable()
  }

  /**
   * 一轮问答（非流式）：跑完返回结果；用户消息、推理、工具调用与结果、消耗都已落库。
   * 流式版本在后续步骤接入（`/agent/chat/stream`）。
   */
  @Post('chat')
  @HttpCode(200)
  chatOnce(@Body({ schema: AgentChatSchema }) input: AgentChatDto) {
    return this.chat.chat(this.ownerId(), input)
  }

  /**
   * 流式一轮问答：响应体是 AI SDK UI Message Stream（SSE），**唯一不套信封**的对话接口。
   * 控制器返回 undefined → 信封拦截器跳过（与 `POST /sse/subscribe` 同一手法）。
   */
  @Post('chat/stream')
  @HttpCode(200)
  async chatStream(
    @Body({ schema: AgentChatSchema }) input: AgentChatDto,
    @Res() response: Response,
  ): Promise<void> {
    await this.chat.chatStream(this.ownerId(), input, response)
  }

  /** 停止某一轮（本进程 abort；在别的副本上则广播） */
  @Post('run/stop')
  @HttpCode(200)
  stopRun(@Body({ schema: AgentRunStopSchema }) input: AgentRunStopDto) {
    return this.chat.stopRun(this.ownerId(), input.runId)
  }

  /**
   * 断线重连（**不知道 runId 时用**）：按登录用户在库里找当前进行中的那一轮。
   *
   * 前端 `useChat({ resume: true })` 挂载时调的就是它 —— 刷新 / 换设备都能接回正在跑的流；
   * 没有进行中的运行回 204（AI SDK 据此静默结束重连，不报错、不刷红）。
   */
  @Get('run/stream')
  async resumeCurrentRun(
    @Query('offset') offset: string,
    @Res() response: Response,
  ): Promise<void> {
    const from = Number.parseInt(offset ?? '0', 10)
    const resumed = await this.chat.resumeCurrentRun(
      this.ownerId(),
      Number.isFinite(from) && from > 0 ? from : 0,
      response,
    )
    if (!resumed) response.status(204).end()
  }

  /**
   * 断线重连：按 `offset` 从 Redis 输出记录补发，再接实时。
   *
   * GET 例外（全工程第一处是 ops 探针，这里是第二、三处，见 `run/stream`）：AI SDK 的续传约定
   * 就是 GET + 204 表示"没有进行中的流"，改成 POST 会与 `useChat({ resume: true })` 不兼容。
   */
  @Get('run/:runId/stream')
  async resumeRun(
    @Param('runId') runId: string,
    @Query('offset') offset: string,
    @Res() response: Response,
  ): Promise<void> {
    const from = Number.parseInt(offset ?? '0', 10)
    const resumed = await this.chat.resumeRun(
      this.ownerId(),
      runId,
      Number.isFinite(from) && from > 0 ? from : 0,
      response,
    )
    if (!resumed) response.status(204).end()
  }

  @Post('conversation/create')
  @HttpCode(200)
  createConversation(
    @Body({ schema: AgentConversationCreateSchema }) input: AgentConversationCreateDto,
  ) {
    return this.conversations.create(this.ownerId(), input)
  }

  @Post('conversation/list')
  @HttpCode(200)
  listConversations(
    @Body({ schema: AgentConversationListSchema }) input: AgentConversationListDto,
  ) {
    return this.conversations.list(this.ownerId(), input)
  }

  @Post('conversation/detail')
  @HttpCode(200)
  detailConversation(
    @Body({ schema: AgentConversationIdSchema }) input: AgentConversationIdDto,
  ) {
    return this.conversations.detail(this.ownerId(), input)
  }

  /** 软删会话（**唯一的删除入口**；运行记录与时间线不提供删除） */
  @Post('conversation/remove')
  @HttpCode(200)
  async removeConversation(
    @Body({ schema: AgentConversationIdSchema }) input: AgentConversationIdDto,
  ) {
    await this.conversations.remove(this.ownerId(), input)
    return { removed: true }
  }

  /** 运行列表（审计 / 复盘：含子 agent 的 run，父子列齐备） */
  @Post('run/list')
  @HttpCode(200)
  listRuns(@Body({ schema: AgentRunListSchema }) input: AgentRunListDto) {
    return this.runs.list(this.ownerId(), input)
  }

  /** 运行详情（输入快照 + 上游错误原文 + 子 agent 列表）：复盘的深挖入口 */
  @Post('run/detail')
  @HttpCode(200)
  detailRun(@Body({ schema: AgentRunIdSchema }) input: AgentRunIdDto) {
    return this.runs.detail(this.ownerId(), input)
  }

  @Post('timeline/list')
  @HttpCode(200)
  listTimeline(@Body({ schema: AgentTimelineListSchema }) input: AgentTimelineListDto) {
    return this.timelines.list(this.ownerId(), input)
  }
}
