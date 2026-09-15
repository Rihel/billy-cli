# 高并发与一致性详解（concurrency 引用文件）

> 本文件是 `concurrency` skill 的组成部分，由主 SKILL.md 引用。
> 实现缓存 / 限流 / 幂等 / 分布式锁时必读。

## 1. 基础设施：RedisStore（kits/src/redis/redis-store.ts）

所有能力基于 `RedisStore` 门面（`@Inject(RedisStore)`，生命周期组件）：

| 能力 | 方法 | 适用 |
| --- | --- | --- |
| KV + TTL | `set` / `get` / `del` / `expire` / `ttl` | 简单缓存 / 标记 |
| JSON 缓存 | `setJson(key, val, ttl?)` / `getJson(key)` | 缓存复杂结构 |
| 计数器 | `incr(key)` | 限流计数 / 统计 |
| 分布式锁 | `acquireLock(key, ttl)` → `token`；`releaseLock(key, token)` | 互斥 / 幂等 / 抢锁 |

底层 `raw`（ioredis 实例）可直调 List / ZSet / PubSub 等（实现查找顺序的最后手段）。

## 2. 缓存模式

```ts
// 读缓存 → 未命中查库 → 写缓存（带 TTL）
let data = await redis.getJson<Xxx>(`xxx:${id}`)
if (data === null) {
  data = await repo.findById(id)
  if (data) await redis.setJson(`xxx:${id}`, data, 60)   // 60s 过期
}
```

- **写后失效 / 双写**：更新数据时 `del` 或重新 `setJson` 缓存，避免脏读。
- **防击穿 / 雪崩**：缓存带 TTL；热点 key 的过期时间加随机抖动；单飞用分布式锁兜底。
- 归位：通用缓存封装可放 `kits/foundation`，业务内直接注入 `RedisStore` 用即可。

## 3. 限流模式

**HTTP 接口限流**（首选：`RateLimitGuard` 守卫 + `@RateLimit({ scope })` 方法装饰器，
实现在 `apps/server/src/common/security/rate-limit.guard.ts`）：

```ts
@Post('login')
@HttpCode(200)
@UseGuards(RateLimitGuard)
@RateLimit({ scope: 'login', limit: 20, windowSeconds: 60 })
login(@Body({ schema: LoginSchema }) input: LoginDto) { ... }
```

- `RateLimiter`（`kits/src/rate-limit/rate-limiter.ts`，由 `RateLimitModule` 装配）基于 **rate-limiter-flexible** 的
  `RateLimiterRedis`（Redis 存储，底层 Lua 原子计数）；`check(key, limit, windowSeconds)`
  返回 `{ allowed, remaining, retryAfterSeconds }`；底层实例按 `(limit, window)` 组合缓存复用。
- 守卫按 **IP** 计数（门面 key `scope:ip`，底层由 `RateLimiter` 统一加 `ratelimit:` 前缀），
  超限抛边界错误返回 429 + `Retry-After`；
  白名单豁免（**ipaddr.js** 匹配：精确 IP / IPv4·IPv6 CIDR，env `RATE_LIMIT_WHITELIST`，命中跳过计数）。
- **IP 来源**：`apps/server/src/common/security/rate-limit.guard.ts` 的 `clientIp()` 统一提取，
  默认直连 socket 地址，防伪造 XFF 绕过；
  部署在可信反代后置 `RATE_LIMIT_TRUST_PROXY=true` 才取 `x-forwarded-for` 首值。
- IPv6 双栈下 socket 地址为 `::ffff:<v4>`，已统一规范化（`normalizeIp`）。
- 需更精确算法（滑动窗口 / 令牌桶）时：**rate-limiter-flexible 不内置对应类**，
  滑动窗口可按下一节的 `raw` ZSet 思路自实现（`ZREMRANGEBYSCORE` + `ZCARD` + `ZADD`），
  令牌桶需自行实现或换库，别去 import 不存在的类。

**业务侧计数**（非 HTTP 场景，RedisStore 原生）：

```ts
const count = await redis.incr(`rate:${userId}:${windowKey}`)
if (count === 1) await redis.expire(`rate:${userId}:${windowKey}`, 60)  // 60s 窗口
if (count > MAX) throw new XxxError(...)   // 超限
```

