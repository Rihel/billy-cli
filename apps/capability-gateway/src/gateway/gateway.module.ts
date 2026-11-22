import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'
import { ToolConfigService } from '../config/tool.config.service.js'
import { ToolAuditService } from '../audit/tool.audit.js'
import { ToolEffectLedger } from '../effects/tool-effect.ledger.js'
import { InternalTokenGuard } from '../http/internal-token.guard.js'
import { GatewayHealthController } from './gateway.controller.js'
import { CapabilityRegistryController } from '../registry/capability-registry.controller.js'
import { CapabilityPolicyService } from '../registry/capability.policy.js'
import { CapabilityProbeService } from '../registry/capability.probe.js'
import { ServiceInvoker } from '../registry/service.invoker.js'
import { ServiceRegistry } from '../registry/service.registry.js'

/**
 * 能力网关的装配点：**登记 + 治理 + 路由 + 审计**，不执行任何能力。
 */
@Module({
  imports: [ConfigModule],
  controllers: [GatewayHealthController, CapabilityRegistryController],
  providers: [
    {
      provide: ToolGatewayConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ToolGatewayConfigValue =>
        config.getOrThrow<ToolGatewayConfigValue>('gateway'),
    },
    ToolConfigService,
    ToolAuditService,
    ToolEffectLedger,
    InternalTokenGuard,
    ServiceRegistry,
    ServiceInvoker,
    CapabilityPolicyService,
    CapabilityProbeService,
  ],
})
export class ToolGatewayModule {}
