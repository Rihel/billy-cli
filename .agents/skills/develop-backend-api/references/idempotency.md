# 幂等性（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 写 create / 扣减 / 投递 / 回调等会重复执行的写接口时必读。

考虑什么：重复点击、客户端重试、消息重投、Webhook 重推——同一请求重复执行不得叠加副作用。
仓库落地：

- 短临界防重：`RedisStore.acquireLock(key, ttl)` → 业务 `finally` 里
  `releaseLock(key, token)`（锁带 token 防误删他人锁）；或 `set NX` 幂等键 + 已处理标记
  （原语见 `concurrency` skill）。
- 纯计数 / 防重：`incr` + `expire`。
- 异步消费场景：Kafka 是 at-least-once（重平衡会重复投递）→ 处理器必须幂等（先查后写、按业务键去重），
  见 `kafka` skill。
- DB 兜底：业务唯一键建 `uk_*` 唯一约束（软删表把 `deletedAt` 纳入唯一键），重复插入在 DB 层被拒。
- 先查后改的 update / remove：重复调用第二次「查无」→ 抛 `XxxNotFoundError`。
  确认这是期望语义（幂等返回 / 报错二选一），别让调用方拿到不确定行为。

检查项：写接口都过一遍「同一请求连发两次」会怎样（含并发双击与失败重试）。
