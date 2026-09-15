# 一致性（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 写操作 / 事务 / 状态变更 / 缓存更新时必读。

- 事务：跨多行 / 多表的写操作方法加 `@Transactional()`
  （`import { Transactional } from '@repo/kits'`），参考 todo.service 的 create / update / remove；
  纯读不加。
- 并发读改写：状态流转 / 库存扣减 / 余额变更等「读-改-写」必须防并发——乐观锁（version 列）
  或分布式锁（原语见 `concurrency`，状态机见 `state-machine`），不裸奔。
- 缓存一致性：`setJson(key, val, ttl)` 写后要失效 / 删除对应缓存 key，防脏读。
- 最终一致：需要异步化的写（慢 / 跨服务）走队列，处理器幂等 + 失败重试收敛（`kafka`）；
  多实例定时任务用分布式锁互斥（`scheduler` + `concurrency`）；跨实例实时推送走 Redis
  pub/sub（`stream`）。

检查项：写操作都在事务里？状态 / 计数并发双击会怎样？缓存更新路径一致？
