---
name: concurrency
description: 在 Billy 工程中处理高并发与一致性：缓存、限流、幂等、分布式锁，基于 RedisStore 门面（acquireLock / incr / setJson+TTL）。触发词：高并发、并发、缓存、限流、幂等、分布式锁、锁、防重、计数、Redis、QPS。
---

# 高并发与一致性

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条——**能用 `RedisStore` 原生能力就不引新库**）。

## 核心要点

- 基础设施 `RedisStore`（`kits/infrastructure/redis-store.ts`）提供：`setJson` / `getJson`
  （缓存）、`incr`（限流计数）、`acquireLock` / `releaseLock`（分布式锁）。
- **缓存**：`setJson(key, val, ttl)` + `getJson`，写后失效 / 删除。
- **限流**：HTTP 接口用 `RateLimiter` 门面（`kits/infrastructure/rate-limit/`，基于
  **rate-limiter-flexible** 的 RateLimiterRedis，Redis 存储固定窗口）+ server 的
  `makeRateLimit` 中间件（按 IP、白名单豁免，白名单匹配用 **ipaddr.js**）；
  纯业务侧计数用 `incr` + `expire`；精确限流用 `raw` 的 ZSet 滑窗。
- **分布式锁**：`acquireLock(key, ttl)` → `token`，业务 `finally` 里 `releaseLock(key, token)`。
- **幂等**：用锁或幂等键（`set NX` / `incr`）防重复处理。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/concurrency-guide.md](./references/concurrency-guide.md) | 缓存 / 限流 / 幂等 / 分布式锁各模式、RedisStore 用法、锁的铁律与归位 | 做高并发 / 一致性时（必读） |

## 完成检查清单

- [ ] 复用 `RedisStore` 门面（`@Inject`），未自写 Redis 连接 / 未引多余库
- [ ] 分布式锁：带 TTL、释放带 token、业务短、获取失败有降级
- [ ] 缓存带 TTL，写后失效；热点 key 防击穿 / 雪崩
- [ ] 限流窗口与阈值明确，超限有明确行为（抛错 / 排队）
- [ ] 关键 key 命名 `<域>:<业务id>` 统一，避免冲突
- [ ] 涉及分布式一致性时先按 `design.md` 评估复杂度，不过度设计
