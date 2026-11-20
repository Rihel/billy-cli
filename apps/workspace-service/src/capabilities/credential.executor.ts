import dedent from 'dedent'
import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { WorkspaceRuntime } from '../workspace/workspace-runtime.service.js'
import { WorkspaceCredentialImportService } from '../workspace/credential-import.service.js'
import { WorkspaceLocator } from './workspace.locator.js'

/**
 * 凭据导入能力（`docs/design/workspace-cli-credentials.md` §6.4.5 / §6.8）。
 *
 * 两个工具都在**工作区**里执行（要读容器内的凭据文件 / 命令），
 * 入库由 main 完成（加密密钥与凭据库都在控制面）。
 */

async function workspaceOf(
  runtime: WorkspaceRuntime,
  locator: WorkspaceLocator,
  request: ToolInvokeRequest,
): Promise<string | null> {
  void runtime
  return request.workspaceId ?? (await locator.workspaceIdOf(request.caller.conversationId))
}

@Injectable()
@CapabilityGroup({ risk: 'read' })
export class CredentialCandidatesExecutor {
  constructor(
    @Inject(WorkspaceRuntime) private readonly runtime: WorkspaceRuntime,
    @Inject(WorkspaceLocator) private readonly locator: WorkspaceLocator,
    @Inject(WorkspaceCredentialImportService)
    private readonly service: WorkspaceCredentialImportService,
  ) {}

  @CapabilityDecl({
    tool: 'credential-candidates',
    title: '检测可保存的凭据',
    description: dedent`
      列出本次工作区里"读过就用、还能保存下来复用"的服务凭据候选。

      什么时候用：任务收尾时，用户可能希望把本次临时登录保留下来（下次重建工作区不用再登录）。

      返回字段：provider / displayName / longTerm / expiresAt。
      longTerm=false 表示只拿到短命 access token（约两小时），提问时要明示有效期短，并引导走授权。

      候选为空时不要追问用户。
    `,
    input: z.object({}),
    timeoutMs: 60_000,
    execution: { mode: 'sync', where: 'workspace' },
  })
  async candidates(request: ToolInvokeRequest): Promise<ToolOutcome> {
    findCapabilityDecl(this, 'credential-candidates').input.parse(request.input)
    const workspaceId = await workspaceOf(this.runtime, this.locator, request)
    if (!workspaceId) {
      return {
        ok: false,
        reason: 'no-workspace',
        message: '会话还没有绑定工作区',
        retryable: false,
      }
    }
    const items = await this.service.candidates(workspaceId)
    return { ok: true, data: { items } }
  }
}

@Injectable()
@CapabilityGroup({ risk: 'write' })
export class CredentialImportExecutor {
  constructor(
    @Inject(WorkspaceRuntime) private readonly runtime: WorkspaceRuntime,
    @Inject(WorkspaceLocator) private readonly locator: WorkspaceLocator,
    @Inject(WorkspaceCredentialImportService)
    private readonly service: WorkspaceCredentialImportService,
  ) {}

  @CapabilityDecl({
    tool: 'credential-import',
    title: '保存工作区里的凭据',
    description: dedent`
      把工作区里已有的登录态保存到该用户名下（加密入库，值不回显），下次重建工作区自动落地。

      什么时候用：用户确认"保存以便复用"之后。**只传 provider**，不要传文件路径或凭据值 ——
      路径由平台掌握，模型不需要也不应该接触。

      保存后会同步到该用户全部运行中的工作区；同名凭据已存在会报错，需要用户确认后再覆盖。
    `,
    input: z.object({
      provider: z.string().min(1).max(32).describe('服务标识（来自 credential-candidates）'),
    }),
    timeoutMs: 120_000,
    execution: { mode: 'sync', where: 'workspace' },
  })
  async importFromWorkspace(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const parsed = findCapabilityDecl(this, 'credential-import').input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const workspaceId = await workspaceOf(this.runtime, this.locator, request)
    if (!workspaceId) {
      return {
        ok: false,
        reason: 'no-workspace',
        message: '会话还没有绑定工作区',
        retryable: false,
      }
    }
    try {
      const input = parsed.data as { provider: string }
      const credential = await this.service.import(workspaceId, input.provider)
      return { ok: true, data: { credential } }
    } catch (error) {
      return {
        ok: false,
        reason: 'import-failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      }
    }
  }
}
