import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger, EventBus, KafkaConsumer } from '@repo/kits'
import { ConnectorSyncService } from './connector.sync.service.js'

export const CONNECTOR_SYNC_TOPIC = 'ai.connector.sync'

interface ConnectorSyncEvent {
  version: 1
  action: 'sync' | 'remove' | 'refresh'
  connectorId: string
  key: string
  requestedAt: string
}

/** main 的控制面事件 → runtime 执行同步/摘工具/刷新缓存 */
@Injectable()
export class ConnectorSyncSubscriber implements OnApplicationBootstrap, OnApplicationShutdown {
  private unsubscribe?: () => void
  private readonly seen = new Set<string>()

  constructor(
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(ConnectorSyncService) private readonly sync: ConnectorSyncService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.events.subscribe<ConnectorSyncEvent>(
      CONNECTOR_SYNC_TOPIC,
      (event) => void this.apply(event),
    )
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  @KafkaConsumer(CONNECTOR_SYNC_TOPIC, 'runtime')
  onKafka(payload: unknown): void {
    void this.apply(payload as ConnectorSyncEvent)
  }

  private async apply(event: ConnectorSyncEvent): Promise<void> {
    if (!event?.connectorId || !event.requestedAt) return
    const key = `${event.connectorId}:${event.requestedAt}:${event.action}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 1000) this.seen.clear()
    try {
      if (event.action === 'sync') {
        await this.sync.sync(event.connectorId)
        return
      }
      this.sync.disable(event.connectorId)
      if (event.action === 'refresh') await this.sync.sync(event.connectorId)
    } catch (error) {
      this.logger.error('ai.connector.sync_event_failed', {
        connectorId: event.connectorId,
        action: event.action,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
