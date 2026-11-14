/**
 * 连接器管理模块（main 控制面）—— 对外入口与**根模块接法**。
 *
 * 当前任务约束只允许新增本目录 + 单测，因此 `RootModule` 尚未被改动；接线方式如下
 * （一次改动，涉及两个共享根文件，需由能改它们的人执行）：
 *
 * 1. **`apps/main/src/root.module.ts`**：在 `imports` 里加一行
 *
 *    ```ts
 *    import { AiConnectorAdminModule } from './modules/ai-admin/connector/index.js'
 *    // ...
 *    imports: [
 *      // ...
 *      AiConnectorAdminModule,
 *    ]
 *    ```
 *
 *    `AdminModule` / `DbModule` / `EventBusModule` 都是全局或由本模块自行 import，
 *    根模块不需要再加别的 provider。
 *
 * 2. **`apps/main/src/modules/ai/ai.module.ts`**：撤掉旧连接器入口，否则 `/ai-connector/*`
 *    会被注册两次（Nest 会让后注册的覆盖前注册的，行为不可预期）：
 *    - `controllers` 去掉 `AiConnectorController`；
 *    - `providers` 去掉 `ConnectorSyncService`（它有 `onApplicationBootstrap` 启动同步，
 *      留在 main 就还在跑 agent 侧的同步逻辑）；
 *    - `ConnectorService` / `ConnectorRepository` / `CONNECTOR_STATE_SOURCE` 在 main 侧
 *      只服务旧的 `ConnectorGuardPlugin`，随整块 `modules/ai` 迁往 agent-runtime 时一并删除。
 *
 * 迁移完成后的目标形态：main = 本模块（HTTP/CRUD），agent-runtime = 驱动 + 同步 + 工具注册。
 *
 * 事件契约（runtime 侧消费，见 `connector.notifier.ts`）：
 * - Redis：`EventBus` 频道 `events:ai.connector.sync`；
 * - Kafka：topic `ai.connector.sync`（未装配 Kafka 时只走 Redis）；
 * - 负载：`{ version: 1, action: 'sync' | 'remove' | 'refresh', connectorId, key, requestedAt }`。
 */
export { AiConnectorAdminModule } from './connector.module.js'
export { AiConnectorAdminController } from './connector.controller.js'
export { ConnectorService } from './connector.service.js'
export {
  CONNECTOR_STORE,
  ConnectorRepository,
  type ConnectorStore,
} from './connector.repository.js'
export {
  CONNECTOR_PROBE,
  type ConnectorFieldDecl,
  type ConnectorProbePort,
  type ConnectorProbeResult,
  type ConnectorRuntime,
  type ConnectorSpec,
} from './connector.types.js'
export {
  CONNECTOR_SYNC_NOTIFIER,
  CONNECTOR_SYNC_TOPIC,
  ConnectorSyncNotifierService,
  type ConnectorSyncAction,
  type ConnectorSyncEvent,
  type ConnectorSyncNotifier,
} from './connector.notifier.js'
export { CONNECTOR_CATALOG, catalogEntryOf } from './connector.catalog.js'
export { CONNECTOR_SPECS, specOfDriver } from './connector.specs.js'
