import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { WorkspaceServiceClient } from '@repo/internal-sdk'
import { AdminModule } from '../../admin/admin.module.js'
import { CREDENTIAL_SYNC_PORT, CredentialSyncService } from './credential-sync.service.js'
import { CREDENTIAL_CONFIG, createCredentialConfig } from './credential.config.js'
import { CredentialAuditRepository } from './credential-audit.repository.js'
import { CredentialInternalController } from './credential-internal.controller.js'
import { CredentialResolveService } from './credential-resolve.service.js'
import { CredentialRefreshRegistry } from './credential-refresh.js'
import { createLarkRefreshAdapter } from './lark-oauth.refresh.js'
import { PersonalCredentialController } from './credential.controller.js'
import { PersonalCredentialRepository } from './credential.repository.js'
import { PersonalCredentialService } from './credential.service.js'

/**
 * 个人凭据模块（设计 §6.4）。
 *
 * 三块职责：
 * - 管理面 `/ai-credential/*`（管理员鉴权）：绑定 / 列表 / 改映射 / 吊销；
 * - 内部面 `/internal/credentials/resolve`（内部令牌）：按主体解析并刷新（网关 / 执行面用）；
 * - 审计：每一次读取 / 刷新 / 吊销 / 拒绝都写 `personal_credential_audits`（不含凭据值）。
 *
 * `CredentialRefreshRegistry` 先注册好、由 P11 把飞书 OAuth 适配器挂进来；
 * 没有适配器的 provider 不会刷新，按 `expires_at` 决定可用性。
 */
@Module({
  imports: [AdminModule],
  controllers: [PersonalCredentialController, CredentialInternalController],
  providers: [
    PersonalCredentialRepository,
    CredentialAuditRepository,
    {
      // 有平台飞书应用凭据才注册刷新适配器；没有就按"不刷新"处理（不假装能刷）
      provide: CredentialRefreshRegistry,
      useFactory: () => {
        const registry = new CredentialRefreshRegistry()
        const appId = process.env.LARK_APP_ID?.trim()
        const appSecret = process.env.LARK_APP_SECRET?.trim()
        if (appId && appSecret) registry.register(createLarkRefreshAdapter({ appId, appSecret }))
        return registry
      },
    },
    CredentialSyncService,
    PersonalCredentialService,
    CredentialResolveService,
    {
      provide: CREDENTIAL_CONFIG,
      inject: [ConfigService],
      useFactory: createCredentialConfig,
    },
    {
      // 推送通道：main → workspace-service（与工作区控制面同一套地址 / 令牌）
      provide: CREDENTIAL_SYNC_PORT,
      useFactory: () => {
        const client = new WorkspaceServiceClient({
          baseUrl: process.env.WORKSPACE_SERVICE_URL?.trim() || 'http://127.0.0.1:9995',
          token:
            process.env.WORKSPACE_INTERNAL_TOKEN?.trim() ||
            process.env.TOOL_INTERNAL_TOKEN?.trim() ||
            'dev-workspace-token',
        })
        return {
          status: (workspaceId: string) => client.status(workspaceId),
          sync: (workspaceId: string, version: string) => client.sync(workspaceId, version),
        }
      },
    },
  ],
  exports: [
    PersonalCredentialService,
    CredentialResolveService,
    {
      // 有平台飞书应用凭据才注册刷新适配器；没有就按"不刷新"处理（不假装能刷）
      provide: CredentialRefreshRegistry,
      useFactory: () => {
        const registry = new CredentialRefreshRegistry()
        const appId = process.env.LARK_APP_ID?.trim()
        const appSecret = process.env.LARK_APP_SECRET?.trim()
        if (appId && appSecret) registry.register(createLarkRefreshAdapter({ appId, appSecret }))
        return registry
      },
    },
    CredentialSyncService,
  ],
})
export class PersonalCredentialModule {}
