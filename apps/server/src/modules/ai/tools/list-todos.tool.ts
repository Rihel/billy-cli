import { Inject, Injectable } from '@nestjs/common'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TodoService } from '../../todo/todo.service.js'
import { TOOL_KEYS } from './tool-keys.js'
import type { AgentTool, AgentToolInstance } from './tools.types.js'

/**
 * 工具入参契约（**给模型看的契约**）：字段说明走 `.describe()` ——
 * Mastra 会把 schema 转成 JSON Schema 交给模型，说明就是模型能看到的全部信息。
 */
const ListTodosInputSchema = z.object({
  keyword: z.string().optional().describe('标题关键词（模糊匹配）；不传则返回最近的待办'),
  limit: z.number().int().min(1).max(20).default(5).describe('返回条数，1~20；默认 5'),
})

/**
 * 查询待办列表（只读）。
 *
 * 只做参数翻译，业务规则一律走 `TodoService`（于是校验、日志、事务、软删规则与普通接口完全一致）。
 *
 * **返回完整业务结果，不裁剪字段**：工具出参会原样进时间线落库（审计 / 回放 / 前端展示都要保真）。
 */
@Injectable()
export class ListTodosTool implements AgentTool {
  readonly key = TOOL_KEYS.listTodos
  readonly title = '查询待办列表'
  readonly description =
    '查询待办列表，可按标题关键词过滤。用户询问"有哪些待办""待办清单"时使用。'
  readonly tool: AgentToolInstance

  constructor(@Inject(TodoService) private readonly todoService: TodoService) {
    this.tool = createTool({
      // 我们的工具 key 映射到 Mastra 的 createTool.id（它的接口字段名，值相同）
      id: this.key,
      description: this.description,
      inputSchema: ListTodosInputSchema,
      execute: async (input) => {
        const result = await this.todoService.page({
          page: 1,
          size: input.limit,
          keyword: input.keyword,
          orderBy: 'updatedAt',
          order: 'desc',
        })
        // 不裁剪：交回业务服务的完整结果（字段与列表接口一致，前端与审计看到的是同一份数据）
        return result
      },
    })
  }
}
