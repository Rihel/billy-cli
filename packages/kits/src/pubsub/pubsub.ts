import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'
import { Redis } from 'ioredis'
import { AppLogger } from '../foundation/logger/app-logger.js'
import { IdGeneration } from '../foundation/id-generation/id-generation.js'
import { PubSubError } from '../foundation/errors/infrastructure-errors.js'
import { RedisConfig } from '../redis/redis.config.js'

/** 订阅回调：`payload` 是发布方给的对象，`meta` 用于排障（哪个频道、哪个实例、什么时候发的） */
export type PubSubHandler = (payload: unknown, meta: PubSubMessageMeta) => void | Promise<void>

/** 这次消息的元信息（不参与业务判断） */
export interface PubSubMessageMeta {
  /** 完整频道名（带 `stream:` / `events:` 前缀） */
  readonly channel: string
  /** 发布实例 id（本地发布时是自己的 id） */
  readonly instanceId: string
  /** 发布时刻（毫秒时间戳，发布方时钟） */
  readonly publishedAt: number
}

/** 广播载荷：带发布实例 id，用于自回环过滤 */
interface PubSubEnvelope {
  instanceId: string
  channel: string
  payload: unknown
  publishedAt: number
}

/** 频道名上限（Redis 没有硬限制，这里给一个防手滑的边界） */
const MAX_CHANNEL_LENGTH = 256

/**
 * **底层 pub/sub 传输**（Redis，跨实例广播）。
 *
 * 只做四件事，不关心上层是 SSE 连接还是事件处理函数：
 * - 两条独立连接（ioredis 订阅模式不能 publish），**懒建连**；
 * - `broadcast(channel, payload)`：序列化后发布到 Redis；
 * - `subscribe(channel, handler)` / `subscribePattern(pattern, handler)`：**只收其他实例的消息**
 *   （自回环按 `instanceId` 过滤；本地送达由上层自己决定，避免重复）；
 * - 断线重连由 ioredis 负责，重连成功（`ready`）后自动重订阅当前所有频道 / 模式。
 *
 * 语义是 **at-most-once**：Redis pub/sub 不持久化，掉线期间的消息会丢。
 * 需要可靠投递的业务用 Kafka，不要用这里。
 *
 * 上层：
 * - `StreamHub`：频道 `stream:<channel>`，模式订阅 `stream:*`，把事件写给 SSE 连接；
 * - `EventBus`：频道 `events:<topic>`，精确订阅，把事件交给进程内处理函数。
 */
@Injectable()
export class PubSub implements OnApplicationShutdown {
  /** 发布连接（普通模式） */
  private readonly pub: Redis
  /** 订阅连接（订阅模式，不能 publish） */
  private readonly sub: Redis
  /** 本实例 id：广播自回环过滤 */
  private readonly instanceId: string
  /** 精确频道 → 处理函数 */
  private readonly exact = new Map<string, Set<PubSubHandler>>()
  /** 模式（psubscribe）→ 处理函数 */
  private readonly patterns = new Map<string, Set<PubSubHandler>>()
  /** 已经订阅的精确频道 / 模式（断线重连后重新订阅用） */
  private readonly subscribedChannels = new Set<string>()
  private readonly subscribedPatterns = new Set<string>()
  /** 建连中的 promise（并发调用共享一次连接） */
  private connecting: Promise<void> | null = null
  private closed = false

  constructor(
    @Inject(RedisConfig) config: RedisConfig,
    @Inject(IdGeneration) idGeneration: IdGeneration,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    // pub/sub 连接不套 keyPrefix：订阅的频道名必须是完整的 `<域>:<频道>`
    this.pub = new Redis(config.url, { lazyConnect: true })
    this.sub = new Redis(config.url, { lazyConnect: true })
    this.instanceId = idGeneration.next(16)

    this.sub.on('message', (channel: string, raw: string) =>
      this.dispatch(this.exact.get(channel), channel, raw),
    )
    this.sub.on('pmessage', (pattern: string, channel: string, raw: string) =>
      this.dispatch(this.patterns.get(pattern), channel, raw),
    )
    // 断线重连后 ioredis 会丢掉订阅关系，必须重新订阅
    this.sub.on('ready', () => void this.resubscribeAll())
    this.sub.on('error', (error: unknown) =>
      this.logger.warn('Pub/Sub 订阅连接异常', { instanceId: this.instanceId, error }),
    )
    this.pub.on('error', (error: unknown) =>
      this.logger.warn('Pub/Sub 发布连接异常', { instanceId: this.instanceId, error }),
    )
  }

