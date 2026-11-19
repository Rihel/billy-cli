import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { AppLogger, Db, RedisStore } from '@repo/kits'
import { TimelineEntity } from '@repo/db'
import { parsePageHandle, paginate } from '@repo/ai-data'
import { TimelineKind } from '@repo/shared'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from '../config/app-config.js'

/** read-tool-result 直连 Redis / PG：分页全文由 server 的 paginate 插件写 Redis，timeline 兜底 */
@Injectable()
@CapabilityGroup({ risk: 'read' })
export class ReadToolResultExecutor {
  constructor(
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(Db) private readonly db: Db,
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  @CapabilityDecl({
    tool: 'read-tool-result',
    title: '读取工具结果的下一页',
    description: [
      '读取某个工具结果的后续页（结果太大时只给了你一页）。',
      '',
      '什么时候用：出参里有 page 与 handle，而你需要后面的内容。',
      '什么时候不用：第一页够用就别取 —— 每次取页都花 token。',
      '',
      '约束：取到的是原文片段（没有摘要），自己判断该看哪一页；',
      '同一个 handle 可以反复取（结果已入库），但每轮取页次数有上限。',
    ].join('\n'),
    input: z.object({
      handle: z.string().min(1).max(128).describe('上一页给出的取页句柄'),
      page: z.number().int().positive().optional().describe('要取的页码'),
    }),
  })
  async readToolResult(request: ToolInvokeRequest): Promise<ToolOutcome> {
    // 与登记同一份入参
    const parsed = findCapabilityDecl(this, 'read-tool-result').input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `取页参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const input = parsed.data as { handle: string; page?: number }
    const handle = parsePageHandle(input.handle)
    if (!handle) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: '取页句柄格式不对（应当原样传回结果里的 handle）',
        retryable: false,
      }
    }
    const caller = request.caller
    if (handle.conversationId !== caller.conversationId) {
      return { ok: false, reason: 'forbidden', message: '这个句柄不属于当前会话，不能读取' }
    }

    const maxPages = Number(request.settings?.limits.maxPagesPerTurn ?? 20)
    const used = await this.redis.incr(`ai:tool:pages:${caller.runId}`)
    if (used === 1) await this.redis.expire(`ai:tool:pages:${caller.runId}`, 3600)
    if (used > maxPages) {
      return {
        ok: false,
        reason: 'rate-limited',
        message: `这一轮取页次数已达上限（${maxPages} 次）`,
        hint: '用已经取到的内容作答，或把工具入参收窄一点重跑那个工具',
        retryable: false,
      }
    }

    const key = `ai:tool-result:${handle.conversationId}:${handle.toolCallId}`
    let full = await this.redis.get(key).catch(() => null)
    if (full === null) full = await this.fromTimeline(handle.conversationId, handle.toolCallId)
    if (full === null) {
      return {
        ok: false,
        reason: 'precheck-failed',
        message: '这一页取不到了：原始结果不在 Redis / 时间线里',
        hint: '重跑一次产生这个结果的工具（入参收窄一点）',
        retryable: false,
      }
    }

    const pageBytes = Number(
      request.settings?.limits.pageBytes ?? request.settings?.config.pageBytes ?? 8 * 1024,
    )
    const page = paginate(full, pageBytes, input.page ?? 1, input.handle)
    this.logger.info('tool_worker.read_tool_result', {
      requestId: request.requestId,
      runId: caller.runId,
      toolCallId: handle.toolCallId,
      page: page.meta.page,
      totalPages: page.meta.totalPages,
    })
    return { ok: true, data: { page: page.meta, content: page.content } }
  }

  private async fromTimeline(conversationId: string, toolCallId: string): Promise<string | null> {
    try {
      const row = await this.db.getRepository(TimelineEntity).findOne({
        where: { conversationId, toolCallId, kind: TimelineKind.ToolResult },
        order: { seq: 'DESC' },
      })
      const output = row?.payload?.output
      if (output === undefined) return null
      const value =
        typeof output === 'object' && output !== null && '__toolPaged' in output
          ? (output as { data?: unknown }).data
          : output
      return JSON.stringify(value ?? null)
    } catch (error) {
      this.logger.warn('tool_worker.read_tool_result_timeline_failed', {
        conversationId,
        toolCallId,
        reason: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
}
