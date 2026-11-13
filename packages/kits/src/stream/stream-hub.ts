import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger } from '../foundation/logger/app-logger.js'
import { STREAM_SHUTDOWN_EVENT, type StreamEventModel } from '@repo/shared'
import { IdGeneration } from '../foundation/id-generation/id-generation.js'
import { StreamHubError } from '../foundation/errors/infrastructure-errors.js'
import { PubSub } from '../pubsub/pubsub.js'
import { StreamConnection, type StreamConnectionOptions } from './stream-connection.js'

/** 广播频道前缀：`stream:{channel}`（自带命名空间，与业务 key / 事件总线隔离）。 */
const CHANNEL_PREFIX = 'stream:'

/** 广播订阅模式：一次订阅全部业务频道 */
const BROADCAST_PATTERN = `${CHANNEL_PREFIX}*`

/**
 * SSE 服务端推流统一入口（多实例广播）。
 *
 * 职责：
 * - 连接注册表（connections）+ 频道索引（channels）；
 * - `publish(channel, event)`：本地直推 + 交给 `PubSub` 广播（跨实例，`stream:` 前缀）；
 * - 广播自回环过滤由 `PubSub` 统一做（按发布实例 id 丢弃本实例的广播）；
 * - Redis 连接 / 重连 / 重订阅都在 `PubSub`，本类不持有 ioredis 客户端。
 *
 * 广播路径：本地直推（低延迟、Redis 故障时本实例仍可达）+ Redis 广播（跨实例）。
 * 连接注册表是本实例内存态，广播只推持有本地连接的实例（设计文档 §5.3 / §8）。
 */
@Injectable()
export class StreamHub
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly connections = new Map<string, StreamConnection>()
  private readonly channels = new Map<string, Set<StreamConnection>>()
  /** 取消广播模式订阅（启动时建立，关闭时释放） */
  private offBroadcast: (() => void) | null = null
  private started = false
  /** 是否正在排空（`beforeApplicationShutdown` 置位后不再接受新长连接） */
  private draining = false

  constructor(
    @Inject(PubSub) private readonly pubsub: PubSub,
    @Inject(IdGeneration) private readonly idGeneration: IdGeneration,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 应用启动：建立 pub/sub 连接并订阅广播频道。 */
  async onApplicationBootstrap(): Promise<void> {
    try {
      // 先登记模式订阅（PubSub 建连后会统一订阅），再等连接
      this.offBroadcast = this.pubsub.subscribePattern(BROADCAST_PATTERN, (event, meta) => {
        if (!this.started) return
        this.deliverLocal(meta.channel.slice(CHANNEL_PREFIX.length), event)
      })
      // 显式等一次：SSE 连接可能马上 publish，别让第一条消息和建连赛跑
      await this.pubsub.connect()
      this.started = true
      this.logger.info('SSE Hub 已启动', { instanceId: this.pubsub.id })
    } catch (cause) {
      throw new StreamHubError(cause)
    }
  }

  /**
   * 应用关闭**第一步**（Nest 在 `httpAdapter.close()` 之前调用）：排空全部 SSE 长连接。
   *
   * 为什么必须早于 `onApplicationShutdown`：SSE 路由 `await connection.closed` 挂起长连接，
   * 只要还有一条存活，`server.close()` 的回调就永不触发 → `app.close()` 挂死 → 只能等
   * `terminationGracePeriodSeconds` 到点被 SIGKILL，在途的普通请求跟着一起死（表现为滚动更新 502）。
   *
   * 关闭前先推一条 `stream.shutdown`：客户端据此**立即重连到其他实例**，
   * 而不是把流的正常结束当成终态（那样滚动更新后长连接会静默失效）。
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.draining = true
    const connections = [...this.connections.values()]
    if (connections.length === 0) return

    this.logger.info('正在排空 SSE 长连接', { count: connections.length })
    await Promise.allSettled(
      connections.map(async (connection) => {
        // write 内部已吞掉写失败并自动 close（连接可能刚好断了）
        await connection.write({
          event: STREAM_SHUTDOWN_EVENT,
          data: { reason: 'server-shutdown' },
        })
        connection.close()
      }),
    )
  }

  /** 应用停止：断开 pub/sub 连接。 */
  async onApplicationShutdown(): Promise<void> {
    this.started = false
    // 只释放本类的模式订阅；Redis 连接归 PubSubModule（可能还有别的消费者）
    this.offBroadcast?.()
    this.offBroadcast = null
    this.logger.info('SSE Hub 已停止')
  }

  /** 创建一条 SSE 连接（SSE 路由调用；连接关闭自动从注册表 / 频道索引注销）。 */
  createConnection(options: StreamConnectionOptions): StreamConnection {
    const connection = new StreamConnection(this.idGeneration.next(20), options, (closed) =>
      this.removeConnection(closed),
    )
    this.connections.set(connection.id, connection)
    // 排空中到达的新长连接立即关闭：否则它会重新挂住 httpServer.close()，让排空白做
    // （k8s 此时已摘流，正常的滚动更新不该走到这里；非 k8s 的 LB 仍可能补发请求）
    if (this.draining) connection.close()
    return connection
  }

  /** 订阅频道（幂等：重复订阅不重复计数）。 */
  subscribe(connection: StreamConnection, channel: string): void {
    if (connection.channels.has(channel)) return
    connection.channels.add(channel)
    let set = this.channels.get(channel)
    if (!set) {
      set = new Set()
      this.channels.set(channel, set)
    }
    set.add(connection)
  }

  /** 取消订阅频道（幂等）。 */
  unsubscribe(connection: StreamConnection, channel: string): void {
    if (!connection.channels.delete(channel)) return
    const set = this.channels.get(channel)
    if (!set) return
    set.delete(connection)
    if (set.size === 0) this.channels.delete(channel)
  }

  /** 注销连接（幂等）：清频道索引 + 移除注册表。 */
  removeConnection(connection: StreamConnection): void {
    for (const channel of connection.channels) {
      this.unsubscribe(connection, channel)
    }
    this.connections.delete(connection.id)
  }

  /**
   * 发布事件到频道：本地直推本实例连接 + Redis pub/sub 广播到其他实例。
   * 广播失败不影响本地直推（记录日志）。
   */
  publish(channel: string, event: StreamEventModel): void {
    this.deliverLocal(channel, event)
    // 广播失败由 PubSub 记日志；本实例已直推，不影响调用方
    void this.pubsub.broadcast(`${CHANNEL_PREFIX}${channel}`, event)
  }

  /** 推送给本实例持有该频道的全部连接。 */
  private deliverLocal(channel: string, event: StreamEventModel): void {
    const connections = this.channels.get(channel)
    if (!connections) return
    for (const connection of connections) {
      void connection.write(event)
    }
  }
}
