import { Inject, Injectable } from '@nestjs/common'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TodoService } from '../../todo/todo.service.js'
import { TOOL_KEYS } from './tool-keys.js'
import type { AgentTool, AgentToolInstance } from './tools.types.js'

const GetTodoInputSchema = z.object({
  todoId: z.string().min(1).describe('待办 id；先用 list-todos 查到'),
})

/** 按 id 查询单条待办详情（只读） */
@Injectable()
export class GetTodoTool implements AgentTool {
  readonly key = TOOL_KEYS.getTodo
  readonly title = '查询待办详情'
  readonly description =
    '按 id 查询单条待办的完整信息。用户追问某条待办的细节、或用 id 指明某条待办时使用。'
  readonly tool: AgentToolInstance

  constructor(@Inject(TodoService) private readonly todoService: TodoService) {
    this.tool = createTool({
      // 我们的工具 key 映射到 Mastra 的 createTool.id（它的接口字段名，值相同）
      id: this.key,
      description: this.description,
      inputSchema: GetTodoInputSchema,
      execute: async (input) => {
        // 不裁剪：返回完整实体（含时间戳等），出参原样进时间线落库
        return this.todoService.get({ todoId: input.todoId })
      },
    })
  }
}