**滑动窗口**（精确，用 `raw` 的 ZSet）：
`ZREMRANGEBYSCORE` 清过期 → `ZCARD` 计数 → `ZADD` 当前时间戳。

## 4. 幂等模式

- **分布式锁做幂等**：`acquireLock('order:'+id, 30)` 抢锁，抢到才处理，`finally` 释放。
- **幂等键**：`setJson('idem:'+key, {done:true}, ttl)`，用 `incr` 或 `set NX`（`acquireLock`）判断是否首次。

## 5. 分布式锁模式（核心）

```ts
const token = await redis.acquireLock(`job:${taskId}`, 30)  // 30s 自动过期防死锁
if (!token) {
  // 获取不到锁：重试 / 丢弃 / 排队，视业务而定
  return
}
try {
  await doWork()
} finally {
  await redis.releaseLock(`job:${taskId}`, token)  // 必须带 token 释放
}
```

**铁律**：
1. **锁必须带 TTL**（`acquireLock` 的第 2 参），防止持有者崩溃导致死锁。
2. **释放必须带 token**：`releaseLock` 用 Lua 校验 token，只释放**自己**的锁，避免误删他人刚续上的锁。
3. **拿到锁后业务尽量短**，长任务在过期前续期（`expire`）或拆成队列任务。
4. **获取不到锁要有明确的降级行为**（重试 / 失败 / 排队），不能静默继续。
5. 同一把锁的 key 命名规范：`<域>:<业务id>`，如 `order:pay:123`。

## 6. 分布式锁增强：RedisLockService（推荐）

`RedisStore.acquireLock` 只解决「一次尝试」；临界区长于 TTL、或需要排队等待时，用
`RedisLockService`（kits/src/redis/redis-lock.service.ts）：

- **自旋等待**：`lock(key, ttlSeconds, timeoutSeconds)` 持续重试直到拿到锁或超时；
- **看门狗续期**：持锁期间按 `TTL/3` 用 Lua 原子续期，避免长任务执行到一半锁过期；
- **Lua 原子释放/续期**：读-判-写在一个脚本里，只释放/续期自己的锁；
- **超时语义**：等待超时抛 `RedisLockError`（业务码 4002 / HTTP 429，语义=资源占用请重试）。

```ts
// 推荐入口：自动加解锁，业务抛错也会释放
constructor(@Inject(RedisLockService) private readonly lock: RedisLockService) {}

await this.lock.withLock(`order:${id}`, 30, 10, () => this.settle(id))
```

方法级装饰器（宿主类需把锁服务注入为 `redisLock` 属性）：

```ts
constructor(@Inject(RedisLockService) readonly redisLock: RedisLockService) {}

@RedisLock('order', (id: string) => id, 30, 10)
async settle(id: string) { ... }
```

**取舍**：看门狗只保证「持锁进程存活期间」续期；进程被杀仍靠 TTL 兜底。跨进程/长任务场景
更稳妥的做法是「锁只保护状态跃迁，长耗时逻辑异步化到队列」。

## 7. 列表缓存：RedisListCache

把一个 `T[]` 整体放进一个 Redis Hash（field = 主键，value = 单条 JSON），支持按主键增量增删改：

```ts
const cache = new RedisListCache<UserModel, 'id'>('user:all', redisStore, 'id')
await cache.set(users)                     // 全量覆盖（先清空）
await cache.updateByPrimary(id, user)      // 单条 upsert
await cache.removeByPrimary(id)
const all = await cache.get()              // 无数据返回 []
```

适用「全量小、读多写少、按主键定位」的字典 / 配置 / 组织架构类数据；**不适合**大列表分页
（该场景走 DB + 索引 + `pageWith`/`cursorPageWith`）。key 的前缀由 `RedisStore` 的
`keyPrefix` 统一处理，这里传裸 key。

## 8. 归位与注意

- 封装：通用并发工具（限流器、幂等表）放 `kits/foundation`；业务内直接注入 `RedisStore` 用。
- 引用 `RedisStore` 经 DI（`@Inject(RedisStore)`），不要 `new` 连接。
- 先按「实现查找顺序」确认：能用 `RedisStore` 原生方法（锁 / incr / TTL）就不引新库 / 不自己实现。
- 涉及分布式一致性时，先看 `design.md` 评估复杂度，别一上来就上分布式锁。
