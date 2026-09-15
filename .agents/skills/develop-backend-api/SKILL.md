---
name: develop-backend-api
description: 在 Billy 工程中开发 / 修改后端接口（service / repository / NestJS controller / SDK）时的质量维度与工程检查：幂等性（防重 / 重试 / 幂等键与锁）、鲁棒性（入参契约校验 / 边界与空值 / 错误码与响应契约）、安全性（鉴权三选 / 越权 / 敏感数据 / 限流 / 文件 key）、一致性（事务 / 并发读改写 / 缓存失效 / 最终一致）、执行策略（并发场景同步直出 or 异步化 / 队列与补偿）、可观测性（业务日志事件 / requestId 排障 / 指标与告警）、性能与查询效率（分页与索引 / 防 N+1 / 缓存）、契约演进与兼容（全链路同步 / 删改字段评估）、可测试性（分层与依赖注入 / 纯函数 / 错误可断言），并给出错误路径自测清单。触发词：后端接口、写接口、加接口、接口开发、后端开发、接口质量、幂等、防重、鲁棒、健壮、接口安全、越权、一致性、同步、异步、异步化、队列化、可观测、日志、指标、告警、requestId、性能、慢查询、N+1、缓存、契约、兼容、SDK 同步、可测试、单测、mock、错误处理。
---

# 后端接口开发（质量维度）

前置：先加载必读 skill `billy-dev-foundation`（分层铁律 / 代码约定见其 references）。
**新建完整业务模块的流程与代码模板见 `develop-business-module`，本 skill 不重复模板**，
只回答「接口怎么写得稳」：每个后端接口（含既有接口修改）交付前，过一遍
**幂等 / 鲁棒 / 安全 / 一致** 四维检查，并明确**执行策略（同步 or 异步）**与
**可测试性**；涉及具体能力时按需加载对应 skill。

## 核心要点（详情与仓库落点见参考文件）

- **幂等性**：先明确接口的幂等语义（重复调用 = 忽略 / 报错 / 返回首次结果）；
  短临界防重靠 `RedisStore` 的锁与幂等键（`concurrency`）；队列消费者失败自动重试 →
  处理器必须幂等（`kafka`）；DB 唯一约束兜底（`uk_*` 含 `deletedAt`）。
- **鲁棒性**：入参一律走共享 Zod 契约（`@Body({ schema: Schema })` 校验失败 body `code: 400`）；
  查无 / 空值用「先查后改 + 抛已注册 `AppError`」唯一路径，不裸 return null；
  分页 `size` 契约已限 `max(100)`；未知错误由全局兜底为 `5001 系统错误`——别抛裸 Error。
- **安全性**：鉴权显式三选（公开 / `@UseGuards(UserAuthGuard)` / `@UseGuards(AdminAuthGuard)`），不默认裸奔；
  资源操作校验归属防水平 / 垂直越权（`requestContext.get('userId' | 'adminId')`）；
  敏感字段不进响应 / 日志；登录等敏感接口加限流（`@UseGuards(RateLimitGuard)` +
  `@RateLimit({ scope })`）；文件 key 不信任前端任意值。
- **一致性**：写操作加 `@Transactional()`（`import { Transactional } from '@repo/kits'`）；
  状态 / 计数类并发变更用乐观锁或分布式锁（`state-machine` / `concurrency`），杜绝裸「读-改-写」；
  缓存写后失效；异步化靠处理器幂等 + 重试收敛最终一致。
- **执行策略（同步 or 异步）**：先回答「必须当场返回结果吗」——必须且轻 → 同步直出；
  重 / 慢 / 可延后 / 需重试 / 需削峰 → 异步化（`kafka` 投递 + 消费者幂等 + `stream` 推进度 +
  `scheduler` 兜底补偿）；旁路失败不影响响应可 fire-and-forget（参考 main.ts 告警）。
  别把慢操作硬塞同步，也别为轻操作引入异步复杂度。
- **可测试性**：写接口时同步设计「怎么测」：controller 薄、业务在 service（构造器注入依赖可 mock）、
  规则抽纯函数；错误走 AppError code 契约可断言；测试套路见 `write-tests`。
- **可观测性**：请求链路日志全局已处理（`common/request-logger` 的中间件记录 method / url /
  status / 耗时 / requestId / userId / adminId，日志 `requestId` 即响应头 `X-Request-Id`，
  排障按它关联），不要自写请求日志；关键业务动作记结构化事件
  （构造器注入 `AppLogger` + `logger.log('<域>.<动作>', {...})`，参考 todo）；错误由
  `AppExceptionFilter` 统一映射 + 告警，不自行吞掉。
