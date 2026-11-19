export { AdminEntity } from './admin-entity.js'
export { AiCapabilityServiceEntity } from './ai-capability-service-entity.js'
export { AiFileEntity } from './ai-file-entity.js'
export { AiMemoryEntity } from './ai-memory-entity.js'
export { AiModelEntity } from './ai-model-entity.js'
export { AiServiceGrantEntity } from './ai-service-grant-entity.js'
export { AiProviderKeyEntity } from './ai-provider-key-entity.js'
export { AiProviderEntity } from './ai-provider-entity.js'
export { AiSkillEntity } from './ai-skill-entity.js'
export { AiSkillFileEntity } from './ai-skill-file-entity.js'
export { AiToolAuditEntity } from './ai-tool-audit-entity.js'
export { AiToolEntity } from './ai-tool-entity.js'
export { AiUsageDailyDimensionEntity } from './ai-usage-daily-dimension-entity.js'
export { AiUsageDailyEntity } from './ai-usage-daily-entity.js'
export { AiWorkspaceEntity } from './ai-workspace-entity.js'
export { AlertLogEntity } from './alert-log-entity.js'
export { ConversationEntity } from './conversation-entity.js'
export { ConversationRunQueueEntity } from './conversation-run-queue-entity.js'
export { FileShareEntity } from './file-share-entity.js'
export { MonitorAlertEntity } from './monitor-alert-entity.js'
export { MonitorMetricSampleEntity } from './monitor-metric-sample-entity.js'
export { ModelGatewayUsageEntity } from './model-gateway-usage-entity.js'
export { MonitorRuleEntity } from './monitor-rule-entity.js'
export { RunEntity } from './run-entity.js'
export { TimelineEntity } from './timeline-entity.js'
export { UserEntity } from './user-entity.js'

import { AdminEntity } from './admin-entity.js'
import { AiCapabilityServiceEntity } from './ai-capability-service-entity.js'
import { AiFileEntity } from './ai-file-entity.js'
import { AiMemoryEntity } from './ai-memory-entity.js'
import { AiModelEntity } from './ai-model-entity.js'
import { AiServiceGrantEntity } from './ai-service-grant-entity.js'
import { AiProviderKeyEntity } from './ai-provider-key-entity.js'
import { AiProviderEntity } from './ai-provider-entity.js'
import { AiSkillEntity } from './ai-skill-entity.js'
import { AiSkillFileEntity } from './ai-skill-file-entity.js'
import { AiToolAuditEntity } from './ai-tool-audit-entity.js'
import { AiToolEntity } from './ai-tool-entity.js'
import { AiUsageDailyDimensionEntity } from './ai-usage-daily-dimension-entity.js'
import { AiUsageDailyEntity } from './ai-usage-daily-entity.js'
import { AiWorkspaceEntity } from './ai-workspace-entity.js'
import { AlertLogEntity } from './alert-log-entity.js'
import { ConversationEntity } from './conversation-entity.js'
import { ConversationRunQueueEntity } from './conversation-run-queue-entity.js'
import { FileShareEntity } from './file-share-entity.js'
import { MonitorAlertEntity } from './monitor-alert-entity.js'
import { MonitorMetricSampleEntity } from './monitor-metric-sample-entity.js'
import { ModelGatewayUsageEntity } from './model-gateway-usage-entity.js'
import { MonitorRuleEntity } from './monitor-rule-entity.js'
import { RunEntity } from './run-entity.js'
import { TimelineEntity } from './timeline-entity.js'
import { UserEntity } from './user-entity.js'

/** 全量实体：app 组合根 / 测试 DataSource 直接复用，避免每个 app 各抄一份 */
export const DB_ENTITIES = [
  AdminEntity,
  AiCapabilityServiceEntity,
  AiFileEntity,
  AiMemoryEntity,
  AiModelEntity,
  AiServiceGrantEntity,
  AiProviderKeyEntity,
  AiProviderEntity,
  AiSkillEntity,
  AiSkillFileEntity,
  AiToolAuditEntity,
  AiToolEntity,
  AiUsageDailyDimensionEntity,
  AiUsageDailyEntity,
  AiWorkspaceEntity,
  AlertLogEntity,
  ConversationEntity,
  ConversationRunQueueEntity,
  FileShareEntity,
  MonitorAlertEntity,
  MonitorMetricSampleEntity,
  ModelGatewayUsageEntity,
  MonitorRuleEntity,
  RunEntity,
  TimelineEntity,
  UserEntity,
]
