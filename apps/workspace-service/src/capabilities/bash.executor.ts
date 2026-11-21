import dedent from 'dedent'
import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { WorkspaceRuntime } from '../workspace/workspace-runtime.service.js'
import { gateMessageOf } from '../workspace/credential-gate.js'
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
    description: dedent`
      在工作区里执行一条命令行命令，拿到退出码、stdout 与 stderr。

      什么时候用：答案只能靠真实执行得到（跑脚本 / 测试、计算、取当前时间）。

      什么时候不用：能直接回答的、要用户拍板的、需要持续输入的。

      不要读平台源码、配置、密钥、环境变量或数据库：不属于用户任务。

      执行环境：命令在会话绑定的工作区里跑（容器或本地沙箱），只能访问工作区目录；
      实际以出参 runtime 为准。

      约束：命令要幂等；输出用管道 head / grep 收窄。
    `,
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
    // 执行前检查（§6.4.4）：命中某 provider 但本地清单缺凭据 → 直接拒绝，不执行
    const gate = await this.runtime.authorizeCommand(workspaceId, input.command)
    if (gate) {
      // 暂态拒绝（凭据正在补偿）必须标 retryable 并引导重试：
      // 模型看到 retryable=false 会判断"这条路走不通"，转而下错误结论（issue 9）
      return {
        ok: false,
        reason: 'missing-credential',
        message: gate.transient
          ? `${gateMessageOf(gate.denial)}（凭据正在自动重试，几秒后重试本条命令即可）`
          : gateMessageOf(gate.denial),
        retryable: gate.transient,
        ...(gate.transient
          ? {
              hint: '这是暂态失败：平台正在自动补偿凭据，稍后重试同一条命令，不要改走别的路径',
            }
          : {}),
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
