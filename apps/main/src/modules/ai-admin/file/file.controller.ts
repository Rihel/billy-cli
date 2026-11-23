import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import {
  AgentFileAdminListSchema,
  AgentFileAdminPreviewSchema,
  AgentFileAdminRemoveSchema,
  AgentFileAdminStatsSchema,
  AgentFileRemoveSchema,
  AgentFileWorkspaceLinkSchema,
  type AgentFileAdminListDto,
  type AgentFileAdminPreviewDto,
  type AgentFileAdminRemoveDto,
  type AgentFileAdminStatsDto,
  type AgentFileRemoveDto,
  type AgentFileWorkspaceLinkDto,
} from '@repo/shared'
import {
  FileDeniedError,
  FileForbiddenError,
  FileInvalidInputError,
  FileNotFoundError,
  FileService,
  FileWorkspaceUnavailableError,
  WorkspaceContentQuerySchema,
  WorkspaceListSchema,
  WorkspacePreviewSchema,
  type FileContext,
} from '@repo/ai-data'
import type { Response } from 'express'
import { AdminAuthGuard } from '../../admin/admin-auth.guard.js'
import { AnyAuthGuard } from '../../auth/index.js'
import { Db, requestContext } from '@repo/kits'
import { ConversationEntity } from '@repo/db'
import { AiAdminConversationService } from '../conversation/conversation.service.js'

/** 会话页右栏「文件」tab：工作区、文本预览、admin 文件页 */
@Controller('agent/file')
@UseGuards(AnyAuthGuard)
export class AiFileController {
  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Inject(AiAdminConversationService) private readonly conversations: AiAdminConversationService,
    @Inject(Db) private readonly db: Db,
  ) {}

  @Post('workspace')
  @HttpCode(200)
  async workspace(
    @Body({ schema: WorkspaceListSchema }) input: {
      conversationId: string
      includeCaches?: boolean
    },
  ) {
    await this.conversations.requireOwned(input.conversationId)
    try {
      return await this.files.workspaceFiles(await this.context(input.conversationId), {
        includeCaches: input.includeCaches,
        // 右栏文件树要**一次成型**：分页的半棵树会让用户以为文件少了（模型工具另走分页）
        all: true,
      })
    } catch (error) {
      this.rethrow(error)
    }
  }

  @Post('preview')
  @HttpCode(200)
  async preview(
    @Body({ schema: WorkspacePreviewSchema }) input: {
      conversationId: string
      path: string
      source?: 'ai' | 'workspace'
    },
  ) {
    await this.conversations.requireOwned(input.conversationId)
    try {
      return await this.files.previewText(
        await this.context(input.conversationId),
        input.path,
        input.source ?? 'ai',
      )
    } catch (error) {
      this.rethrow(error)
    }
  }

  @Post('workspace-link')
  @HttpCode(200)
  async workspaceLink(
    @Body({ schema: AgentFileWorkspaceLinkSchema }) input: AgentFileWorkspaceLinkDto,
  ) {
    await this.conversations.requireOwned(input.conversationId)
    try {
      return await this.files.workspaceLink(await this.context(input.conversationId), input)
    } catch (error) {
      this.rethrow(error)
    }
  }

  @Post('admin/list')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  adminList(@Body({ schema: AgentFileAdminListSchema }) input: AgentFileAdminListDto) {
    return this.files.adminList(input)
  }

  @Post('admin/stats')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  adminStats(@Body({ schema: AgentFileAdminStatsSchema }) input: AgentFileAdminStatsDto) {
    return this.files.adminStats(input)
  }

  @Post('admin/preview')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  async adminPreview(
    @Body({ schema: AgentFileAdminPreviewSchema }) input: AgentFileAdminPreviewDto,
  ) {
    try {
      return await this.files.adminPreview(input.fileId)
    } catch (error) {
      this.rethrow(error)
    }
  }

  @Get('workspace-content')
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
      await this.conversations.requireOwned(input.conversationId)
      const content = await this.files.workspaceContent(
        await this.context(input.conversationId),
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
      // 执行面（容器）没有本地路径：字节已经在内存里，直接切 Range 返回
      if (content.body) {
        const buf = content.body
        if (match && buf.length > 0) {
          const start = match[1] ? Number(match[1]) : 0
          const end = match[2] ? Number(match[2]) : buf.length - 1
          const safeEnd = Math.min(end, buf.length - 1)
          if (start <= safeEnd) {
            response.status(206)
            response.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${buf.length}`)
            response.setHeader('Content-Length', String(safeEnd - start + 1))
            response.end(buf.subarray(start, safeEnd + 1))
            return
          }
        }
        response.setHeader('Content-Length', String(buf.length))
        response.end(buf)
        return
      }
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
      if (response.headersSent) {
        response.end()
        return
      }
      this.rethrow(error)
    }
  }

  /** 管理员删除（硬删）：任意会话，不受归属限制 */
  @Post('admin/remove')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  adminRemove(@Body({ schema: AgentFileAdminRemoveSchema }) input: AgentFileAdminRemoveDto) {
    return this.files.remove({ fileId: input.fileId })
  }

  /** 会话侧删除（硬删）：先校验会话归属，只能删自己会话里的文件 */
  @Post('remove')
  @HttpCode(200)
  async remove(@Body({ schema: AgentFileRemoveSchema }) input: AgentFileRemoveDto) {
    try {
      await this.conversations.requireOwned(input.conversationId)
      return await this.files.remove({
        fileId: input.fileId,
        conversationId: input.conversationId,
      })
    } catch (error) {
      this.rethrow(error)
    }
  }

  /** 上下文里带上工作区 id：文件树 / 预览才能读到容器内的文件（读不到时回落本地根） */
  private async context(conversationId: string): Promise<FileContext> {
    const userId = requestContext.get('userId') ?? null
    const adminId = requestContext.get('adminId') ?? null
    const row = await this.db
      .getRepository(ConversationEntity)
      .findOne({ where: { id: conversationId }, select: { workspaceId: true } })
    return {
      conversationId,
      ...(row?.workspaceId ? { workspaceId: row.workspaceId } : {}),
      userId: userId ?? adminId,
      isAdmin: Boolean(adminId) && !userId,
      runId: null,
      toolCallId: null,
    }
  }

  private rethrow(error: unknown): never {
    // 必须抛 AppError 子类（带业务码）：包成 `BadRequestException` 会被边界统一成
    // 「请求体格式不正确」，真实的 not-found / 目录 / 工作区不可用全部丢失（issue A）
    if (error instanceof FileDeniedError) {
      if (error.reason === 'forbidden') throw new FileForbiddenError(error.message)
      if (error.reason === 'upstream') throw new FileWorkspaceUnavailableError(error.message)
      if (error.reason === 'not-found') throw new FileNotFoundError(error.message)
      throw new FileInvalidInputError(error.message)
    }
    throw error
  }
}
