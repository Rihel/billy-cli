import { Injectable } from '@nestjs/common'
import { z } from 'zod'
import { ToolDecl, ToolGroup } from '../engine/tool.decorator.js'
import { TOOL_KEYS } from '../engine/tool-keys.js'
import { ToolDeniedError } from '../engine/tools.types.js'
import { CANCEL_TASK_TOOL, TOOL_SEARCH_PARAMS, WAIT_TASK_TOOL } from './definitions/task.js'

/** 内建任务工具没有配置项（窗口与超时由参数 / 网关决定） */
const TaskConfigSchema = z.object({})

/**
 * **任务工具组**：`wait-task` / `cancel-task`。
 *
 * 它们是**网关内建能力**（不属于任何服务）：正常装配下由 `ToolGateway` 的远程路径直接调网关，
 * 本类只负责把工具声明给模型（参数 / 描述 / 开关），本地执行体只是在"没配网关"时的兜底说明——
 * 没配网关就没有 worker 任务，这两个工具本来也无事可做。
 */
@Injectable()
@ToolGroup({ category: 'core', scope: 'all' })
export class TaskTool {
  @ToolDecl({
    key: TOOL_KEYS.waitTask,
    title: WAIT_TASK_TOOL.title,
    params: WAIT_TASK_TOOL.params,
    config: TaskConfigSchema,
    description: WAIT_TASK_TOOL.description,
  })
  async waitTask(): Promise<never> {
    throw new ToolDeniedError(
      'precheck-failed',
      'wait-task 需要能力网关模式（TOOL_GATEWAY_URL）；长任务只存在于网关 + worker 链路',
    )
  }

  @ToolDecl({
    key: TOOL_KEYS.cancelTask,
    title: CANCEL_TASK_TOOL.title,
    params: CANCEL_TASK_TOOL.params,
    config: TaskConfigSchema,
    description: CANCEL_TASK_TOOL.description,
  })
  async cancelTask(): Promise<never> {
    throw new ToolDeniedError(
      'precheck-failed',
      'cancel-task 需要能力网关模式（TOOL_GATEWAY_URL）；长任务只存在于网关 + worker 链路',
    )
  }

  @ToolDecl({
    key: TOOL_KEYS.toolSearch,
    title: '检索工具',
    params: TOOL_SEARCH_PARAMS,
    config: TaskConfigSchema,
    description:
      '按关键词从能力目录里找工具；不确定该用哪个工具、或工具很多时先搜一下。返回命中的工具 key 与说明，之后直接调用那个工具。',
  })
  async toolSearch(): Promise<never> {
    throw new ToolDeniedError('precheck-failed', 'tool-search 需要能力网关模式（TOOL_GATEWAY_URL）')
  }
}