- **性能与查询效率**：列表先想查询计划——量小 `pageWith`，量大 / 深翻页 `cursorPageWith`
  （配 `(updatedAt, id)` 索引）；`ILIKE '%kw%'` 量大无法走索引需另评估；循环里不逐条查库
  （防 N+1）；读多写少可 `setJson` 缓存；响应经 `toXxx()` 裁剪，不整表外抛。
- **契约演进与兼容**：改契约 = 全链路同步（shared schema → 实体 → service 用法 → SDK →
  调用方，`pnpm dev:pkgs` 重建）；加字段给 default / optional；删字段 / 改类型 / 放宽防滥用
  约束（如 `size` 的 `max(100)`）先查引用与存量数据。

## 与既有 skill 的分工（不重复造轮子）

| 场景 | 用哪个 |
| --- | --- |
| 从 0 建业务模块（流程 + 代码模板） | `develop-business-module` |
| 表 / schema / 迁移 / DTO | `define-data-structure` |
| 错误码 / 字典 / 枚举 | `define-dict-enum` |
| 鉴权守卫 / token / 双体系实现 | `implement-auth` |
| 锁 / 限流 / 缓存 / 幂等原语 | `concurrency` |
| 队列 / 定时 / SSE / 状态机 | `kafka` / `scheduler` / `stream` / `state-machine` |
| 接口单元测试 | `write-tests` |

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/response-contract.md](./references/response-contract.md) | 响应结构 / 错误映射与 HTTP 状态（地基） | 写任何接口前（必读） |
| [references/idempotency.md](./references/idempotency.md) | 防重 / 重试安全：锁、幂等键、唯一约束兜底 | 写会重复执行的写接口时 |
| [references/robustness.md](./references/robustness.md) | 入参契约校验 / 边界与查无路径 | 处理入参与边界时 |
| [references/security.md](./references/security.md) | 鉴权三选 / 越权 / 敏感数据 / 限流 / 文件 key | 加新路由、资源操作时 |
| [references/consistency.md](./references/consistency.md) | 事务 / 并发读改写 / 缓存失效 / 最终一致 | 写操作、状态变更时 |
| [references/execution-strategy.md](./references/execution-strategy.md) | 同步 or 异步选型：fire-and-forget / 队列 / 进度 / 补偿 | 决定执行策略时 |
| [references/observability.md](./references/observability.md) | requestId 排障 / 业务事件日志 / 告警 / 指标 | 需要日志与排查时 |
| [references/performance.md](./references/performance.md) | 分页与索引 / 防 N+1 / 缓存 / 响应裁剪 | 列表、详情、查询实现时 |
| [references/contract-evolution.md](./references/contract-evolution.md) | 契约全链路同步 / 删改字段纪律 | 改 schema / DTO / SDK 时 |
| [references/testability.md](./references/testability.md) | 分层 / 注入 mock / 纯函数 / 错误断言 | 设计可测的接口时 |
| [references/verification.md](./references/verification.md) | curl 自测步骤与错误路径抽查 | 接口交付前 |

## 完成检查清单（接口交付前）

- [ ] 已确定幂等语义；重复提交 / 重试 / 双击路径有明确行为（锁 / 幂等键 / 唯一约束兜底）
- [ ] 已明确执行策略：同步直出 or 异步化（`kafka` + 消费者幂等 + `stream` 进度 / `scheduler` 补偿），
  能答「为什么同步 / 为什么异步」；未把慢操作硬塞同步，也未为轻操作引入异步复杂度
- [ ] 入参全走共享契约校验；查无 / 无权限 / 参数非法均抛带 code 的 `AppError`，无裸 Error / null 泄漏
- [ ] 鉴权已显式选择；资源归属已校验（防越权）；敏感数据未进响应与日志
- [ ] 写操作已加 `@Transactional()`；状态 / 计数变更无裸「读-改-写」；缓存写后已失效
- [ ] 关键写动作有 `logger.log('<域>.<动作>')` 业务事件；异常能被日志 / 告警覆盖，日志无敏感信息
- [ ] 列表 / 详情已选对分页与索引（游标 + `(updatedAt, id)`），无 N+1 / 深翻页 / 整表外抛
- [ ] 契约改动（schema / DTO / SDK）已全链路同步在同一变更内；删字段 / 放宽约束前已查引用
- [ ] 分层与注入可测：service 核心分支（成功 / 查无 / 无权限 / 非法输入）有单测覆盖（`write-tests`）
- [ ] 已 curl 自测错误路径（查无 / 无权限 / 非法参数 / 重复提交），断言 code 与 HTTP 状态
