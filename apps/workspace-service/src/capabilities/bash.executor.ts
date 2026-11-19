import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { WorkspaceRuntime } from '../workspace/workspace-runtime.service.js'
import { WorkspaceLocator } from './workspace.locator.js'

interface BashInput {
  command: string
  cwd?: string
}

/**
 * `bash` 能力（执行位置 = 工作区）。
 *
 * v1 先按 **sync** 形态登记：网关直接等结果（长命令受网关 timeout 限制）。
 * task 形态（yield / `/tasks/get|cancel`）留在下一步迁移。
 */
@Injectable()
@CapabilityGroup({ risk: 'write' })
export class BashExecutor {
  constructor(
    @Inject(WorkspaceRuntime) private readonly runtime: WorkspaceRuntime,
    @Inject(WorkspaceLocator) private readonly locator: WorkspaceLocator,
  ) {}

  @CapabilityDecl({
    tool: 'bash',
    title: '执行 bash 命令',
    description: [
      '在工作区里执行一条命令行命令，拿到退出码、stdout 与 stderr。',
      '',
      '什么时候用：答案只能靠真实执行得到（跑脚本 / 测试、计算、取当前时间）。',
      '',
      '什么时候不用：能直接回答的、要用户拍板的、需要持续输入的。',
      '',
      '不要读平台源码、配置、密钥、环境变量或数据库：不属于用户任务。',
      '',
      '执行环境：命令在会话绑定的工作区里跑（容器或本地沙箱），只能访问工作区目录；',
      '实际以出参 runtime 为准。',
      '',
      '约束：命令要幂等；输出用管道 head / grep 收窄。',
    ].join('\n'),
    input: z.object({
      command: z.string().min(1).max(2_000).describe('要执行的整条命令行'),
      cwd: z.string().min(1).max(512).optional().describe('工作目录（相对工作区根）'),
    }),
    timeoutMs: 300_000,
    execution: {
      mode: 'task',
      where: 'workspace',
      owner: 'session',
      yieldMs: 45_000,
      cancel: 'supported',
      maxRunMs: 1_800_000,
    },
  })
  async bash(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const parsed = findCapabilityDecl(this, 'bash').input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `命令参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const input = parsed.data as BashInput
    const workspaceId =
      request.workspaceId ?? (await this.locator.workspaceIdOf(request.caller.conversationId))
    if (!workspaceId) {
      return {
        ok: false,
        reason: 'no-workspace',
        message: '会话还没有绑定工作区',
        retryable: false,
      }
    }
    const result = await this.runtime.exec(workspaceId, {
      workspaceId,
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      timeoutMs: Math.min(300_000, request.deadlineMs),
    })
    return { ok: true, data: result }
  }
}
