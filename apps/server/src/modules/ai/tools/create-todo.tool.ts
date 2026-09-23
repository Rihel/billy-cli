import { Inject, Injectable } from '@nestjs/common'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TodoService } from '../../todo/todo.service.js'
import { TOOL_KEYS } from './tool-keys.js'
import type { AgentTool, AgentToolInstance } from './tools.types.js'

const CreateTodoInputSchema = z.object({
  title: z.string().min(1).max(200).describe('待办标题，简明的一句话'),
  description: z.string().max(2000).optional().describe('补充说明，可为空'),
})

/**
 * 新增待办（**写操作**）。
 *
 * 只授权给需要写的 agent（见 `agents/*.agent.ts` 的 tools）：只读 agent 拿不到它，
 * 也就无法误写数据 —— 能力边界靠工具可见性，而不是靠提示词请求模型自律。
 */
@Injectable()
export class CreateTodoTool implements AgentTool {
  readonly key = TOOL_KEYS.createTodo
  readonly title = '新增待办'
  readonly description =
    '新增一条待办事项。仅在用户明确要求记录待办时使用（如"记一条待办""帮我加个任务"）。'
  readonly tool: AgentToolInstance

  constructor(@Inject(TodoService) private readonly todoService: TodoService) {
    this.tool = createTool({
      // 我们的工具 key 映射到 Mastra 的 createTool.id（它的接口字段名，值相同）
      id: this.key,
      description: this.description,
      inputSchema: CreateTodoInputSchema,
      execute: async (input) => {
        // 不裁剪：返回创建后的完整实体，出参原样进时间线落库
        return this.todoService.create({
          title: input.title,
          description: input.description,
        })
      },
    })
  }
}
