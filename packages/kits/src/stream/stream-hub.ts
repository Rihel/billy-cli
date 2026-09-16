import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger } from '../foundation/logger/app-logger.js'
import { STREAM_SHUTDOWN_EVENT, type StreamEventModel } from '@repo/shared'
import { Redis } from 'ioredis'
import { RedisConfig } from '../redis/redis.config.js'
import { IdGeneration } from '../foundation/id-generation/id-generation.js'
import { StreamHubError } from '../foundation/errors/infrastructure-errors.js'
import { StreamConnection, type StreamConnectionOptions } from './stream-connection.js'

/** 广播消息（Redis pub/sub 载荷）：携带发布实例 id，用于自回环过滤。 */
interface StreamBroadcastMessage {
  /** 发布实例 id（启动时生成）；收到与自身相同则丢弃，避免双推 */
  instanceId: string
  /** 目标频道（原始频道名，无 stream: 前缀） */
  channel: string
  /** 事件负载 */
  event: StreamEventModel
}

/** 广播订阅模式：pub/sub 频道统一 `stream:{channel}`（自带命名空间，与业务 key 隔离）。 */
const BROADCAST_PATTERN = 'stream:*'

/**
 * SSE 服务端推流门面（多实例广播）。
 *
 * 职责：
 * - 连接注册表（connections）+ 频道索引（channels）；
 * - `publish(channel, event)`：本地直推 + Redis pub/sub 广播（跨实例）；
 * - 广播自回环过滤（instanceId 相同丢弃，本实例已直推）；
 * - 随应用生命周期启停 pub / sub 两条独立 ioredis 连接
 *   （ioredis 进入订阅模式后不可 publish，必须分连接）。
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
  /** 发布 / 订阅两条独立连接（lazyConnect，onApplicationBootstrap 显式连接） */
  private readonly pub: Redis
  private readonly sub: Redis
  /** 本实例 id：广播自回环过滤 */
  private readonly instanceId: string
  private started = false
  /** 是否正在排空（`beforeApplicationShutdown` 置位后不再接受新长连接） */
  private draining = false


  constructor(
    @Inject(RedisConfig) private readonly config: RedisConfig,
    @Inject(IdGeneration) private readonly idGeneration: IdGeneration,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    // 广播 key 用 `stream:` 前缀自带命名空间，pub/sub 连接不套 keyPrefix（避免订阅模式下的前缀歧义）
    this.pub = new Redis(config.url, { lazyConnect: true })
    this.sub = new Redis(config.url, { lazyConnect: true })
    this.instanceId = idGeneration.next(16)
  }

  /** 应用启动：建立 pub/sub 连接并订阅广播频道。 */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await Promise.all([this.pub.connect(), this.sub.connect()])
      await this.sub.psubscribe(BROADCAST_PATTERN)
      this.sub.on('pmessage', (_pattern, channel, payload) =>
        this.onBroadcast(channel, payload),
      )
      this.started = true
      this.logger.info('SSE Hub 已启动', { instanceId: this.instanceId })
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
    try {
      await Promise.allSettled([this.sub.quit(), this.pub.quit()])
      this.logger.info('SSE Hub 已停止')
    } catch (cause) {
      throw new StreamHubError(cause)
    }
  }

  /** 创建一条 SSE 连接（SSE 路由调用；连接关闭自动从注册表 / 频道索引注销）。 */
  createConnection(options: StreamConnectionOptions): StreamConnection {
    const connection = new StreamConnection(
      this.idGeneration.next(20),
      options,
      (closed) => this.removeConnection(closed),
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
    for (const channel of [...connection.channels]) {
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
    const payload: StreamBroadcastMessage = {
      instanceId: this.instanceId,
      channel,
      event,
    }
    void this.pub
      .publish(`stream:${channel}`, JSON.stringify(payload))
      .catch((error) =>
        this.logger.error('SSE 广播失败', { channel, error }),
      )
  }

  /** 推送给本实例持有该频道的全部连接。 */
  private deliverLocal(channel: string, event: StreamEventModel): void {
    const connections = this.channels.get(channel)
    if (!connections) return
    for (const connection of connections) {
      void connection.write(event)
    }
  }

  /** 收到其他实例的广播：自回环过滤后推给本地连接。 */
  private onBroadcast(channel: string, payload: string): void {
    if (!this.started) return
    let message: StreamBroadcastMessage
    try {
      message = JSON.parse(payload) as StreamBroadcastMessage
    } catch {
      return
    }
    if (message.instanceId === this.instanceId) return
    this.deliverLocal(message.channel, message.event)
  }
}
