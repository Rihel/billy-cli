import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger, EventBus, KafkaService } from '@repo/kits'

/**
 * **同步 / 刷新通知契约**：main（控制面）→ agent-runtime（运行面）。
 *
 * 为什么不是 main 直接同步：
 * 一次同步 = 连远端 → 列能力 → 转工具 → 写 `ai_tools` → 注册进**进程内**工具注册机。
 * 最后一步只在 runtime 的进程里有意义（注册机是内存态、随请求现取）；
 * main 是纯 HTTP/CRUD 控制面，不该为了同步把外部驱动、工具工厂、注册机也搬过来。
 * 所以 main 只负责"把意图送达"，真正的 `ConnectorSyncService.sync(id)` 在 runtime 跑。
 *
 * 传输两条腿（都发，任一成功即视为送达）：
 * - **Redis Pub/Sub**（`EventBus`，频道 `events:ai.connector.sync`）：低延迟、跨实例广播，
 *   与 main 现有的事件总线一致；语义 at-most-once，掉线会丢；
 * - **Kafka**（topic `ai.connector.sync`，只有装配了 `KafkaModule` 才有）：持久化、
 *   at-least-once，用来兜 Redis 抖动 / runtime 短暂离线。
 *
 * 消费方（runtime）应当幂等：同一个 `connectorId + requestedAt` 重复收到只做一次同步。
 *
 * 事件体是**只读契约**，加字段只能追加、不能改语义；`version` 变更表示不兼容。
 */
export const CONNECTOR_SYNC_TOPIC = 'ai.connector.sync'

/** 要 runtime 做的事 */
export type ConnectorSyncAction =
  /** 发现能力 → 写 `ai_tools` → 注册动态工具 → 回写 `status` / `tool_count` */
  | 'sync'
  /** 实例已删除：摘掉它动态注册的工具（`ai_tools` 行由 main 停用） */
  | 'remove'
  /** 凭证 / 品牌变了：丢掉该实例的连接池、CLI HOME、授权状态等运行期缓存 */
  | 'refresh'

/** main → runtime 的同步事件（JSON） */
export interface ConnectorSyncEvent {
  readonly version: 1
  readonly action: ConnectorSyncAction
  readonly connectorId: string
  /** 实例 key（只给日志与排障用，消费方不得用它做身份） */
  readonly key: string
  /** ISO 时间戳；消费方用它做幂等键（同一 id + 同一时刻只处理一次） */
  readonly requestedAt: string
}

/** 通知端口（单测传 fake，生产用 {@link ConnectorSyncNotifierService}） */
export interface ConnectorSyncNotifier {
  /**
   * 送达一条同步事件。
   *
   * @returns `true` = 至少有一条传输成功；`false` = Redis 与 Kafka 都失败（调用方据此回结论）
   */
  notify(event: ConnectorSyncEvent): Promise<boolean>
}

/** 通知端口的 DI token */
export const CONNECTOR_SYNC_NOTIFIER = Symbol.for('MainConnectorSyncNotifier')

@Injectable()
export class ConnectorSyncNotifierService implements ConnectorSyncNotifier {
  constructor(
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(AppLogger) private readonly logger: AppLogger,
    /** 未装配 Kafka 时为 undefined（`KafkaModule` 只在 env 齐全时进容器） */
    @Optional() @Inject(KafkaService) private readonly kafka?: KafkaService,
  ) {}

  async notify(event: ConnectorSyncEvent): Promise<boolean> {
    const redisDelivered = await this.publishRedis(event)
    const kafkaDelivered = await this.publishKafka(event)

    if (!redisDelivered && !kafkaDelivered) {
      this.logger.error('ai.connector.sync_not_delivered', {
        connectorId: event.connectorId,
        action: event.action,
      })
      return false
    }
    this.logger.log('ai.connector.sync_notified', {
      connectorId: event.connectorId,
      action: event.action,
      redis: redisDelivered,
      kafka: kafkaDelivered,
    })
    return true
  }

  private async publishRedis(event: ConnectorSyncEvent): Promise<boolean> {
    try {
      return await this.events.publish(CONNECTOR_SYNC_TOPIC, event)
    } catch (error) {
      // 通知失败不抛给 HTTP：同步是异步语义，调用方按"未送达"回结论即可
      this.logger.warn('ai.connector.sync_redis_failed', {
        connectorId: event.connectorId,
        reason: messageOf(error),
      })
      return false
    }
  }

  private async publishKafka(event: ConnectorSyncEvent): Promise<boolean> {
    if (!this.kafka) return false
    try {
      // 用 connectorId 做 key：同一实例的同步请求落到同一分区，天然有序
      await this.kafka.send(CONNECTOR_SYNC_TOPIC, event, event.connectorId)
      return true
    } catch (error) {
      this.logger.warn('ai.connector.sync_kafka_failed', {
        connectorId: event.connectorId,
        reason: messageOf(error),
      })
      return false
    }
  }
}

/** 错误对象 → 可读原文（不把堆栈写进日志字段） */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
