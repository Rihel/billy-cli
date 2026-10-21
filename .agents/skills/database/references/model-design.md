# 表建模：数据库如何设计（database 引用文件）

> 本文件是 `database` skill 的组成部分，由主 SKILL.md 引用。
> 建表 / 加字段 / 设计新数据结构前必读；实体 ↔ schema 双轨与迁移的执行步骤见
> `define-data-structure`，此处讲「设计决策与为什么」。

## 1. 一张表 = 一个业务聚合

- 先有业务对象与数据结构（`packages/shared/src/schema/`），再落实体——schema 是前后端数据结构，
  实体是落库形状，两者字段必须一致（双轨，见 `define-data-structure`）。
- 表名复数（`users` / `admins` / `alert_logs`），实体类 `XxxEntity`，文件
  `apps/server/src/database/entities/<name>-entity.ts`。
- 参考实现（照抄风格即可，不要自创）：`user-entity.ts`（唯一约束含软删）、`admin-entity.ts`。

## 2. 继承 BaseEntity，别重复造轮子

`@repo/kits` 的 `BaseEntity`（`packages/kits/src/db/base-entity.ts`）已提供：

- `id`：varchar(20) 主键，`@BeforeInsert` 用 nanoid 生成——**不要**自增 id
  （客户端 / 分布式可生成、不暴露顺序与总量）。
- `createdAt` / `updatedAt`：timestamp(3)，插入 / 更新自动维护（`save` 会刷新）。
- `deletedAt`：软删列，见下节。

实体里**不要重复声明**这些字段；只声明业务列。实体只做映射与约束，不写业务逻辑。

## 3. 字段类型选择（按仓库现状）

| 场景 | 类型 | 说明 |
| --- | --- | --- |
| 无长度上限文本（title / description / email / password） | `text` | 仓库主流的写法 |
| 固定长度短值（status 等枚举串） | `varchar(length)` + `default` + `comment`（中文注释） | 例：`status varchar(20) default UserStatus.Enabled comment '用户状态'` |
| 布尔 | `boolean` + `default: false` | 例：alert_rule.enabled |
| 时间 | `timestamp` + `precision: 3` | BaseEntity 之外的时间列（如 `reset_password_token_expiry`） |
| 状态 / 类型等枚举 | **string 列存字典 value**，不用 PG enum | 改值 / 迁移友好；见 `define-dict-enum` |

规则：
- 可空列必须 `nullable: true` 并给初始值（`= null` / `= false`），避免 TS 严格空检查噪音。
- 有意义的默认值放 DB 层（`default`），不要让代码每次显式补。
- 枚举字段的 `default` 引用字典值（`UserStatus.Enabled`），不要裸写字符串。

## 4. 唯一约束与软删的配合（容易踩的坑）

- 业务唯一键（邮箱、名称等）建 `@Unique('uk_<表>_<列>', [...])` 显式命名。
- **软删表必须把 `deletedAt` 纳入唯一键**：TypeORM 的 `remove()` 只是把 `deleted_at`
  置时间（软删），记录仍占着唯一值；不加 `deletedAt` 的话，删掉后无法重建同名记录。
  现有写法（user / admin）：
  ```ts
  @Unique('uk_user_email', ['email', 'deletedAt'])
  ```
- 唯一约束是幂等与并发兜底（重复插入在 DB 层被拒），不是可有可无的装饰。

## 5. 软删除的取舍

- 默认用软删（BaseEntity 自带）：可恢复、保留审计痕迹、历史关联（如外键引用）不失效。
- `remove()` 走软删；`findOneBy` / `find` 默认**过滤掉已软删行**。
- 业务上确实要物理删除的场景（日志清理、可丢弃的大表）再考虑硬删，且要有明确的清理任务
  （配 `scheduler` 或 `kafka` 定期处理）。

## 6. 演进原则

- **加字段**成本低：新列给 `nullable` / `default`，一次迁移搞定（流程见 `define-data-structure`）。
- **删字段 / 改类型**成本高：先查引用（`grep` 实体、schema、service、SDK、前端）与存量数据，
  确认无依赖再动；迁移 SQL 生成后必须人工检查（TypeORM 有时会重建整表）。
- 判断「加字段 vs 新表」：同一生命周期、强关联、总是同查 → 同表加字段；
  独立生命周期、可能各自膨胀 → 拆表，别让一张表无限堆列。

检查项：字段类型与可空 / 默认符合上表；唯一键含 `deletedAt`；实体 ↔ schema 字段一致；
列名 snake_case、索引 / 约束显式命名；迁移 SQL 人工看过再执行。
