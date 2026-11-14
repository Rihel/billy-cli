import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'
import { ToolConfigService } from '../config/tool.config.service.js'
import { ToolGatewayController } from './gateway.controller.js'
import { ToolGatewayService } from './gateway.service.js'
import { InternalTokenGuard } from '../http/internal-token.guard.js'
import { ToolCallInterceptor } from '../policy/tool-call.interceptor.js'
import { ToolAuditService } from '../audit/tool.audit.js'
import { ToolCatalogService } from '../catalog/tool.catalog.js'
import { ToolPolicyService } from '../policy/tool.policy.js'
import { WorkerDirectory } from '../workers/worker.directory.js'

@Module({
  imports: [ConfigModule],
  controllers: [ToolGatewayController],
  providers: [
    {
      provide: ToolGatewayConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ToolGatewayConfigValue =>
        config.getOrThrow<ToolGatewayConfigValue>('gateway'),
    },
    ToolGatewayService,
    ToolCatalogService,
    ToolPolicyService,
    ToolConfigService,
    ToolAuditService,
    InternalTokenGuard,
    ToolCallInterceptor,
    WorkerDirectory,
  ],
})
export class ToolGatewayModule {}
