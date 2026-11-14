import { Module } from '@nestjs/common'
import { AdminModule } from '../../admin/admin.module.js'
import { AiConnectorAdminController } from './connector.controller.js'
import { CONNECTOR_SYNC_NOTIFIER, ConnectorSyncNotifierService } from './connector.notifier.js'
import { ConnectorProbeService } from './connector.probe.js'
import { CONNECTOR_STORE, ConnectorRepository } from './connector.repository.js'
import { ConnectorService } from './connector.service.js'
import { CONNECTOR_PROBE } from './connector.types.js'

/**
 * **连接器管理模块（main 本地）**：`/ai-connector/*` 的唯一装配点。
 *
 * 依赖只有三样：
 * - `AdminAuthGuard` ← `AdminModule`（后台管理员鉴权，与其它管理模块同源）；
 * - `Db` ← `DbModule`（`@Global`，已在 `RootModule` 装配）；
 * - `EventBus` / `KafkaService` ← `EventBusModule`（`@Global`）/ 可选的 `KafkaModule`
 *   （未配 `KAFKA_BROKERS` 时没有，notifier 用 `@Optional` 降级成只走 Redis）。
 *
 * **不 import `AiModule`**：这个模块刻意不依赖 agent loop（Mastra / 工具注册机 / 驱动实例），
 * 迁移完成后 `AiModule` 里的 `AiConnectorController` 应当移除（否则 `/ai-connector/*`
 * 会被注册两次）。根模块接法见 `index.ts` 顶部注释。
 */
@Module({
  imports: [AdminModule],
  controllers: [AiConnectorAdminController],
  providers: [
    ConnectorRepository,
    { provide: CONNECTOR_STORE, useExisting: ConnectorRepository },
    ConnectorProbeService,
    { provide: CONNECTOR_PROBE, useExisting: ConnectorProbeService },
    { provide: CONNECTOR_SYNC_NOTIFIER, useClass: ConnectorSyncNotifierService },
    ConnectorService,
  ],
  exports: [ConnectorService, CONNECTOR_STORE, CONNECTOR_PROBE],
})
export class AiConnectorAdminModule {}
