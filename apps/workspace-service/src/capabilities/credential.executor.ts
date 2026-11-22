import dedent from 'dedent'
import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { WorkspaceCredentialImportService } from '../workspace/credential/import.service.js'
import { WorkspaceLocator } from './workspace.locator.js'

/** 没有绑定工作区时的统一拒绝（两个凭据能力共用） */
const NO_WORKSPACE: ToolOutcome = {
  ok: false,
  reason: 'no-workspace',
  message: '会话还没有绑定工作区',
  retryable: false,
}

@Injectable()
@CapabilityGroup({ risk: 'read' })
export class CredentialCandidatesExecutor {
  constructor(
    @Inject(WorkspaceLocator) private readonly locator: WorkspaceLocator,
    @Inject(WorkspaceCredentialImportService)
    private readonly service: WorkspaceCredentialImportService,
  ) {}

  @CapabilityDecl({
    tool: 'credential-candidates',
    title: '检测可保存的凭据',
    description: dedent`
      列出"容器里已经登录、并且平台能读出来保存"的服务凭据候选。

      方向语义（很重要）：这是**宿主 → 凭据库**的导入通道，不是注入检查。
      它**不包含**平台已经注入到工作区里的凭据（「.billy/credentials.json」里的清单与注入文件都在，
      但不会出现在这里）。所以：

      - 返回空列表 **不等于**「平台没实现注入」/「凭据没进容器」；
      - 想确认注入是否生效，读工作区里的「.billy/credentials.json」（只有 provider / name / 到期时间，
        没有秘钥值）或用业务命令试一次；不要拿本能力的空结果当注入结论。

      什么时候用：任务收尾时，用户可能希望把本次临时登录保留下来（下次重建工作区不用再登录）。
      只有**有明文导出通道**的 CLI 才会出现（如 gh）；lark 的值加密存在 CLI 自己的库里、没有明文导出，
      因此永远不在这里 —— 那种情况用 credential-save 保存用户主动给的值。

      返回字段：provider / displayName / longTerm / expiresAt。
      longTerm=false 表示只拿到短命 access token（约两小时），提问时要明示有效期短，并引导走授权。

      候选为空时不要追问用户，也不要因此推断平台坏了。
    `,
    input: z.object({}),
    timeoutMs: 60_000,
    execution: { mode: 'sync', where: 'workspace' },
  })
  async candidates(request: ToolInvokeRequest): Promise<ToolOutcome> {
    findCapabilityDecl(this, 'credential-candidates').input.parse(request.input)
    const workspaceId = await this.locator.forRequest(request)
    if (!workspaceId) return NO_WORKSPACE
    const items = await this.service.candidates(workspaceId)
    return { ok: true, data: { items } }
  }
}

@Injectable()
@CapabilityGroup({ risk: 'write' })
export class CredentialImportExecutor {
  constructor(
    @Inject(WorkspaceLocator) private readonly locator: WorkspaceLocator,
    @Inject(WorkspaceCredentialImportService)
    private readonly service: WorkspaceCredentialImportService,
  ) {}

  @CapabilityDecl({
    tool: 'credential-import',
    title: '保存工作区里的凭据',
    description: dedent`
      把工作区里**已有**的登录态保存到该用户名下（加密入库，值不回显），下次重建工作区自动落地。

      什么时候用：用户确认"保存以便复用"之后，且 credential-candidates 里**出现过该 provider**。

      什么时候不用：
      - 只支持有明文导出通道的 provider（如 gh）。lark / mysql / redis 等没有导出通道的，
        调用会报 unsupported —— 这**不是**平台缺陷，也不代表"平台只实现了存、没实现注入"；
        lark 的自建应用密钥用 credential-save 保存用户给的值，之后走绑定 → 推送 → 同步自动注入。
      - 本能力**不是使用凭据的必经路**：凭据已经注入、业务命令能跑时，不需要再调它。

      用法：**只传 provider**，不要传文件路径或凭据值 —— 路径由平台掌握，模型不需要也不应该接触。

      保存后会同步到该用户全部运行中的工作区；同名凭据已存在会报错，需要用户确认后再覆盖。
    `,
    input: z.object({
      provider: z
        .string()
        .min(1)
        .max(32)
        .describe('服务标识（只能是 credential-candidates 返回过的）'),
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
    const workspaceId = await this.locator.forRequest(request)
    if (!workspaceId) return NO_WORKSPACE
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
