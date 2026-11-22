import dedent from 'dedent'
import { Inject, Injectable } from '@nestjs/common'
import { z } from 'zod'
import { CapabilityDecl, CapabilityGroup, findCapabilityDecl } from '@repo/capability'
import type { ToolInvokeRequest, ToolOutcome } from '@repo/contracts'
import { WorkspaceCredentialSaveService } from '../workspace/credential/save.service.js'
import { WorkspaceLocator } from './workspace.locator.js'

/**
 * `credential-save`：把**用户主动给出**的凭据值加密入库。
 *
 * 与 `credential-import` 互补：
 * - import 读容器里已有的登录态（值不经过模型，D9 口径）；
 * - save 收用户在会话里明确贴出的值（模型是通道，但值只往内部接口送，不回显）。
 */
@Injectable()
@CapabilityGroup({ risk: 'write' })
export class CredentialSaveExecutor {
  constructor(
    @Inject(WorkspaceLocator) private readonly locator: WorkspaceLocator,
    @Inject(WorkspaceCredentialSaveService)
    private readonly service: WorkspaceCredentialSaveService,
  ) {}

  @CapabilityDecl({
    tool: 'credential-save',
    title: '保存用户提供的凭据',
    description: dedent`
      把**用户在对话里明确给出**的凭据值加密保存到该用户名下；保存后会推送到运行中的工作区，
      下次初始化也会自动落地。

      什么时候用：用户主动贴出或报出凭据值（例如飞书自建应用的 App ID + App Secret），
      并要求平台存下来复用。

      怎么用：
      - \`provider\` 填服务标识（如 \`lark\`），\`template\` 填模板 key（同 provider 多模板时必须给，
        如飞书自建应用是 \`lark-app\`）；
      - \`values\` 的键名**必须与模板字段 key 完全一致**（lark-app 是 \`appId\` / \`appSecret\`）；
        键名写错会被控制面拒收，错误信息会带上是哪个键。

      什么时候不用：
      - 容器里已经有登录态 → 用 credential-import（值不经过模型）；
      - 用户没给具体值、只是说要「配好环境」→ 先问清要哪套凭据，不要臆造字段值或键名；
      - 本能力**不是使用凭据的必经路**：凭据已落地时直接执行业务命令即可。

      安全：值只用于加密入库，不回显、不落日志；不要把值再写进消息正文或工作区文件。
    `,
    input: z.object({
      provider: z.string().min(1).max(32).describe('服务标识（如 lark / github）'),
      template: z
        .string()
        .min(1)
        .max(32)
        .optional()
        .describe('模板 key（同 provider 多模板时必须给，如 lark-app）'),
      name: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .optional()
        .describe('凭据名（缺省用 provider；同一服务多账号时用它区分）'),
      values: z
        .record(z.string(), z.unknown())
        .describe('模板字段值（键名必须与模板字段 key 一致，如 appId / appSecret）'),
    }),
    timeoutMs: 60_000,
    execution: { mode: 'sync', where: 'workspace' },
  })
  async save(request: ToolInvokeRequest): Promise<ToolOutcome> {
    const parsed = findCapabilityDecl(this, 'credential-save').input.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: `参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
        retryable: false,
      }
    }
    const workspaceId = await this.locator.forRequest(request)
    if (!workspaceId) {
      return {
        ok: false,
        reason: 'no-workspace',
        message: '会话还没有绑定工作区',
        retryable: false,
      }
    }
    const input = parsed.data as {
      provider: string
      template?: string
      name?: string
      values: Record<string, unknown>
    }
    try {
      const credential = await this.service.save(workspaceId, {
        provider: input.provider,
        ...(input.template ? { template: input.template } : {}),
        ...(input.name ? { name: input.name } : {}),
        values: input.values,
      })
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
