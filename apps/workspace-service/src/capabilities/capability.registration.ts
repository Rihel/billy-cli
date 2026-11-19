import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { CapabilityGatewayClient } from '@repo/internal-sdk'
import { CapabilityRegistrar, toRegistration } from '@repo/capability'
import { BashExecutor } from './bash.executor.js'
import { FileExecutor } from './file.executor.js'
import { buildWorkspaceService } from './manifest.js'
import { WorkspaceServiceConfig, type WorkspaceServiceConfigValue } from '../config/app-config.js'

/**
 * workspace-service 向能力网关登记 `workspace` 服务（bash）。
 *
 * 没配网关地址就不登记（本地单跑不受影响）；失败不阻塞启动。
 */
@Injectable()
export class WorkspaceCapabilityRegistration
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private registrar?: CapabilityRegistrar

  constructor(
    @Inject(BashExecutor) private readonly bash: BashExecutor,
    @Inject(FileExecutor) private readonly file: FileExecutor,
    @Inject(WorkspaceServiceConfig) private readonly config: WorkspaceServiceConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.gatewayUrl) {
      this.logger.warn('未配置能力网关地址，跳过能力登记（WORKSPACE_GATEWAY_URL）')
      return
    }
    const client = new CapabilityGatewayClient({
      baseUrl: this.config.gatewayUrl,
      token: this.config.gatewayToken ?? this.config.internalToken,
    })
    this.registrar = new CapabilityRegistrar({
      client,
      registration: toRegistration(buildWorkspaceService([this.bash, this.file]), {
        instance: {
          instanceId: this.config.instanceId,
          endpoint: this.config.endpoint,
          maxConcurrency: 4,
        },
      }),
      heartbeatIntervalMs: 10_000,
      activeProvider: () => 0,
      logger: {
        info: (message, meta) => this.logger.info(message, meta),
        warn: (message, meta) => this.logger.warn(message, meta),
      },
    })
    await this.registrar.start()
  }

  async onApplicationShutdown(): Promise<void> {
    await this.registrar?.stop()
  }
}
