# 高并发与一致性详解（concurrency 引用文件）

> 本文件是 `concurrency` skill 的组成部分，由主 SKILL.md 引用。
> 实现缓存 / 限流 / 幂等 / 分布式锁时必读。

## 1. 基础设施：RedisStore（kits/infrastructure/redis-store.ts）

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

**固定窗口**（RedisStore 原生即可）：

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

## 6. 归位与注意

- 封装：通用并发工具（限流器、幂等表）放 `kits/foundation`；业务内直接注入 `RedisStore` 用。
- 引用 `RedisStore` 经 DI（`@Inject(RedisStore)`），不要 `new` 连接。
- 先按「实现查找顺序」确认：能用 `RedisStore` 原生方法（锁 / incr / TTL）就不引新库 / 不自己实现。
- 涉及分布式一致性时，先看 `design.md` 评估复杂度，别一上来就上分布式锁。
