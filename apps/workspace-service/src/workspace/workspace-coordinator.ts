import { Inject, Injectable, Optional } from '@nestjs/common'
import { RedisLockService, RedisStore } from '@repo/kits'
import { KeyedMutex } from './keyed-mutex.js'

/** 工作区锁的 TTL（秒）：持锁期间由 RedisLockService 看门狗续期 */
const LOCK_TTL_SECONDS = 60
/** 等锁上限（秒）：超过就报「工作区忙」，不要无限挂住 HTTP / 工具调用 */
const LOCK_WAIT_SECONDS = 300
/** 最近使用时间的保留期：比 2h idle 宽裕，丢了也只会让回收器多等一轮 */
const LAST_USED_TTL_SECONDS = 7 * 24 * 3600

type LockKind = 'lifecycle' | 'exec' | 'fs'

/**
 * 工作区执行面的跨副本协调器。
 *
 * 单副本（本地 / Docker）走进程内 `KeyedMutex`，不引入 Redis；
 * 多副本（k8s）走 `RedisLockService`，同一 workspace 的 lifecycle / exec、同一路径的写
 * 由所有副本共享。`lastUsedAt` 也放 Redis，回收器才能看到别的副本的活动。
 *
 * 为什么按 workspace 分三把锁：
 * - `lifecycle`：ensure / setup / stop / destroy —— 与命令执行分开，stop 不必等 30 分钟命令；
 * - `exec`：bash 串行 —— 同一 workspace 只允许一条命令在跑；
 * - `fs`：按路径串行 —— 不同路径的写互不阻塞，读不加锁（原子 rename 保证不读半截）。
 */
@Injectable()
export class WorkspaceCoordinator {
  private readonly local = new KeyedMutex()

  constructor(
    @Optional() @Inject(RedisLockService) private readonly redisLock?: RedisLockService,
    @Optional() @Inject(RedisStore) private readonly redis?: RedisStore,
  ) {}

  /** 是否启用了跨副本协调（Redis 模块已装配） */
  get distributed(): boolean {
    return Boolean(this.redisLock && this.redis)
  }

  private lockKey(kind: LockKind, id: string): string {
    return `workspace:${kind}:${id}`
  }

  private lastUsedKey(id: string): string {
    return `workspace:lastUsed:${id}`
  }

  /** 排队等锁（同一 key 串行）；单副本走进程内 KeyedMutex */
  async withLock<T>(kind: LockKind, id: string, task: () => Promise<T>): Promise<T> {
    if (!this.distributed) return this.local.run(this.lockKey(kind, id), task)
    return this.redisLock!.withLock(
      this.lockKey(kind, id),
      LOCK_TTL_SECONDS,
      LOCK_WAIT_SECONDS,
      task,
    )
  }

  /**
   * 只试一次、不排队：回收器用。
   *
   * 单副本下没有跨进程竞争，直接执行；多副本下 `tryLock` 拿不到就跳过，
   * 绝不把「别人正在跑命令」的 workspace 当空闲回收。
   */
  async tryWithLock<T>(
    kind: LockKind,
    id: string,
    task: () => Promise<T>,
  ): Promise<{ acquired: boolean; result?: T }> {
    if (!this.distributed) {
      return { acquired: true, result: await this.local.run(this.lockKey(kind, id), task) }
    }
    const key = this.lockKey(kind, id)
    const token = await this.redisLock!.tryLock(key, LOCK_TTL_SECONDS)
    if (!token) return { acquired: false }
    try {
      return { acquired: true, result: await task() }
    } finally {
      await this.redisLock!.unlock(key, token)
    }
  }

  /** 记录最近使用时间（只在多副本 / 配了 Redis 时共享） */
  async touch(id: string): Promise<void> {
    if (!this.redis) return
    await this.redis.set(this.lastUsedKey(id), String(Date.now()), LAST_USED_TTL_SECONDS)
  }

  /** 最近使用时间；没有记录返回 null（回收器应保守跳过） */
  async lastUsed(id: string): Promise<number | null> {
    if (!this.redis) return null
    const raw = await this.redis.get(this.lastUsedKey(id))
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }

  /** 删除 / 停止后清掉共享状态 */
  async clear(id: string): Promise<void> {
    if (!this.redis) return
    await this.redis.del(this.lastUsedKey(id))
  }
}
