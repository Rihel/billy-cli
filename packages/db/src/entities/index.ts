export { AdminEntity } from './admin-entity.js'
export { AiCapabilityServiceEntity } from './ai-capability-service-entity.js'
export { AiFileEntity } from './ai-file-entity.js'
export { AiMarketItemEntity } from './ai-market-item-entity.js'
export { AiMemoryEntity } from './ai-memory-entity.js'
export { AiModelEntity } from './ai-model-entity.js'
export { AiServiceGrantEntity } from './ai-service-grant-entity.js'
export { AiProviderKeyEntity } from './ai-provider-key-entity.js'
export { AiProviderEntity } from './ai-provider-entity.js'
export { AiSkillEntity } from './ai-skill-entity.js'
export { AiSkillFileEntity } from './ai-skill-file-entity.js'
export { AiSkillGrantEntity } from './ai-skill-grant-entity.js'
export { AiToolAuditEntity } from './ai-tool-audit-entity.js'
export { AiToolEffectAttemptEntity } from './ai-tool-effect-attempt-entity.js'
export { AiToolEffectEntity } from './ai-tool-effect-entity.js'
export { AiToolEntity } from './ai-tool-entity.js'
export { AiUsageDailyDimensionEntity } from './ai-usage-daily-dimension-entity.js'
export { AiUsageDailyEntity } from './ai-usage-daily-entity.js'
export { AiWorkspaceEntity } from './ai-workspace-entity.js'
export { AiWorkspaceSetupEntity } from './ai-workspace-setup-entity.js'
export { AlertLogEntity } from './alert-log-entity.js'
export { ConversationEntity } from './conversation-entity.js'
export { ConversationRunQueueEntity } from './conversation-run-queue-entity.js'
export { FileShareEntity } from './file-share-entity.js'
export { MonitorAlertEntity } from './monitor-alert-entity.js'
export { MonitorMetricSampleEntity } from './monitor-metric-sample-entity.js'
export { ModelGatewayUsageEntity } from './model-gateway-usage-entity.js'
export { MonitorRuleEntity } from './monitor-rule-entity.js'
export { PersonalCredentialEntity } from './personal-credential-entity.js'
export { PersonalCredentialAuditEntity } from './personal-credential-audit-entity.js'
export { RunEntity } from './run-entity.js'
export { RunOwnershipEntity } from './run-ownership-entity.js'
export { TimelineEntity } from './timeline-entity.js'
export { UserEntity } from './user-entity.js'

import { AdminEntity } from './admin-entity.js'
import { AiCapabilityServiceEntity } from './ai-capability-service-entity.js'
import { AiFileEntity } from './ai-file-entity.js'
import { AiMarketItemEntity } from './ai-market-item-entity.js'
import { AiMemoryEntity } from './ai-memory-entity.js'
import { AiModelEntity } from './ai-model-entity.js'
import { AiServiceGrantEntity } from './ai-service-grant-entity.js'
import { AiProviderKeyEntity } from './ai-provider-key-entity.js'
import { AiProviderEntity } from './ai-provider-entity.js'
import { AiSkillEntity } from './ai-skill-entity.js'
import { AiSkillFileEntity } from './ai-skill-file-entity.js'
import { AiSkillGrantEntity } from './ai-skill-grant-entity.js'
import { AiToolAuditEntity } from './ai-tool-audit-entity.js'
import { AiToolEffectAttemptEntity } from './ai-tool-effect-attempt-entity.js'
import { AiToolEffectEntity } from './ai-tool-effect-entity.js'
import { AiToolEntity } from './ai-tool-entity.js'
import { AiUsageDailyDimensionEntity } from './ai-usage-daily-dimension-entity.js'
import { AiUsageDailyEntity } from './ai-usage-daily-entity.js'
import { AiWorkspaceEntity } from './ai-workspace-entity.js'
import { AiWorkspaceSetupEntity } from './ai-workspace-setup-entity.js'
import { AlertLogEntity } from './alert-log-entity.js'
import { ConversationEntity } from './conversation-entity.js'
import { ConversationRunQueueEntity } from './conversation-run-queue-entity.js'
import { FileShareEntity } from './file-share-entity.js'
import { MonitorAlertEntity } from './monitor-alert-entity.js'
import { MonitorMetricSampleEntity } from './monitor-metric-sample-entity.js'
import { ModelGatewayUsageEntity } from './model-gateway-usage-entity.js'
import { MonitorRuleEntity } from './monitor-rule-entity.js'
import { PersonalCredentialEntity } from './personal-credential-entity.js'
import { PersonalCredentialAuditEntity } from './personal-credential-audit-entity.js'
import { RunEntity } from './run-entity.js'
import { RunOwnershipEntity } from './run-ownership-entity.js'
import { TimelineEntity } from './timeline-entity.js'
import { UserEntity } from './user-entity.js'

/** 全量实体：app 组合根 / 测试 DataSource 直接复用，避免每个 app 各抄一份 */
export const DB_ENTITIES = [
  AdminEntity,
  AiCapabilityServiceEntity,
  AiFileEntity,
  AiMarketItemEntity,
  AiMemoryEntity,
  AiModelEntity,
  AiServiceGrantEntity,
  AiProviderKeyEntity,
  AiProviderEntity,
  AiSkillEntity,
  AiSkillFileEntity,
  AiSkillGrantEntity,
  AiToolAuditEntity,
  AiToolEffectAttemptEntity,
  AiToolEffectEntity,
  AiToolEntity,
  AiUsageDailyDimensionEntity,
  AiUsageDailyEntity,
  AiWorkspaceEntity,
  AiWorkspaceSetupEntity,
  AlertLogEntity,
  ConversationEntity,
  ConversationRunQueueEntity,
  FileShareEntity,
  MonitorAlertEntity,
  MonitorMetricSampleEntity,
  ModelGatewayUsageEntity,
  MonitorRuleEntity,
  PersonalCredentialEntity,
  PersonalCredentialAuditEntity,
  RunEntity,
  RunOwnershipEntity,
  TimelineEntity,
  UserEntity,
]
