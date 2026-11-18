import { Inject, Injectable } from '@nestjs/common'
import { MemoryRepository, MemoryService } from '@repo/ai-data'
import { MEMORY_SCHEMAS, MEMORY_TOOL_KEYS } from '../../capabilities/schemas.js'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'

export { MEMORY_TOOL_KEYS }

/**
 * memory-* 执行器：worker **直连 PG**（受限 DB 账号），不再回调 server。
 *
 * 与 server 共用 `@repo/ai-data` 的 MemoryService / MemoryRepository，业务规则只有一份；
 * 数据流单向：gateway → worker → PG，worker 不反向调用编排层。
 */
@Injectable()
export class MemoryExecutor {
  readonly keys = MEMORY_TOOL_KEYS

  constructor(
    @Inject(MemoryService) private readonly memory: MemoryService,
    @Inject(MemoryRepository) private readonly _repository: MemoryRepository,
  ) {}

  async execute(toolKey: string, request: ToolInvokeRequest): Promise<ToolOutcome> {
    const schema = MEMORY_SCHEMAS[toolKey]
    if (!schema) {
      return { ok: false, reason: 'unknown-tool', message: `未知工具：${toolKey}` }
    }
    const parsed = schema.safeParse(request.input)
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

    if (toolKey === 'memory-save') {
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

    if (toolKey === 'memory-search') {
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
