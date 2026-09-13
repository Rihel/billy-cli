# 执行策略：同步 or 异步（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 决定接口「当场返回」还是「投递异步」时必读（异步的防重见 [idempotency.md](./idempotency.md)）。

考虑什么：每个操作先定执行策略——**必须当场返回结果、调用方在等待** 且操作轻量 → 同步直出；
**重 / 慢 / 可延后 / 失败需重试 / 需要削峰 / 需要补偿** → 异步化。别把慢操作硬塞同步
（拖垮请求、易超时），也别为轻操作引入异步复杂度（排查与一致成本更高）。

仓库真实决策参考：
- 请求关键路径上的轻操作 → 同步（绝大多数 service 方法）。
- 不影响响应、可失败可延后的旁路 → fire-and-forget 异步：如全局
  `AppExceptionFilter` 里告警 `AlertTrigger.notifyError`（经 `ERROR_ALERT_HOOK` 注入，
  注释「告警链路异常不影响返回」），失败不拖累主响应。
- 长任务 / 慢操作 / 削峰 → 投 `QueueManager`（`addJob` 生产者 / `registerWorker` 消费者，
  失败自动重试，见 `queue` skill）；消费者必须幂等。
- 进度反馈 → 配合 `stream` skill（SSE）按身份 / 业务频道推任务进度。
- 定时补偿 / 兜底 → `Scheduler`（见 `scheduler` skill；多实例配分布式锁互斥，见 `concurrency`）。

判断问题清单：
- 调用方能否接受等待？等不了 / 会超时 → 异步。
- 失败影响面：主流程失败必须当场告知 → 同步报错；可重试 / 可后补 → 异步 + 重试。
- 瞬时并发大 → 异步排队削峰 + 限流（`concurrency`）。
- 一致性要求：强一致 → 同步事务；最终一致可接受 → 异步收敛（处理器幂等 + 重试）。

检查项：写完接口能答「为什么同步 / 为什么异步」；异步的消费者幂等、重试与失败路径已闭环。
