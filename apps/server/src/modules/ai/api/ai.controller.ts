import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common'
import {
  AgentChatSchema,
  AgentChatResumeSchema,
  AgentRunStopSchema,
  AgentConversationCreateSchema,
  AgentConversationIdSchema,
  AgentConversationListSchema,
  AgentConversationRenameSchema,
  AgentInstructionsSchema,
  AgentRunIdSchema,
  AgentRunListSchema,
  AgentTimelineListSchema,
  AgentUsageSummaryQuerySchema,
  AgentUsageRangeSchema,
  type AgentRunIdDto,
  type AgentRunListDto,
  type AgentChatDto,
  type AgentChatResumeDto,
  type AgentRunStopDto,
  type AgentConversationCreateDto,
  type AgentConversationIdDto,
  type AgentConversationListDto,
  type AgentConversationRenameDto,
  type AgentInstructionsDto,
  type AgentTimelineListDto,
  type AgentUsageSummaryQueryDto,
  type AgentUsageRangeDto,
  type AgentFileAdminListDto,
  type AgentFileAdminStatsDto,
  type AgentFileAdminPreviewDto,
  type AgentFileBinaryDto,
  AgentFileAdminPreviewSchema,
  AgentFileBinarySchema,
  AgentFileAdminListSchema,
  AgentFileAdminStatsSchema,
} from '@repo/shared'
import type { Response } from 'express'
import { requestContext } from '../../../common/index.js'
import { AnyAuthGuard } from '../../auth/index.js'
import { AdminAuthGuard } from '../../admin/index.js'
import { AgentService } from '../agents/service.js'
import { AiModelService } from '../../ai-model/index.js'
import { AgentChatService } from '../runtime/chat.service.js'
import { AgentConversationService } from '../runtime/conversation.service.js'
import { FileService, type FileContext } from '../files/file.service.js'
import {
  WorkspaceContentQuerySchema,
  WorkspaceListSchema,
  WorkspacePreviewSchema,
} from '../files/file.schemas.js'
import { ToolDeniedError } from '../core/tools/tools.types.js'
import { AgentRunService } from '../runtime/run.service.js'
import { AgentTimelineService } from '../runtime/timeline.service.js'
import { AiUsageService } from '../../ai-usage/ai-usage.service.js'

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
    @Inject(AiUsageService) private readonly aiUsage: AiUsageService,
    @Inject(AgentChatService) private readonly chat: AgentChatService,
    @Inject(FileService) private readonly files: FileService,
  ) {}

  /**
   * 当前身份 id：**前台用户优先，其次管理员**。
   *
   * 为什么不用 `currentUserId()`：AI 能力对两端都开放（会话页在 **admin** 里，带的是管理员 token），
   * 而 `currentUserId()` 在管理员身份下会**抛错**（`currentAdminId()` 反之亦然）。
   * 与 SSE 订阅同一套做法：从请求上下文里读，读到谁就是谁。
   */
  /**
   * 当前身份**是不是管理员**。
   *
   * 工具作用域（`admin` / `user`）需要这个判据，而 `ownerId()` 把两种身份揉成了一个字符串；
   * 判据与它同源：**有 userId 就是前台用户，只有 adminId 才是管理员**。
   */
  private isAdminIdentity(): boolean {
    return !requestContext.get('userId') && Boolean(requestContext.get('adminId'))
  }

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
   * 系统指令原文（前端「查看系统指令」）。
   *
   * 分流一次就够，所以放在 HTTP 边界：
   * - 带 `conversationId` → 该会话**实际用过的快照**（渲染后、含首轮运行环境，归属校验走会话服务）；
   * - 不带 → 装配期渲染好的**静态定义**（还没跑过任何一轮时唯一可回的东西）。
   * 两条路径回同一个数据结构（`source` 字段标明来源），前端不用分支。
   */
  @Post('instructions')
  @HttpCode(200)
  instructions(@Body({ schema: AgentInstructionsSchema }) input: AgentInstructionsDto) {
    return input.conversationId
      ? this.conversations.instructions(this.ownerId(), input)
      : this.agentService.instructions(input)
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
    return this.chat.chat(this.ownerId(), input, this.isAdminIdentity())
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
    await this.chat.chatStream(this.ownerId(), input, response, this.isAdminIdentity())
  }

  /**
   * 回答挂起中的一轮：`ask-user-questions` 挂起后，前端把整组答案发到这里，
   * 服务端用同一个 engine runId 续跑并继续以 SSE 返回。
   */
  @Post('chat/resume')
  @HttpCode(200)
  async chatResume(
    @Body({ schema: AgentChatResumeSchema }) input: AgentChatResumeDto,
    @Res() response: Response,
  ): Promise<void> {
    await this.chat.resumeChat(this.ownerId(), input, response, this.isAdminIdentity())
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

  /** 重命名会话（用户手动改名；会记一条时间线事件，见服务层注释） */
  @Post('conversation/rename')
  @HttpCode(200)
  renameConversation(
    @Body({ schema: AgentConversationRenameSchema }) input: AgentConversationRenameDto,
  ) {
    return this.conversations.rename(this.ownerId(), input)
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

  /**
   * 控制台「AI 用量」汇总（**管理员**）：跨用户看近 N 天的 token / 轮数 / 成功率 /
   * 分模型与 agent。只聚合根 run，子 agent 的消耗已并入父 run，不重复计费。
   */
  @Post('usage/summary')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  usageSummary(@Body({ schema: AgentUsageSummaryQuerySchema }) input: AgentUsageSummaryQueryDto) {
    return this.runs.usageSummary(input)
  }

  @Post('usage/rollup')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  usageRollup(@Body({ schema: AgentUsageRangeSchema }) input: AgentUsageRangeDto) {
    return this.aiUsage.backfill(input.from, input.to).then((days) => ({ days }))
  }

  @Post('timeline/list')
  @HttpCode(200)
  listTimeline(@Body({ schema: AgentTimelineListSchema }) input: AgentTimelineListDto) {
    return this.timelines.list(this.ownerId(), input)
  }

  /** 文件原始字节（base64）：PPTX 等前端渲染器需要 ArrayBuffer */
  @Post('file/binary')
  @HttpCode(200)
  async fileBinary(@Body({ schema: AgentFileBinarySchema }) input: AgentFileBinaryDto) {
    if (input.fileId) {
      if (!this.isAdminIdentity()) throw new ForbiddenException('只有管理员可以按 fileId 读取文件')
    } else {
      if (!input.conversationId) throw new BadRequestException('缺少 conversationId')
      await this.conversations.requireOwned(this.ownerId(), input.conversationId)
    }
    try {
      return await this.files.binary(this.fileContext(input.conversationId ?? ''), input)
    } catch (error) {
      this.rethrowFileError(error)
    }
  }

  /** 后台独立文件页：全量文件列表（管理员；含所属会话标题） */
  @Post('file/admin/list')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  adminFileList(@Body({ schema: AgentFileAdminListSchema }) input: AgentFileAdminListDto) {
    return this.files.adminList(input)
  }

  /** 后台独立文件页：文本预览（管理员；任意会话） */
  @Post('file/admin/preview')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  async adminFilePreview(
    @Body({ schema: AgentFileAdminPreviewSchema }) input: AgentFileAdminPreviewDto,
  ) {
    try {
      return await this.files.adminPreview(input.fileId)
    } catch (error) {
      this.rethrowFileError(error)
    }
  }

  /** 后台独立文件页：文件总量统计（管理员；与列表共用筛选） */
  @Post('file/admin/stats')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  adminFileStats(@Body({ schema: AgentFileAdminStatsSchema }) input: AgentFileAdminStatsDto) {
    return this.files.adminStats(input)
  }

  /** 右栏「工作区」视图：扁平文件清单（不含内容） */
  @Post('file/workspace')
  @HttpCode(200)
  async listWorkspace(@Body({ schema: WorkspaceListSchema }) input: { conversationId: string; includeCaches?: boolean }) {
    await this.conversations.requireOwned(this.ownerId(), input.conversationId)
    try {
      return await this.files.workspaceFiles(this.fileContext(input.conversationId), {
        includeCaches: input.includeCaches,
      })
    } catch (error) {
      this.rethrowFileError(error)
    }
  }

  /** 文本 / HTML 预览：会话文件（ai）或工作区文件（workspace） */
  @Post('file/preview')
  @HttpCode(200)
  async previewFile(@Body({ schema: WorkspacePreviewSchema }) input: { conversationId: string; path: string; source?: 'ai' | 'workspace' }) {
    await this.conversations.requireOwned(this.ownerId(), input.conversationId)
    try {
      return await this.files.previewText(
        this.fileContext(input.conversationId),
        input.path,
        input.source ?? 'ai',
      )
    } catch (error) {
      this.rethrowFileError(error)
    }
  }

  /**
   * 工作区内容流（图片 / PDF / 视频 / 音频 / 下载）。
   *
   * GET：`<img>` / `<video>` / `<iframe>` 带不上 Authorization，按身份读 `access-token` / `admin-access-token` cookie
   * （与 SSR 同一套）。跨站部署时前端改用 fetch blob。
   */
  @Get('file/workspace-content')
  async workspaceContent(
    @Query() query: Record<string, unknown>,
    @Headers('range') range: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const parsed = WorkspaceContentQuerySchema.safeParse(query)
    if (!parsed.success) {
      response.status(400).json({ message: '参数不合法', issues: parsed.error.issues })
      return
    }
    const input = parsed.data
    try {
      await this.conversations.requireOwned(this.ownerId(), input.conversationId)
      const content = await this.files.workspaceContent(
        this.fileContext(input.conversationId),
        input.path,
        input.download === '1',
      )
      response.setHeader('Content-Type', content.mediaType)
      response.setHeader('Accept-Ranges', 'bytes')
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader(
        'Content-Disposition',
        `${content.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(
          basename(content.path).replace(/[\r\n"\\]/g, '_'),
        )}`,
      )

      const match = range?.match(/^bytes=(\d*)-(\d*)$/)
      if (match && content.size > 0) {
        const start = match[1] ? Number(match[1]) : 0
        const end = match[2] ? Number(match[2]) : content.size - 1
        const safeEnd = Math.min(end, content.size - 1)
        if (start <= safeEnd) {
          response.status(206)
          response.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${content.size}`)
          response.setHeader('Content-Length', String(safeEnd - start + 1))
          createReadStream(content.path, { start, end: safeEnd }).pipe(response)
          return
        }
      }

      response.setHeader('Content-Length', String(content.size))
      createReadStream(content.path).pipe(response)
    } catch (error) {
      if (error instanceof ToolDeniedError) {
        response
          .status(error.reason === 'forbidden' ? 403 : 400)
          .json({ message: error.message })
        return
      }
      response.status(500).json({ message: '读取工作区文件失败' })
    }
  }

  /** HTTP 侧的文件上下文：身份从 ALS 取，run / toolCall 为空 */
  private fileContext(conversationId: string): FileContext {
    const userId = requestContext.get('userId') ?? null
    const adminId = requestContext.get('adminId') ?? null
    return {
      conversationId,
      userId: userId ?? adminId,
      isAdmin: Boolean(adminId) && !userId,
      runId: null,
      toolCallId: null,
    }
  }

  private rethrowFileError(error: unknown): never {
    if (error instanceof ToolDeniedError) {
      if (error.reason === 'forbidden') throw new ForbiddenException(error.message)
      if (error.reason === 'upstream') throw new ServiceUnavailableException(error.message)
      throw new BadRequestException(error.message)
    }
    throw error
  }
}
