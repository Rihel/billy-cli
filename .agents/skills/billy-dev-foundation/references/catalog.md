# Skill 目录（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，承载**完整 Skill 索引**。
> 主文件指引到本文件；新增 skill 时在此登记一行（与 `.agents/skills/README.md` 同步）。

| Skill | 用途 | 何时加载 |
| --- | --- | --- |
| [`define-dict-enum`](../../define-dict-enum/SKILL.md) | 定义字典、枚举：错误码 / 状态 / 类型 / 下拉选项，接入实体、schema 与前端展示 | 新增或修改字典、枚举、错误码时 |
| [`define-data-structure`](../../define-data-structure/SKILL.md) | 定义数据结构：数据库表（TypeORM 实体）+ 共享契约（Zod schema），双轨同步与迁移 | 建表、加字段、新增 / 修改 schema / DTO / 模型、跑迁移时 |
| [`database`](../../database/SKILL.md) | PostgreSQL / TypeORM 数据库开发手册：表建模、索引设计、查询写法、数据访问层（repository / 事务 / 软删），含常用操作命令 | 建表设计、索引、写查询 / repository、数据库操作时 |
| [`develop-business-module`](../../develop-business-module/SKILL.md) | 开发完整业务模块：契约 → 数据 → 业务 → 接口 → SDK → 页面全链路 | 新增模块、新功能、CRUD、业务接口、列表 / 表单页时 |
| [`develop-backend-api`](../../develop-backend-api/SKILL.md) | 后端接口开发的质量维度：幂等 / 鲁棒 / 安全 / 一致 + 执行策略（同步 / 异步）、可观测性、性能与契约演进、可测试性 | 开发 / 修改后端接口、接口质量自查时 |
| [`develop-ai-agent`](../../develop-ai-agent/SKILL.md) | 开发 AI 能力（`modules/ai`）：agent / 工具组（`@ToolGroup` + 方法级 `@ToolDecl`：规划、子 agent、取页）/ 技能 / eta 提示词 / 会话运行时间线落库 / SSE 流式协议 / 动态子 agent / 上下文压缩 / 崩溃恢复 | 改 AI 模块、加 agent / 工具 / 技能、动流式协议或落库时 |
| [`develop-frontend-page`](../../develop-frontend-page/SKILL.md) | 开发前端页面：Admin 后台（@repo/ui 的 DataTable / ModalForm / 存储组件 + TanStack Table/Form）+ Web 前台（shadcn / Server Actions）；视觉取值走 @repo/ui 设计系统 token | 写页面、列表 / 表单、组件、Server Action、设计系统 / token / 主题时 |
| [`implement-auth`](../../implement-auth/SKILL.md) | 认证与权限：登录 / 注册 / 找回密码、token 与 cookie、路由守卫、用户 / 管理员双体系 | 登录注册、鉴权、权限、守卫、token 相关任务时 |
| [`object-storage`](../../object-storage/SKILL.md) | 对象存储与文件上传下载：S3/COS 门面、预签名 URL、STS、FileUpload / ImageUpload | 文件上传 / 下载 / 图片存储时 |
| [`concurrency`](../../concurrency/SKILL.md) | 高并发与一致性：缓存 / 限流 / 幂等 / 分布式锁（RedisStore） | 高并发、缓存、限流、幂等、分布式锁时 |
| [`kafka`](../../kafka/SKILL.md) | 异步消息与事件：KafkaService 生产者 / @KafkaConsumer 消费者、topic 与消费组约定、at-least-once 幂等 | 异步、消息队列、事件驱动、削峰解耦、MQ、Kafka 时 |
| [`scheduler`](../../scheduler/SKILL.md) | 定时调度：Scheduler（croner）的 cron / interval / timeout | 定时任务、调度、cron、周期任务时 |
| [`stream`](../../stream/SKILL.md) | 服务端推送（SSE）：StreamHub 推流 + HttpStreamClient 客户端、频道与权限、跨实例广播 | SSE、实时推送、推流、任务进度、实时通知时 |
| [`telemetry`](../../telemetry/SKILL.md) | 遥测埋点：Telemetry 门面（Counter / Gauge / Histogram 窗口聚合 + snapshot 环比）、指标命名、框架自动埋点与业务埋点、metric / surge 告警 | 埋点、指标、监控、metric、分位、指标告警、环比时 |
| [`notification`](../../notification/SKILL.md) | 通知：Notifier 编排门面 + FileClient / LarkNotifyClient / EmailClient 三通道、配置与未配置降级、失败处理 | 发通知、邮件 / SMTP、飞书通知、告警通知时 |
| [`lark`](../../lark/SKILL.md) | 飞书（Lark / Feishu）：LarkClient 门面（官方 SDK 封装）、应用配置、可选装配与优雅降级、调用完整 API | 飞书、Lark、飞书机器人、im.message、开放平台时 |
| [`state-machine`](../../state-machine/SKILL.md) | 业务状态机：状态字典 + 转移表纯函数（或 xstate 门面）、并发安全 | 订单状态、审批流、状态流转时 |
| [`write-tests`](../../write-tests/SKILL.md) | 编写单元测试：vitest 结构与 mock 模式、service / repository 测试套路 | 写测试、补单测、修测试时 |
| [`git-workflow`](../../git-workflow/SKILL.md) | Git 提交与工作流：中文 commit 类型规范、提交粒度、辅助提交流程 | 提交、commit、辅助提交、提交信息时 |
| [`codegraph`](../../codegraph/SKILL.md) | 代码图谱工具：MCP codegraph_explore + CLI（query / node / callers / callees / impact / affected）查符号、调用链、影响面，验证分层依赖方向 | 理解架构、调用关系、依赖方向、改动影响面、代码理解时 |
| [`manage-skills`](../../manage-skills/SKILL.md) | 新增 / 维护工程 Skill：目录与 frontmatter 规范、references 拆分、索引注册 | 添加、新建、维护、拆分 skill 时 |
