import { Inject, Injectable, type OnModuleInit } from '@nestjs/common'
import { AppLogger, EventBus } from '@repo/kits'
import { AI_MODEL_CHANGED_TOPIC } from '@repo/shared'
import { ModelCatalogService } from '../catalog/model.catalog.service.js'
import { ProviderKeyService } from '../keys/provider-key.service.js'

/**
 * 配置变更事件：main 写库后发 `ai.model.changed`，网关失效目录 / key 缓存。
 *
 * 事件是 at-most-once（只做失效通知），丢了靠缓存 TTL 兜底（30s）。
 */
@Injectable()
export class ModelChangeSubscriber implements OnModuleInit {
  constructor(
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(ModelCatalogService) private readonly catalog: ModelCatalogService,
    @Inject(ProviderKeyService) private readonly keys: ProviderKeyService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.events.subscribe(AI_MODEL_CHANGED_TOPIC, () => {
      this.catalog.invalidate()
      this.keys.clearCache()
      this.logger.log('model.gateway.cache_invalidated')
    })
  }
}
