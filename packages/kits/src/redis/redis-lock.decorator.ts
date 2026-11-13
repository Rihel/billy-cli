import type { RedisLockService } from './redis-lock.service.js'

/** 宿主类暴露锁服务所用的约定属性名 */
const LOCK_SERVICE_PROP = 'redisLock'

/** 使用 @RedisLock 的宿主类需注入 RedisLockService 并命名为 `redisLock` */
interface LockAware {
  redisLock?: RedisLockService
}

/**
 * 方法级分布式锁装饰器（配合 {@link RedisLockService}）：
 * 进入方法前加锁、返回或抛错后解锁，锁 key 为 `${group}:${key}`。
 *
 * 宿主类需注入锁服务并命名为 `redisLock`：
 *
 *   constructor(@Inject(RedisLockService) readonly redisLock: RedisLockService) {}
 *
 *   @RedisLock('order', (id: string) => id, 30, 10)
 *   async settle(id: string) { ... }
 *
 * @param group 锁分组（前缀），如 'order'
 * @param key 锁标识：固定字符串，或由方法入参推导的函数（返回空值则跳过加锁）
 * @param ttlSeconds 锁 TTL（秒），持锁期间由看门狗自动续期
 * @param timeoutSeconds 获取锁的最长等待时间（秒），缺省等于 ttlSeconds
 */
export const RedisLock = (
  group: string,
  key: string | ((...args: never[]) => string | undefined | null),
  ttlSeconds: number,
  timeoutSeconds: number = ttlSeconds,
): MethodDecorator => {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const original = descriptor.value as (...args: unknown[]) => unknown

    descriptor.value = async function (this: LockAware, ...args: unknown[]) {
      const resolvedKey =
        typeof key === 'function'
          ? (key as (...args: unknown[]) => string | undefined | null)(...args)
          : key

      // 无 key 视为不参与互斥（如批量操作中的空标识）
      if (!resolvedKey) {
        return original.apply(this, args)
      }

      const lockService = this[LOCK_SERVICE_PROP]
      if (!lockService) {
        throw new Error(
          `@RedisLock 要求宿主类注入 RedisLockService 并命名为 "${LOCK_SERVICE_PROP}"`,
        )
      }

      return lockService.withLock(`${group}:${resolvedKey}`, ttlSeconds, timeoutSeconds, () =>
        original.apply(this, args),
      )
    }

    return descriptor
  }
}
