import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AppLogger } from '@repo/kits'
import { WorkspaceServiceClient } from '@repo/internal-sdk'
import type { WorkspaceEnvironment, WorkspaceFeatures } from '@repo/contracts'
import type { EnvironmentWorkspace } from '../core/prompts/environment.js'

/** 运行时对 workspace-service 的配置（`WORKSPACE_SERVICE_URL` / `WORKSPACE_INTERNAL_TOKEN`） */
export interface WorkspaceServiceSettings {
  url: string
  token: string
  timeoutMs?: number
}

const sandboxText = (features: WorkspaceFeatures): string => {
  if (features.sandbox === 'os') return '系统沙箱：只能写工作区与缓存'
  if (features.sandbox === 'restricted-user') return '受限用户：靠账号权限兜底'
  return '无隔离：以服务进程身份执行'
}

const networkText = (features: WorkspaceFeatures): string => {
  if (features.network === 'deny') return '默认断网'
  if (features.network === 'allow') return '可出网'
  return '按部署配置'
}

const resourceText = (features: WorkspaceFeatures): string =>
  features.resourceLimits ? '有（按部署配置）' : '无'

const persistenceText = (features: WorkspaceFeatures): string =>
  features.persistence === 'durable' ? '停止后保留' : '停止后清空'

/**
 * 会话开局那段「运行环境」里的**工作区信息**（`docs/design/workspace-env-contract.md` D7）。
 *
 * 数据由 workspace-service 算出（它才知道部署侧沙箱 / 容器配置）；这里只做「查询 + 转文案」，
 * 查不到（服务未配 / 不可达 / 工作区没绑）就返回 null，提示词里整段省略 ——
 * 环境信息是锦上添花，不能因为它把一轮问答打死。
 */
@Injectable()
export class WorkspaceEnvironmentClient {
  private readonly client: WorkspaceServiceClient

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    const settings = config.get<WorkspaceServiceSettings>('workspaceService')
    this.client = new WorkspaceServiceClient({
      baseUrl: settings?.url ?? '',
      token: settings?.token ?? '',
      timeoutMs: settings?.timeoutMs ?? 3_000,
    })
    this.configured = Boolean(settings?.url?.trim())
  }

  private readonly configured: boolean

  /** 查一个工作区的执行环境；失败返回 null（不抛） */
  async of(workspaceId: string | null | undefined): Promise<EnvironmentWorkspace | null> {
    if (!workspaceId || !this.configured) return null
    try {
      return toPromptData(await this.client.environment(workspaceId))
    } catch (error) {
      this.logger.warn('ai.environment.workspace_lookup_failed', {
        workspaceId,
        reason: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }
}

/** 声明 → 提示词文案（纯函数，测试直接断它） */
export const toPromptData = (env: WorkspaceEnvironment): EnvironmentWorkspace => ({
  root: env.root,
  shell: env.features.shell,
  sandbox: sandboxText(env.features),
  network: networkText(env.features),
  resourceLimits: resourceText(env.features),
  persistence: persistenceText(env.features),
  fileAccess: env.fileAccess,
})
