import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  credentialTemplateOf,
  pickJsonPath,
  resolveImportField,
  type CredentialCandidate,
} from '@repo/shared'
import type { CredentialImportResponse } from '@repo/contracts'
import { WorkspaceRuntime } from '../workspace-runtime.service.js'
import { WorkspaceRepository } from '../workspace.repository.js'
import { createExecShell, type SetupShell } from '../setup/shell.js'
import { adapterOf, CLI_ADAPTERS, type CliAdapter } from './cli-adapters.js'
import { importCredentialToMain, type CredentialMainTarget } from './main.client.js'
import {
  WorkspaceServiceConfig,
  type WorkspaceServiceConfigValue,
} from '../../config/app-config.js'

/**
 * 从工作区导入凭据（`docs/design/workspace-cli-credentials.md` §6.4.5）。
 *
 * 分工：**执行面读取、控制面入库**。
 * - 读取必须在这里（文件 / 命令都在容器内）；
 * - 加密与归属校验在 main（密钥与凭据库都在控制面）。
 *
 * 模型只传 `provider`：路径与命令由适配器掌握，模型不接触文件位置（D9）。
 * 值只在内存里从读取跳到内部接口，不回显、不落日志。
 */
@Injectable()
export class WorkspaceCredentialImportService {
  constructor(
    @Inject(WorkspaceRuntime) private readonly runtime: WorkspaceRuntime,
    @Inject(WorkspaceRepository) private readonly repo: WorkspaceRepository,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 候选：适配器能从容器里读到值的 provider（缺失的不出现） */
  async candidates(workspaceId: string): Promise<CredentialCandidate[]> {
    const shell = this.shellOf(workspaceId)
    const found: CredentialCandidate[] = []
    for (const adapter of CLI_ADAPTERS) {
      if (!adapter.importFrom) continue
      const readable = await this.probe(shell, adapter)
      if (!readable) continue
      found.push({
        provider: adapter.key,
        displayName: credentialTemplateOf(adapter.template)?.label ?? adapter.key,
        longTerm: adapter.longTerm,
        expiresAt: null,
      })
    }
    return found
  }

  /** 导入：读 → 解析 → 调 main 加密入库 → 返回摘要（不含值） */
  async import(
    workspaceId: string,
    provider: string,
  ): Promise<CredentialImportResponse['credential']> {
    const adapter = adapterOf(provider)
    if (!adapter?.importFrom) throw new Error(`该服务不支持从工作区导入：${provider}`)
    const template = credentialTemplateOf(adapter.template)
    if (!template) throw new Error(`模板不存在：${adapter.template}`)

    const shell = this.shellOf(workspaceId)
    const value = await this.read(shell, adapter)
    if (!value) throw new Error(`未从工作区读到 ${provider} 的凭据（可能尚未登录）`)
    const field = resolveImportField(template, adapter.importFrom.field)
    const context = await this.repo.findSetupContext(workspaceId)
    if (!context) throw new Error(`工作区不存在：${workspaceId}`)

    const credential = await importCredentialToMain(this.mainTarget(), {
      ownerType: context.ownerType,
      ownerId: context.ownerId,
      provider: adapter.key,
      template: adapter.template,
      name: adapter.key,
      values: { [field]: value },
    })
    // 导入后用适配器的 status 做一次无副作用校验（没有 status 的适配器跳过）
    let verified: boolean | undefined
    if (adapter.status) {
      const check = await shell.exec(adapter.status, { timeoutMs: 20_000 }).catch(() => null)
      verified = check?.ok === true
      if (!verified) {
        this.logger.warn('credential.import_unverified', { workspaceId, provider })
      }
    }
    this.logger.log('credential.imported', { workspaceId, provider, field, verified })
    return verified === undefined ? credential : { ...credential, verified }
  }

  // ── 读取与解析 ────────────────────────────────────────────

  private shellOf(workspaceId: string): SetupShell {
    return createExecShell(async (command, opts) => {
      const result = await this.runtime.exec(workspaceId, {
        workspaceId,
        command,
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      })
      return { ok: result.ok, code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    })
  }

  private async probe(shell: SetupShell, adapter: CliAdapter): Promise<boolean> {
    const source = adapter.importFrom!
    try {
      if (source.kind === 'file' && source.path) return (await shell.read(source.path)) !== null
      if (source.kind === 'command' && source.command) {
        const result = await shell.exec(source.command, { timeoutMs: 15_000 })
        return result.ok && result.stdout.trim().length > 0
      }
      return false
    } catch {
      return false
    }
  }

  private async read(shell: SetupShell, adapter: CliAdapter): Promise<string | null> {
    const source = adapter.importFrom!
    let raw: string | null = null
    if (source.kind === 'file' && source.path) raw = await shell.read(source.path)
    if (source.kind === 'command' && source.command) {
      const result = await shell.exec(source.command, { timeoutMs: 15_000 })
      if (!result.ok) return null
      raw = result.stdout
    }
    if (!raw || raw.trim().length === 0) return null

    if (source.extract === 'json' || source.jsonPath) {
      try {
        const parsed = JSON.parse(raw) as unknown
        const picked = pickJsonPath(parsed, source.jsonPath)
        return typeof picked === 'string' && picked.trim() ? picked.trim() : null
      } catch {
        return null
      }
    }
    // 默认按行取第一个非空行（`gh auth token` 这类命令）
    const line = raw
      .split('\n')
      .map((item) => item.trim())
      .find(Boolean)
    return line ?? null
  }

  /** 调 main 内部接口的目标（地址 + 令牌，令牌缺省回落本服务内部令牌） */
  private mainTarget(): CredentialMainTarget {
    return {
      mainUrl: this.config.mainUrl,
      token: this.config.mainToken ?? this.config.internalToken,
    }
  }
}
