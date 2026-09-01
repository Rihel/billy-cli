# Skill 目录（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，承载**完整 Skill 索引**。
> 主文件指引到本文件；新增 skill 时在此登记一行（与 `.agents/skills/README.md` 同步）。

| Skill | 用途 | 何时加载 |
| --- | --- | --- |
| [`define-dict-enum`](../../define-dict-enum/SKILL.md) | 定义字典、枚举：错误码 / 状态 / 类型 / 下拉选项，接入实体、schema 与前端展示 | 新增或修改字典、枚举、错误码时 |
| [`define-data-structure`](../../define-data-structure/SKILL.md) | 定义数据结构：数据库表（TypeORM 实体）+ 共享契约（Zod schema），双轨同步与迁移 | 建表、加字段、新增 / 修改 schema / DTO / 模型、跑迁移时 |
| [`develop-business-module`](../../develop-business-module/SKILL.md) | 开发完整业务模块：契约 → 数据 → 业务 → 接口 → SDK → 页面全链路 | 新增模块、新功能、CRUD、业务接口、列表 / 表单页时 |
| [`develop-frontend-page`](../../develop-frontend-page/SKILL.md) | 开发前端页面：Admin 后台（@repo/ui 的 DataTable / ModalForm / 存储组件 + TanStack Table/Form）+ Web 前台（shadcn / Server Actions） | 写页面、列表 / 表单、组件、Server Action 时 |
| [`implement-auth`](../../implement-auth/SKILL.md) | 认证与权限：登录 / 注册 / 找回密码、token 与 cookie、路由守卫、用户 / 管理员双体系 | 登录注册、鉴权、权限、守卫、token 相关任务时 |
| [`object-storage`](../../object-storage/SKILL.md) | 对象存储与文件上传下载：S3/COS 门面、预签名 URL、STS、FileUpload / ImageUpload | 文件上传 / 下载 / 图片存储时 |
| [`concurrency`](../../concurrency/SKILL.md) | 高并发与一致性：缓存 / 限流 / 幂等 / 分布式锁（RedisStore） | 高并发、缓存、限流、幂等、分布式锁时 |
| [`queue`](../../queue/SKILL.md) | 异步队列与延迟任务：QueueManager（BullMQ）的生产者 / 消费者 | 异步任务、队列、延迟任务、消息时 |
| [`scheduler`](../../scheduler/SKILL.md) | 定时调度：Scheduler（croner）的 cron / interval / timeout | 定时任务、调度、cron、周期任务时 |
| [`stream`](../../stream/SKILL.md) | 服务端推送（SSE）：StreamHub 推流 + HttpStreamClient 客户端、频道与权限、跨实例广播 | SSE、实时推送、推流、任务进度、实时通知时 |
| [`state-machine`](../../state-machine/SKILL.md) | 业务状态机：状态字典 + 转移表纯函数（或 xstate 门面）、并发安全 | 订单状态、审批流、状态流转时 |
| [`write-tests`](../../write-tests/SKILL.md) | 编写单元测试：vitest 结构与 mock 模式、service / repository 测试套路 | 写测试、补单测、修测试时 |
| [`git-workflow`](../../git-workflow/SKILL.md) | Git 提交与工作流：中文 commit 类型规范、提交粒度、辅助提交流程 | 提交、commit、辅助提交、提交信息时 |
| [`manage-skills`](../../manage-skills/SKILL.md) | 新增 / 维护工程 Skill：目录与 frontmatter 规范、references 拆分、索引注册 | 添加、新建、维护、拆分 skill 时 |
