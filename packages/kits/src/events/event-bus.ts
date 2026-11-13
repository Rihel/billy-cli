import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '../foundation/logger/app-logger.js'
import { PubSub } from '../pubsub/pubsub.js'

/** 订阅回调：`payload` 是发布方给的对象，`meta` 只用于排障 */
export type EventHandler<T = unknown> = (payload: T, meta: EventMeta) => void | Promise<void>

/** 这次事件的元信息（不参与业务判断） */
export interface EventMeta {
  /** 事件主题（与 `publish` 时一致） */
  readonly topic: string
  /** 发布实例 id（本地发布时是本实例 id） */
  readonly instanceId: string
  /** 发布时刻（毫秒时间戳，发布方时钟） */
  readonly publishedAt: number
}

/** 频道前缀：与业务 key、SSE 的 `stream:` 频道都隔离 */
const CHANNEL_PREFIX = 'events:'

/** topic 口径：小写字母 / 数字开头，允许 `. _ : -`，最长 128 —— 不开放通配符订阅 */
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/

/**
 * **进程内事件总线（基于 kits 的 PubSub，Redis 跨实例）**。
 *
 * 定位：**失效通知 / 领域事件的广播**，不是可靠消息队列。
 *
 * - 语义是 **at-most-once**：掉线期间的事件会丢；需要"最终一定到达"的事用 Kafka；
 * - 发布方**本地同步送达**自己，广播只发给其他实例（`PubSub` 按 `instanceId` 过滤）；
 * - 处理函数抛错只记日志，不影响其他订阅者、不影响发布方业务；
 * - 连接与重连归 `PubSub`（懒建连、断线重订阅）；本类只管 topic ↔ handler。
 *
 * 典型用法（缓存失效）：
 *
 * ```ts
 * await eventBus.publish('credential.changed', { subject, version })
 * const off = eventBus.subscribe('credential.changed', (payload) => cache.invalidate(payload.subject))
 * ```
 *
 * 注意：**广播不能替代数据库的一致性**。发布方要先把状态写库（带版本号），
 * 事件只负责让其他实例尽快失效缓存；漏了事件，靠"用时比对版本"兜底。
 */
@Injectable()
export class EventBus {
  /** topic → 处理函数集合（本实例内存态） */
  private readonly handlers = new Map<string, Set<EventHandler>>()
  /** topic → 取消远端订阅的函数（第一个处理函数注册时建立，最后一个移除时释放） */
  private readonly remoteOff = new Map<string, () => void>()

  constructor(
    @Inject(PubSub) private readonly pubsub: PubSub,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 显式等一次连接（可选；首次 publish / subscribe 会自动建连） */
  async connect(): Promise<void> {
    await this.pubsub.connect()
  }

  /**
   * 发布一个事件：**先本地同步送达，再广播到其他实例**。
   *
   * @returns 是否成功广播到 Redis（`false` = 只送达了本实例，Redis 不可用或已关闭）
   */
  async publish<T>(topic: string, payload: T): Promise<boolean> {
    assertTopic(topic)
    const publishedAt = Date.now()
    // 先序列化检查：不能序列化的负载连本地都不该送达（否则本地与远端看到的不一样）
    try {
      JSON.stringify(payload)
    } catch (error) {
      throw new Error(`事件负载无法序列化为 JSON（topic: ${topic}）：${String(error)}`)
    }

    this.deliverLocal(topic, payload, this.pubsub.id, publishedAt)
    return this.pubsub.broadcast(`${CHANNEL_PREFIX}${topic}`, payload)
  }

  /**
   * 订阅一个 topic（同步注册，连接在后台建立）。
   *
   * 返回取消订阅函数；同一个处理函数重复订阅只算一次。
   */
  subscribe<T>(topic: string, handler: EventHandler<T>): () => void {
    assertTopic(topic)
    let set = this.handlers.get(topic)
    if (!set) {
      set = new Set()
      this.handlers.set(topic, set)
      // 第一个订阅者出现时才建立远端订阅：没人的 topic 不占用频道
      this.remoteOff.set(
        topic,
        this.pubsub.subscribe(`${CHANNEL_PREFIX}${topic}`, (payload, meta) =>
          this.deliverLocal(topic, payload, meta.instanceId, meta.publishedAt),
        ),
      )
    }
    set.add(handler as EventHandler)
    return () => this.unsubscribe(topic, handler as EventHandler)
  }

  /** 取消订阅（幂等）；最后一个处理函数移除时释放远端订阅 */
  unsubscribe(topic: string, handler: EventHandler): void {
    const set = this.handlers.get(topic)
    if (!set || !set.delete(handler)) return
    if (set.size > 0) return
    this.handlers.delete(topic)
    this.remoteOff.get(topic)?.()
    this.remoteOff.delete(topic)
  }

  /** 交给本实例的处理函数：逐个隔离，一个抛错不影响其他订阅者 */
  private deliverLocal(
    topic: string,
    payload: unknown,
    instanceId: string,
    publishedAt: number,
  ): void {
    const set = this.handlers.get(topic)
    if (!set || set.size === 0) return
    const meta: EventMeta = { topic, instanceId, publishedAt }
    // 快照本轮订阅者：分发期间退订不应让本轮漏调
    for (const handler of Array.from(set)) {
      try {
        const result = handler(payload, meta)
        if (result instanceof Promise) {
          void result.catch((error: unknown) =>
            this.logger.warn('事件处理函数失败', { topic, error }),
          )
        }
      } catch (error) {
        this.logger.warn('事件处理函数失败', { topic, error })
      }
    }
  }
}

/** topic 是编程期常量：写错立即抛，不静默丢弃 */
const assertTopic = (topic: string): void => {
  if (!TOPIC_PATTERN.test(topic)) {
    throw new Error(
      `非法的事件 topic：${topic || '(空)'}（小写字母 / 数字开头，允许 . _ : -，长度 1–128）`,
    )
  }
}
