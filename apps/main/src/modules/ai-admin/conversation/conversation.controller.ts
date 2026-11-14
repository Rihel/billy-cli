import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common'
import {
  AgentConversationCreateSchema,
  AgentConversationFileAccessSchema,
  AgentConversationIdSchema,
  AgentConversationListSchema,
  AgentConversationRenameSchema,
  AgentInstructionsSchema,
  AgentRunIdSchema,
  AgentRunListSchema,
  AgentTimelineListSchema,
  AgentUsageRangeSchema,
  AgentUsageSummaryQuerySchema,
  type AgentConversationCreateDto,
  type AgentConversationFileAccessDto,
  type AgentConversationIdDto,
  type AgentConversationListDto,
  type AgentConversationRenameDto,
  type AgentInstructionsDto,
  type AgentRunIdDto,
  type AgentRunListDto,
  type AgentTimelineListDto,
  type AgentUsageRangeDto,
  type AgentUsageSummaryQueryDto,
} from '@repo/shared'
import { AnyAuthGuard } from '../../auth/index.js'
import { AdminAuthGuard } from '../../admin/index.js'
import { AiAdminConversationService } from './conversation.service.js'

/**
 * AI 会话 / 运行 / 时间线的查询 CRUD 路由（`/agent/*`）。
 *
 * 与 agent-runtime 的分工：**对话执行**（`/agent/chat/stream`，Kafka SSE）在别处；
 * 这里的每条路由都只做 PG 查询或会话 CRUD，**不 import agent loop**。
 *
 * 鉴权：类级 `AnyAuthGuard`（前台用户与后台管理员都可用）；
 * 用量汇总是跨用户视角，单独叠 `AdminAuthGuard`。
 * 归属一律由服务层从 `requestContext` 取，**不接受前端传 userId / adminId**。
 */
@Controller('agent')
@UseGuards(AnyAuthGuard)
export class AiAdminConversationController {
  constructor(
    @Inject(AiAdminConversationService)
    private readonly conversations: AiAdminConversationService,
  ) {}

  @Post('status')
  @HttpCode(200)
  status() {
    return this.conversations.status()
  }

  @Post('list')
  @HttpCode(200)
  list() {
    return this.conversations.listAgents()
  }

  /** 系统指令原文（有会话快照回快照，否则回静态定义） */
  @Post('instructions')
  @HttpCode(200)
  instructions(@Body({ schema: AgentInstructionsSchema }) input: AgentInstructionsDto) {
    return this.conversations.instructions(input)
  }

  /** 本轮可选的模型（会话页选择器的数据源） */
  @Post('models')
  @HttpCode(200)
  models() {
    return this.conversations.modelsAvailable()
  }

  @Post('conversation/create')
  @HttpCode(200)
  createConversation(
    @Body({ schema: AgentConversationCreateSchema }) input: AgentConversationCreateDto,
  ) {
    return this.conversations.create(input)
  }

  @Post('conversation/list')
  @HttpCode(200)
  listConversations(
    @Body({ schema: AgentConversationListSchema }) input: AgentConversationListDto,
  ) {
    return this.conversations.list(input)
  }

  @Post('conversation/detail')
  @HttpCode(200)
  detailConversation(@Body({ schema: AgentConversationIdSchema }) input: AgentConversationIdDto) {
    return this.conversations.detail(input)
  }

  /** 重命名会话（用户手动改名；会记一条时间线事件） */
  @Post('conversation/rename')
  @HttpCode(200)
  renameConversation(
    @Body({ schema: AgentConversationRenameSchema }) input: AgentConversationRenameDto,
  ) {
    return this.conversations.rename(input)
  }

  /** 切换会话的文件权限（只读 / 可写；只影响沙箱内的写权限） */
  @Post('conversation/file-access')
  @HttpCode(200)
  setConversationFileAccess(
    @Body({ schema: AgentConversationFileAccessSchema })
    input: AgentConversationFileAccessDto,
  ) {
    return this.conversations.setFileAccess(input)
  }

  /** 软删会话（唯一的删除入口；运行记录与时间线不提供删除） */
  @Post('conversation/remove')
  @HttpCode(200)
  async removeConversation(
    @Body({ schema: AgentConversationIdSchema }) input: AgentConversationIdDto,
  ) {
    await this.conversations.remove(input)
    return { removed: true }
  }

  /** 运行列表（审计 / 复盘：含子 agent 的 run，父子列齐备） */
  @Post('run/list')
  @HttpCode(200)
  listRuns(@Body({ schema: AgentRunListSchema }) input: AgentRunListDto) {
    return this.conversations.listRuns(input)
  }

  /** 运行详情（输入快照 + 上游错误原文 + 子 agent 列表） */
  @Post('run/detail')
  @HttpCode(200)
  detailRun(@Body({ schema: AgentRunIdSchema }) input: AgentRunIdDto) {
    return this.conversations.detailRun(input)
  }

  @Post('timeline/list')
  @HttpCode(200)
  listTimeline(@Body({ schema: AgentTimelineListSchema }) input: AgentTimelineListDto) {
    return this.conversations.listTimeline(input)
  }

  /** 控制台「AI 用量」汇总（**管理员**）：跨用户看近 N 天的 token / 轮数 / 成功率 */
  @Post('usage/summary')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  usageSummary(@Body({ schema: AgentUsageSummaryQuerySchema }) input: AgentUsageSummaryQueryDto) {
    return this.conversations.usageSummary(input)
  }

  /** 手动回填 AI 用量日表（**管理员**） */
  @Post('usage/rollup')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  usageRollup(@Body({ schema: AgentUsageRangeSchema }) input: AgentUsageRangeDto) {
    return this.conversations.usageRollup(input)
  }
}
