import { Inject, Injectable } from '@nestjs/common'
import { MemoryRepository, MemoryService } from '@repo/ai-data'
import { MEMORY_CONTENT_MAX, AiMemoryKindField } from '@repo/shared'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import { z } from 'zod'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'

/**
 * memory-* 执行器：worker **直连 PG**（受限 DB 账号），不再回调 server。
 *
 * 与 server 共用 `@repo/ai-data` 的 MemoryService / MemoryRepository，业务规则只有一份；
 * 数据流单向：gateway → worker → PG，worker 不反向调用编排层。
 */
@Injectable()
@CapabilityGroup({ risk: 'read' })
export class MemoryExecutor {
  constructor(
    @Inject(MemoryService) private readonly memory: MemoryService,
    @Inject(MemoryRepository) private readonly _repository: MemoryRepository,
  ) {}

  @CapabilityDecl({
    tool: 'memory-save',
    title: '保存记忆',
    description: '保存一条长期记忆',
    risk: 'write',
    input: z.object({
      content: z.string().min(1).max(MEMORY_CONTENT_MAX).describe('要记住的内容'),
      kind: AiMemoryKindField.optional().describe('类型：profile / preference / fact / constraint'),
      key: z.string().min(1).max(64).optional().describe('稳定标识；同一 key 会更新原记忆'),
      pinned: z.boolean().optional().describe('是否每轮都带上'),
    }),
  })
  async memorySave(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('memory-save', request)
  }

  @CapabilityDecl({
    tool: 'memory-search',
    title: '搜索记忆',
    description: '按语义搜索长期记忆',
    input: z.object({
      query: z.string().min(1).max(200).describe('关键词（按内容模糊匹配）'),
      limit: z.number().int().min(1).max(50).optional().default(10),
    }),
  })
  async memorySearch(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('memory-search', request)
  }

  @CapabilityDecl({
    tool: 'memory-forget',
    title: '删除记忆',
    description: '删掉一条长期记忆',
    risk: 'write',
    input: z.object({
      id: z.string().min(1).optional().describe('记忆 id'),
      key: z.string().min(1).max(64).optional().describe('稳定标识（与 id 二选一）'),
    }),
  })
  async memoryForget(request: ToolInvokeRequest): Promise<ToolOutcome> {
    return this.run('memory-forget', request)
  }

  /** 公共执行体：鉴权 → 按声明校验入参 → 分派 */
  private async run(tool: string, request: ToolInvokeRequest): Promise<ToolOutcome> {
    const parsed = findCapabilityDecl(this, tool).input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `记忆参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    if (!request.caller.userId) {
      return { ok: false, reason: 'forbidden', message: '没有用户身份，不能操作长期记忆' }
    }
    const args = parsed.data as Record<string, unknown>
    const userId = request.caller.userId
    const agentKey = request.caller.rootAgentKey

    if (tool === 'memory-save') {
      const result = await this.memory.saveFromTool(userId, agentKey, args as { content: string })
      if (!result.ok) {
        return { ok: false, reason: 'invalid-input', message: result.reason, retryable: false }
      }
      return {
        ok: true,
        data: {
          saved: true,
          id: result.memory.id,
          ...(result.memory.memKey ? { key: result.memory.memKey } : {}),
        },
      }
    }

    if (tool === 'memory-search') {
      const rows = await this.memory.searchFromTool(
        userId,
        agentKey,
        String(args.query),
        Number(args.limit ?? 10),
      )
      return {
        ok: true,
        data: {
          total: rows.length,
          items: rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            content: row.content,
            pinned: row.pinned,
            updatedAt: row.updatedAt,
          })),
        },
      }
    }

    const forgotten = await this.memory.forgetFromTool(
      userId,
      agentKey,
      args as { id?: string; key?: string },
    )
    return forgotten
      ? { ok: true, data: { forgotten: true } }
      : { ok: false, reason: 'invalid-input', message: '没找到这条记忆（可能已经删了）' }
  }
}
