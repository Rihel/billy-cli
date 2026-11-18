import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { CapabilityRegistrar, CapabilityRegistryClient, toRegistration } from '@repo/capability'
import { SERVICE_DEFINITIONS } from './capabilities/manifest.js'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from './config/app-config.js'
import { ActiveTaskCounter } from './active-task.counter.js'

/**
 * 服务侧的能力登记：启动上报两个服务身份（`exec` / `web`），之后只发心跳。
 *
 * - 没配网关地址就不登记（本地单跑不受影响）；
 * - 上报失败不阻塞启动，注册器内部 5 秒退避重试；
 * - 停机时注销本实例（`kill -9` 靠心跳 30 秒过期自动摘）。
 */
@Injectable()
export class CapabilityRegistration implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly registrars: CapabilityRegistrar[] = []

  constructor(
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(ActiveTaskCounter) private readonly worker: ActiveTaskCounter,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.gatewayUrl) {
      this.logger.warn('未配置能力网关地址，跳过能力登记（CAPABILITY_GATEWAY_URL）')
      return
    }
    const client = new CapabilityRegistryClient({
      baseUrl: this.config.gatewayUrl,
      token: this.config.internalToken,
    })
    for (const service of SERVICE_DEFINITIONS) {
      const registrar = new CapabilityRegistrar({
        client,
        registration: toRegistration(service, {
          instance: {
            instanceId: this.config.id,
            endpoint: this.config.endpoint,
            maxConcurrency: this.config.maxConcurrency,
          },
        }),
        heartbeatIntervalMs: this.config.heartbeatIntervalMs,
        activeProvider: () => this.worker.activeCount,
        logger: {
          info: (message, meta) => this.logger.info(message, meta),
          warn: (message, meta) => this.logger.warn(message, meta),
        },
      })
      await registrar.start()
      this.registrars.push(registrar)
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.registrars.splice(0).map((registrar) => registrar.stop()))
  }
}
