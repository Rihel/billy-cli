import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { CapabilityGatewayClient } from '@repo/internal-sdk'
import { CapabilityRegistrar, toRegistration } from '@repo/capability'
import { buildCommonService } from './capabilities/manifest.js'
import { ToolExecutorRegistry } from './executors/executor.registry.js'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from './config/app-config.js'
import { ActiveTaskCounter } from './active-task.counter.js'

/**
 * 服务侧的能力登记：**一个进程登记一个服务**（`common`，17 个能力），之后只发心跳。
 *
 * - HTTP 全在 `@repo/internal-sdk` 的 `CapabilityGatewayClient`（路径 / 令牌 / 信封 / 超时归它），
 *   本类只做生命周期编排（`CapabilityRegistrar`）；
 * - 没配网关地址就不登记（本地单跑不受影响）；
 * - 上报失败不阻塞启动，注册器内部 5 秒退避重试；
 * - 停机时注销本实例（`kill -9` 靠心跳 30 秒过期自动摘）。
 */
@Injectable()
export class CapabilityRegistration implements OnApplicationBootstrap, OnApplicationShutdown {
  private registrar?: CapabilityRegistrar

  constructor(
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(ActiveTaskCounter) private readonly worker: ActiveTaskCounter,
    @Inject(ToolExecutorRegistry) private readonly executors: ToolExecutorRegistry,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.gatewayUrl) {
      this.logger.warn('未配置能力网关地址，跳过能力登记（CAPABILITY_GATEWAY_URL）')
      return
    }
    const client = new CapabilityGatewayClient({
      baseUrl: this.config.gatewayUrl,
      token: this.config.internalToken,
    })
    const service = buildCommonService(this.executors.instances())
    this.registrar = new CapabilityRegistrar({
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
    await this.registrar.start()
  }

  async onApplicationShutdown(): Promise<void> {
    await this.registrar?.stop()
  }
}