  /** 本实例 id（上层做本地送达时写进 meta，便于排障） */
  get id(): string {
    return this.instanceId
  }

  /**
   * 建立连接（幂等；首次 `broadcast` / `subscribe` 会自动调用）。
   *
   * 单独暴露是为了让"启动时就要开始收消息"的场景能显式等一次（避免和第一条消息赛跑）。
   */
  async connect(): Promise<void> {
    if (this.closed) throw new PubSubError('Pub/Sub 已关闭')
    // 用显式 null 比较：packages 关闭 strictNullChecks 后真值判断会被误判成 Promise 条件
    if (this.connecting === null) {
      this.connecting = (async () => {
        await Promise.all([this.pub.connect(), this.sub.connect()])
        await this.resubscribeAll()
        this.logger.info('Pub/Sub 已连接', { instanceId: this.instanceId })
      })().catch((error: unknown) => {
        // 连接失败不缓存失败的 promise：下一次调用重新尝试（ioredis 自己也会重连）
        this.connecting = null
        throw new PubSubError(error)
      })
    }
    return this.connecting
  }

  /**
   * 发布到频道（只发远端，**不负责本地送达**）。
   *
   * @returns 是否成功发布到 Redis（`false` = Redis 不可用或已关闭）
   */
  async broadcast(channel: string, payload: unknown): Promise<boolean> {
    assertChannel(channel)
    const publishedAt = Date.now()
    let body: string
    try {
      body = JSON.stringify({
        instanceId: this.instanceId,
        channel,
        payload,
        publishedAt,
      } satisfies PubSubEnvelope)
    } catch (error) {
      throw new Error(`Pub/Sub 负载无法序列化为 JSON（channel: ${channel}）：${String(error)}`)
    }

    try {
      await this.connect()
      await this.pub.publish(channel, body)
      return true
    } catch (error) {
      // 广播是"锦上添花"：失败只记日志，不打断调用方业务
      this.logger.warn('Pub/Sub 广播失败', { channel, error })
      return false
    }
  }

  /**
   * 订阅一个**精确频道**（同步注册，连接在后台建立）。返回取消订阅函数。
   *
   * 注意：同一个频道不要同时用 `subscribe` 和 `subscribePattern` 订阅 ——
   * ioredis 会分别触发 `message` 与 `pmessage`，上层会收到两份。
   */
  subscribe(channel: string, handler: PubSubHandler): () => void {
    assertChannel(channel)
    const set = this.handlersOf(this.exact, channel)
    set.add(handler)
    void this.connect()
      .then(() => this.subscribeChannel(channel))
      .catch((error: unknown) => this.logger.warn('Pub/Sub 订阅失败', { channel, error }))
    return () => this.unsubscribe('exact', channel, handler)
  }

  /** 按模式订阅（如 `stream:*`）。返回取消订阅函数。 */
  subscribePattern(pattern: string, handler: PubSubHandler): () => void {
    assertChannel(pattern)
    const set = this.handlersOf(this.patterns, pattern)
    set.add(handler)
    void this.connect()
      .then(() => this.ensurePatternSubscribed(pattern))
      .catch((error: unknown) => this.logger.warn('Pub/Sub 模式订阅失败', { pattern, error }))
    return () => this.unsubscribe('pattern', pattern, handler)
  }

