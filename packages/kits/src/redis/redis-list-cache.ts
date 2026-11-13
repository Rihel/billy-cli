import { hasContentArray, parseJson } from '@repo/shared'
import { RedisStoreError } from '../foundation/errors/infrastructure-errors.js'
import type { RedisStore } from './redis-store.js'

/**
 * Redis Hash 列表缓存统一入口：把一个 `T[]` 整体缓存在一个 Hash 里
 * （field = 主键值，value = 单条记录的 JSON），支持按主键增量增删改。
 *
 * 适用「全量小、读多写少、按主键定位」的字典 / 配置 / 组织架构类数据；
 * 不适合大列表分页（该场景用 DB + 索引）。
 *
 * **不是 DI provider**：每个缓存实例的 key / 主键都不同，天然多实例，
 * 由使用方直接 `new`（与 `TimeWheel` 同类），故刻意不标 `@Injectable()`、
 * 构造器也不写 `@Inject()`——DI 装饰器只属于由 Nest 容器装配的类。
 *
 * 用法（在业务模块中 new 出来，key 自行约定命名空间）：
 *
 *   const cache = new RedisListCache<UserModel, 'id'>('user:all', redisStore, 'id')
 *   await cache.set(users)          // 全量覆盖
 *   await cache.updateByPrimary(id, user)  // 单条更新
 *   const all = await cache.get()
 *
 * 注意：key 的前缀由 RedisStore 的 ioredis keyPrefix 统一处理，这里传裸 key。
 */
export class RedisListCache<T extends Record<string, unknown>, PK extends keyof T> {
  constructor(
    private readonly key: string,
    private readonly redis: RedisStore,
    private readonly primaryKey: PK,
  ) {}

  /** 完整 key（RedisStore 的 keyPrefix 会在客户端侧追加） */
  get fullKey(): string {
    return this.key
  }

  /** 读取全量列表（无数据返回空数组） */
  async get(): Promise<T[]> {
    try {
      const raw = await this.redis.raw.hgetall(this.key)
      if (!raw) return []
      return Object.values(raw)
        .map((item) => parseJson<T>(item))
        .filter((item): item is T => Boolean(item))
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 全量覆盖（先清空再写入；空数组即仅清空） */
  async set(data: T[]): Promise<void> {
    await this.empty()
    if (!hasContentArray(data)) return
    await this.updateMany(data)
  }

  /** 按主键更新单条（等价 add：不存在即新增） */
  async updateByPrimary(value: T[PK], data: T): Promise<void> {
    try {
      await this.redis.raw.hset(this.key, String(value), JSON.stringify(data))
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 新增单条（语义别名） */
  async add(data: T): Promise<void> {
    await this.updateByPrimary(data[this.primaryKey], data)
  }

  /** 批量写入（pipeline，减少往返） */
  async updateMany(data: T[]): Promise<void> {
    if (!hasContentArray(data)) return
    try {
      const pipeline = this.redis.raw.pipeline()
      for (const item of data) {
        pipeline.hset(this.key, String(item[this.primaryKey]), JSON.stringify(item))
      }
      await pipeline.exec()
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 按主键删除单条 */
  async removeByPrimary(value: T[PK]): Promise<void> {
    try {
      await this.redis.raw.hdel(this.key, String(value))
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 按主键批量删除 */
  async removeByPrimaries(values: T[PK][]): Promise<void> {
    if (!hasContentArray(values)) return
    try {
      await this.redis.raw.hdel(this.key, ...values.map(String))
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 清空整个缓存 */
  async empty(): Promise<void> {
    try {
      await this.redis.raw.del(this.key)
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }
}
