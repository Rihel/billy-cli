# Billy Agent Skills

> **工程首要准则**：见仓库根 [`AGENTS.md`](../AGENTS.md)（实事求是、抓主要矛盾等 8 条，
> 统摄一切开发活动）与 [`billy-dev-foundation/references/principles.md`](./billy-dev-foundation/references/principles.md)（落地展开）。

本仓库为 AI 编码 Agent 提供的一套 skill 指令，规范在 Billy 全栈工程中的开发方式。
每个 skill 是一个独立目录，内含 `SKILL.md`（标准 Agent Skills 格式：YAML frontmatter
的 `name` + `description`，description 用于触发匹配）。

## 加载顺序

| 顺序 | Skill | 用途 |
| --- | --- | --- |
| **必读** | [`billy-dev-foundation`](./billy-dev-foundation/SKILL.md) | 开发基础规范与流程：分层架构、代码约定（含「不重复造轮子」实现查找顺序）、常用命令、标准流程；详情拆分在 `billy-dev-foundation/references/`（architecture / code-conventions / commands / workflow） |
| 功能 | [`define-dict-enum`](./define-dict-enum/SKILL.md) | 定义字典、枚举（错误码 / 状态 / 类型 / 下拉选项） |
| 功能 | [`define-data-structure`](./define-data-structure/SKILL.md) | 定义数据结构：数据库表（TypeORM 实体）、共享契约（Zod schema） |
| 功能 | [`develop-business-module`](./develop-business-module/SKILL.md) | 开发完整业务模块（契约 → 数据 → 业务 → 接口 → SDK → 页面） |
| 功能 | [`develop-frontend-page`](./develop-frontend-page/SKILL.md) | 开发前端页面（Admin 后台 @repo/ui + TanStack / Web 前台 shadcn + Server Actions） |
| 功能 | [`implement-auth`](./implement-auth/SKILL.md) | 认证与权限（登录注册、token/cookie、路由守卫、双体系） |
| 功能 | [`object-storage`](./object-storage/SKILL.md) | 对象存储与文件上传下载（S3/COS、预签名、STS） |
| 功能 | [`concurrency`](./concurrency/SKILL.md) | 高并发与一致性（缓存、限流、幂等、分布式锁） |
| 功能 | [`queue`](./queue/SKILL.md) | 异步队列与延迟任务（BullMQ QueueManager） |
| 功能 | [`scheduler`](./scheduler/SKILL.md) | 定时调度（croner Scheduler） |
| 功能 | [`stream`](./stream/SKILL.md) | 服务端推送 SSE（StreamHub 推流 + HttpStreamClient 客户端） |
| 功能 | [`state-machine`](./state-machine/SKILL.md) | 业务状态机（字典+转移表 / xstate、并发安全） |
| 功能 | [`write-tests`](./write-tests/SKILL.md) | 单元测试（vitest 结构与 mock 模式） |
| 功能 | [`git-workflow`](./git-workflow/SKILL.md) | Git 提交与工作流（中文 commit 规范、辅助提交） |
| 元 | [`manage-skills`](./manage-skills/SKILL.md) | 新增 / 维护工程 Skill（目录规范、frontmatter、references 拆分、索引注册） |

## 使用规则

1. **任何开发任务开始前，先加载必读 skill `billy-dev-foundation`**——它是加载入口，
   内含「Skill 目录」：工程全部 skill 的用途与加载时机总索引（下表仅为速览）。
2. 根据任务类型选择功能 skill，完整列表与「何时加载」以 `billy-dev-foundation` 的
   「Skill 目录」为准（字典/枚举 → `define-dict-enum`；表/schema → `define-data-structure`；
   完整模块 → `develop-business-module`；页面 → `develop-frontend-page`；认证 →
   `implement-auth`；测试 → `write-tests`；提交 → `git-workflow`；维护 skill → `manage-skills`）。
3. 各 skill 的代码片段以仓库内真实文件为参考实现（见各 skill 内「参考实现」），
   拿不准时直接读原文件，不要凭印象写。
