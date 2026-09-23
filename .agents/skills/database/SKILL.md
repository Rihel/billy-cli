---
name: database
description: 在 Billy 工程中使用 PostgreSQL / TypeORM 做数据库设计与开发：表建模（字段类型 / 约束 / 软删除 / 命名）、索引设计（何时建 / 组合与游标索引 / ILIKE 与索引失效 / EXPLAIN 验证）、查询写法（queryBuilder / 绑定参数 / 分页与游标 / 批量写入 / 防 N+1）、数据访问层（repository / 事务 / 软删行为 / 并发安全），含日常操作命令速查。触发词：数据库、建表、表设计、字段类型、索引、唯一约束、软删除、查询、repository、TypeORM、queryBuilder、分页、游标、批量、批量插入、批量更新、upsert、事务、迁移、psql、EXPLAIN、N+1、SQL、数据访问。
---

# 数据库设计与开发（PostgreSQL / TypeORM）

前置：先加载必读 skill `billy-dev-foundation`。**新增 / 修改表结构的落地步骤
（实体 ↔ schema 双轨、注册、`db:gen` / `db:migrate`）见 `define-data-structure`**，
本 skill 是数据库主题的开发手册：怎么设计表、怎么定索引、怎么写查询、repository 层怎么写。

## DB 底座（仓库事实）

| 项 | 内容 |
| --- | --- |
| 数据库 | PostgreSQL 17：`docker compose up postgres`（宿主 15432，root/pg1234/billy-cli）；`pnpm bootstrap` 可一键起依赖 + 生成 .env + 迁移 |
| ORM | TypeORM；CLI 迁移用 `apps/server/data-source.ts`（glob 实体与迁移，`synchronize: false`，迁移 SQL 需人工检查） |
| 实体 | 继承 `@repo/kits` 的 `BaseEntity`（`packages/kits/src/db/base-entity.ts`）：`id` varchar(20)（nanoid，`@BeforeInsert` 生成）+ `createdAt` / `updatedAt` / `deletedAt`（timestamp(3)，软删） |
| 数据入口 | 业务 repository 注入 **`Db`** + 调纯函数（当前业务统一写法，见 `apps/server/src/modules/todo/todo.repository.ts`）；kits 另提供注入式门面 **`DbService`**（`@repo/kits` `db/db.service.ts`，由 `DbModule` 装配且 `@Global`）：与纯函数同名同参，自动带默认 manager 与操作人，需要时 `@Inject(DbService)` 直接用。纯函数内核（`pagination.ts` / `batch.ts` / `safe-delete.ts` / `sql.ts`）脱离 DI 时也可直接用 |
| 分页 | `DbService.pageWith` / `pageWithDeferred` / `cursorPageWith` / `cursorPageWithDeferred`（`db/pagination.ts`）：offset 页 / 两阶段 offset / 游标 / 两阶段游标 |
| 批量写入 | `DbService.batchInsert` / `batchSave` / `batchUpsert` / `batchDelete` / `batch`：**事务内自动降为串行**，部分失败聚合抛 `BatchOperationError` |
| 软删审计 | `DbService.safeDelete(entity, where)`：操作人默认取 `getAuditUser()`（`setAuditUserProvider` 挂的钩子），可显式覆盖；**先写 `deletedBy` 再软删** |
| SQL 调试 | `DbService.getFullSqlStatement(builder)` 或同名纯函数：把占位符还原成可粘贴执行的完整 SQL；**要打日志由调用方用自己注入的 `AppLogger` 打**（`DbService` 不注入 logger） |
| 事务 | `typeorm-transactional`：service 层写方法 `@Transactional()`（`import { Transactional } from '@repo/kits'`） |
| 外键 | **硬规则：绝对不加物理外键**（`@ManyToOne` / `@JoinColumn` / 迁移里的 `FOREIGN KEY` 一律不用）。关联字段只建普通索引，关系由应用层维护；理由：高写入量表的 FK 检查是纯开销、写入顺序耦合、软删下级联语义本就不需要，且全库统一（既有表 0 个外键）。代价是可能出现孤儿行 —— 由写入口保证不发生，不能靠数据库兜底 |
| **软删表的唯一约束必须带 `WHERE deleted_at IS NULL`** | 软删行还在表里，普通唯一索引会把历史行算进去 —— 删掉一个再建同名的直接撞唯一键（`ai_providers.name` / `ai_models.(provider_id, model_key)` 就是部分唯一索引） |

## 常用命令（速查）

- 起库：`docker compose up postgres`；直连查询
  `psql 'postgresql://root:pg1234@localhost:15432/billy-cli'`
  或 `docker compose exec postgres psql -U root -d billy-cli`
- 结构变更：`pnpm db:gen <Name>`（依实体与库差异生成迁移，**人工检查 SQL**）→ `pnpm db:migrate` 执行
- 种子：`pnpm seed:admin`（首个管理员，幂等——靠邮箱唯一约束兜底）
- 验证查询：psql 里 `EXPLAIN (ANALYZE, BUFFERS) <sql>`
- **建表只走迁移**：`docker/init-db.sql` 只放库级设置（扩展等），**禁止往里加建表 DDL**。
  历史教训：它曾照 drizzle 时代的迁移建过 `todos` / `users` / `admins`，而 TypeORM 的 initial
  迁移是裸 `CREATE TABLE`（无 `IF NOT EXISTS`），于是**全新数据卷**上
  `docker compose up postgres` → `pnpm db:migrate` 会报 `relation "todos" already exists`。

## 与既有 skill 的分工

| 场景 | 用哪个 |
| --- | --- |
| 表结构 / schema / 迁移的落地步骤 | `define-data-structure` |
| 新模块 repository / service 代码模板 | `develop-business-module` |
| 接口质量（查询性能 / 契约演进等） | `develop-backend-api` |
| 枚举列 / 状态字段（string 列存字典 value） | `define-dict-enum` |

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/model-design.md](./references/model-design.md) | 表怎么设计：字段类型 / 约束 / 软删 / 演进 | 建表、加字段前 |
| [references/indexing.md](./references/indexing.md) | 索引怎么搞：何时建 / 组合与游标 / ILIKE 失效 / EXPLAIN | 加索引、验证查询时 |
| [references/query.md](./references/query.md) | 查询怎么写：queryBuilder / 绑定参数 / 分页 / 防 N+1 | 写查询时 |
| [references/data-access.md](./references/data-access.md) | repository 层：写操作模式 / 事务 / 软删行为 / 并发 | 写数据访问层时 |

## 完成检查清单（数据库相关交付前）

- [ ] 实体已继承 `BaseEntity`，未重复声明 id / 时间戳；表名复数、列名 snake_case、可空列有初始值
- [ ] 唯一业务键建 `uk_*`（软删表把 `deletedAt` 纳入唯一键）；查询路径有对应索引（游标配 `(updatedAt, id)`），显式命名 `idx_*`
- [ ] 查询参数化（绑定参数）、排序列走 DTO 白名单；无循环内查库（防 N+1）
- [ ] 写操作在 service 层 `@Transactional()`；迁移 SQL 已人工检查后执行