  /** 应用停止：清空订阅并断开两条连接 */
  async onApplicationShutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.exact.clear()
    this.patterns.clear()
    this.subscribedChannels.clear()
    this.subscribedPatterns.clear()
    await Promise.allSettled([closeRedis(this.sub), closeRedis(this.pub)])
    this.logger.info('Pub/Sub 已停止', { instanceId: this.instanceId })
  }

  /** 订阅一个精确频道（幂等） */
  private async subscribeChannel(channel: string): Promise<void> {
    if (this.closed || this.subscribedChannels.has(channel)) return
    await this.sub.subscribe(channel)
    this.subscribedChannels.add(channel)
  }

  /** 订阅一个模式（幂等） */
  private async ensurePatternSubscribed(pattern: string): Promise<void> {
    if (this.closed || this.subscribedPatterns.has(pattern)) return
    await this.sub.psubscribe(pattern)
    this.subscribedPatterns.add(pattern)
  }

  /** 重连后重新订阅当前所有频道与模式（`ready` 事件里调用） */
  private async resubscribeAll(): Promise<void> {
    if (this.closed) return
    for (const channel of this.exact.keys()) {
      try {
        await this.sub.subscribe(channel)
        this.subscribedChannels.add(channel)
      } catch (error) {
        this.logger.warn('Pub/Sub 重订阅失败', { channel, error })
      }
    }
    for (const pattern of this.patterns.keys()) {
      try {
        await this.sub.psubscribe(pattern)
        this.subscribedPatterns.add(pattern)
      } catch (error) {
        this.logger.warn('Pub/Sub 模式重订阅失败', { pattern, error })
      }
    }
  }

  /** 收到消息：解析 + 自回环过滤后交给对应处理函数 */
  private dispatch(handlers: Set<PubSubHandler> | undefined, channel: string, raw: string): void {
    if (!handlers || handlers.size === 0) return
    let envelope: PubSubEnvelope
    try {
      envelope = JSON.parse(raw) as PubSubEnvelope
    } catch {
      this.logger.warn('Pub/Sub 消息不是合法 JSON，已丢弃', { channel })
      return
    }
    if (!envelope || typeof envelope !== 'object') return
    if (envelope.instanceId === this.instanceId) return
    if (envelope.channel !== channel) return
    const meta: PubSubMessageMeta = {
      channel,
      instanceId: envelope.instanceId,
      publishedAt: envelope.publishedAt,
    }
    // 快照本轮订阅者：分发期间退订不应让本轮漏调
    for (const handler of Array.from(handlers)) {
      try {
        const result = handler(envelope.payload, meta)
        if (result instanceof Promise) {
          void result.catch((error: unknown) =>
            this.logger.warn('Pub/Sub 处理函数失败', { channel, error }),
          )
        }
      } catch (error) {
        this.logger.warn('Pub/Sub 处理函数失败', { channel, error })
      }
    }
  }

  /** 取（或创建）某个频道 / 模式的处理函数集合 */
  private handlersOf(map: Map<string, Set<PubSubHandler>>, key: string): Set<PubSubHandler> {
    let set = map.get(key)
    if (!set) {
      set = new Set()
      map.set(key, set)
    }
    return set
  }

  /** 取消订阅（幂等）；最后一个处理函数移除时退订频道 / 模式 */
  private unsubscribe(kind: 'exact' | 'pattern', key: string, handler: PubSubHandler): void {
    const map = kind === 'exact' ? this.exact : this.patterns
    const set = map.get(key)
    if (!set || !set.delete(handler)) return
    if (set.size > 0) return
    map.delete(key)
    if (kind === 'exact') {
      if (!this.subscribedChannels.delete(key)) return
      void this.sub
        .unsubscribe(key)
        .catch((error: unknown) => this.logger.warn('Pub/Sub 退订失败', { channel: key, error }))
      return
    }
    if (!this.subscribedPatterns.delete(key)) return
    void this.sub
      .punsubscribe(key)
      .catch((error: unknown) => this.logger.warn('Pub/Sub 模式退订失败', { pattern: key, error }))
  }
}

/** 关闭一条 ioredis 连接（没建过连的直接断开，避免 quit 抛"不可写"） */
const closeRedis = async (client: Redis): Promise<void> => {
  if (client.status === 'wait' || client.status === 'end') {
    client.disconnect()
    return
  }
  await client.quit()
}

/** 频道是编程期常量：写错立即抛，不静默丢弃 */
const assertChannel = (channel: string): void => {
  if (!channel || channel.length > MAX_CHANNEL_LENGTH || /\s/.test(channel)) {
    throw new Error(
      `非法的 Pub/Sub 频道：${channel || '(空)'}（不能为空、不能含空白、长度 ≤ ${MAX_CHANNEL_LENGTH}）`,
    )
  }
}
