import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import { ToolDeniedError } from '../core/tools/tools.types.js'
import type { ToolCallContext } from '../core/tools/tools.types.js'
import {
  MEMORY_FORGET_TOOL,
  MEMORY_SAVE_TOOL,
  MEMORY_SEARCH_TOOL,
} from '../tools/definitions/memory.js'
import { MemoryService } from './memory.service.js'

/** 工具开关（入库、后台可改；其余上限是代码常量，不再加环境变量） */
const MemoryToolConfigSchema = z.object({ enabled: z.boolean().default(true) })

/**
 * **长期记忆工具组**（设计 `docs/design/ai-memory.md` §5.2）。
 *
 * 三个工具都只操作**当前登录用户**的记忆：`userId` 取自运行时信封，接受不了前端传参。
 * 每轮自动注入的那份由运行时完成（见 `MemoryService.collect`），这里只负责"模型主动读写"。
 */
@Injectable()
@ToolGroup({ category: 'core', scope: 'all', child: 'deny' })
export class MemoryTools {
  constructor(@Inject(MemoryService) private readonly memory: MemoryService) {}

  @ToolDecl({
    key: TOOL_KEYS.memorySave,
    title: MEMORY_SAVE_TOOL.title,
    params: MEMORY_SAVE_TOOL.params,
    config: MemoryToolConfigSchema,
    description: MEMORY_SAVE_TOOL.description,
  })
  async save(
    input: z.infer<typeof MEMORY_SAVE_TOOL.params>,
    ctx: ToolCallContext<z.infer<typeof MemoryToolConfigSchema>>,
  ) {
    const caller = ctx.caller
    if (!caller?.userId) {
      throw new ToolDeniedError('forbidden', '没有用户身份，不能写记忆')
    }
    const result = await this.memory.saveFromTool(caller.userId, caller.rootAgentKey, input)
    if (!result.ok) {
      throw new ToolDeniedError('invalid-input', result.reason)
    }
    return {
      saved: true,
      id: result.memory.id,
      ...(result.memory.memKey ? { key: result.memory.memKey } : {}),
    }
  }

  @ToolDecl({
    key: TOOL_KEYS.memorySearch,
    title: MEMORY_SEARCH_TOOL.title,
    params: MEMORY_SEARCH_TOOL.params,
    config: MemoryToolConfigSchema,
    description: MEMORY_SEARCH_TOOL.description,
  })
  async search(
    input: z.infer<typeof MEMORY_SEARCH_TOOL.params>,
    ctx: ToolCallContext<z.infer<typeof MemoryToolConfigSchema>>,
  ) {
    const caller = ctx.caller
    if (!caller?.userId) {
      throw new ToolDeniedError('forbidden', '没有用户身份，不能查记忆')
    }
    const rows = await this.memory.searchFromTool(
      caller.userId,
      caller.rootAgentKey,
      input.query,
      input.limit,
    )
    return {
      total: rows.length,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        content: row.content,
        pinned: row.pinned,
        updatedAt: row.updatedAt,
      })),
    }
  }

  @ToolDecl({
    key: TOOL_KEYS.memoryForget,
    title: MEMORY_FORGET_TOOL.title,
    params: MEMORY_FORGET_TOOL.params,
    config: MemoryToolConfigSchema,
    description: MEMORY_FORGET_TOOL.description,
    precheck: 'checkForget',
  })
  async forget(
    input: z.infer<typeof MEMORY_FORGET_TOOL.params>,
    ctx: ToolCallContext<z.infer<typeof MemoryToolConfigSchema>>,
  ) {
    const caller = ctx.caller
    if (!caller?.userId) {
      throw new ToolDeniedError('forbidden', '没有用户身份，不能删记忆')
    }
    const forgotten = await this.memory.forgetFromTool(caller.userId, caller.rootAgentKey, input)
    if (!forgotten) {
      throw new ToolDeniedError('invalid-input', '没找到这条记忆（可能已经删了）')
    }
    return { forgotten: true }
  }

  /** 只读前置检查：id / key 至少给一个 */
  checkForget(input: z.infer<typeof MEMORY_FORGET_TOOL.params>): string | null {
    return input.id || input.key ? null : '要说明删哪一条：给 id 或 key'
  }
}
