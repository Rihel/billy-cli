import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { WorkspaceServiceClient } from '@repo/internal-sdk'
import type { WorkspaceServiceSettings } from '../../runtime/workspace/workspace-environment.client.js'
import { engineError } from '../engine-errors.js'
import type { WorkspaceExec, WorkspaceFiles } from '../ports.js'

/**
 * 工作区接缝适配器：文件读写与命令执行都走 workspace-service（容器 / 沙箱执行面）。
 *
 * 不碰宿主 fs：宿主路径只用于平台托管的元数据物化，模型触发的读写必须和执行面同源，
 * 否则「写到容器里却读宿主」这类错位会在部署后才发现。
 */
@Injectable()
export class WorkspaceServiceAdapter implements WorkspaceFiles, WorkspaceExec {
  private readonly client: WorkspaceServiceClient | null

  constructor(@Inject(ConfigService) config: ConfigService) {
    const settings = config.get<WorkspaceServiceSettings>('workspaceService')
    this.client = settings?.url?.trim()
      ? new WorkspaceServiceClient({
          baseUrl: settings.url,
          token: settings.token,
          ...(settings.timeoutMs ? { timeoutMs: settings.timeoutMs } : {}),
        })
      : null
  }

  async read(workspaceId: string, path: string): Promise<string> {
    const result = await this.require().fs({ workspaceId, op: 'read', path })
    if (!result.ok) throw new Error(result.message ?? result.reason ?? '工作区读取失败')
    return typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '')
  }

  async write(workspaceId: string, path: string, content: string): Promise<void> {
    const result = await this.require().fs({ workspaceId, op: 'write', path, content })
    if (!result.ok) throw new Error(result.message ?? result.reason ?? '工作区写入失败')
  }

  async list(workspaceId: string, path = '.'): Promise<string[]> {
    const result = await this.require().fs({ workspaceId, op: 'list', path })
    if (!result.ok) throw new Error(result.message ?? result.reason ?? '工作区列目录失败')
    if (!Array.isArray(result.data)) return []
    return result.data.map((item) => String(item))
  }

  async run(
    workspaceId: string,
    input: { command: string; cwd?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.require().exec({
      workspaceId,
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    })
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }
  }

  private require(): WorkspaceServiceClient {
    if (!this.client) {
      throw engineError('engine_internal', 'workspace-service 未配置（缺少 WORKSPACE_SERVICE_URL）')
    }
    return this.client
  }
}
