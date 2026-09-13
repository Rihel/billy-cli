---
name: define-data-structure
description: 在 Billy 工程中定义数据结构：数据库表（TypeORM 实体）与共享契约（Zod schema / DTO / 模型），并保证两轨同步、正确注册与生成迁移。触发词：定义数据结构、建表、加字段、数据库表、schema、DTO、模型、实体、Entity、迁移、db:gen。
---

# 定义数据结构：数据库表、schema

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序见其
`references/code-conventions.md` 第 10 条）。

## 核心要点

- **双轨制**：数据库表（`apps/server/src/database/entities/<name>-entity.ts`，TypeORM 实体）+
  共享契约（`packages/shared/src/schema/<name>.schema.ts`，Zod），两轨字段必须一致。
- 实体继承 `BaseEntity`（来自 `@repo/kits`，自动 id / 时间戳 / 软删除）；表名复数；
  列名 snake_case；索引 / 唯一约束显式命名 `idx_*` / `uk_*`。
- 契约命名（硬性）：schema 常量一律 `Schema` 结尾（值后缀）；入参类型 `XxxDto`、响应类型
  `XxxModel`（类型后缀），两者 `z.infer` 导出在**同一文件**；`z.enum` 值域只导出 `XxxSchema`。
- DTO 命名：`CreateXxx` / `UpdateXxx` / `GetDetailXxx` / `RemoveXxx` / `PageQueryXxx` /
  `CursorQueryXxx`，均 `z.infer` 出 `XxxDto` 类型。
- 注册 + 迁移：实体在 `apps/server/src/root.module.ts` 的 `DbModule.forRootAsync` 工厂里补进
  `entities: [ ... ]` → `pnpm db:gen <Name>` →
  人工检查 SQL → `pnpm db:migrate`。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/structure-guide.md](./references/structure-guide.md) | 实体规范、契约规范（模型 / DTO / 分页）、注册与迁移、同步清单 | 建表 / 改字段 / 写 schema / 跑迁移时（必读） |

## 完成检查清单

- [ ] 已按「实现查找顺序」确认 entities / schema 下同类结构可复用（不重复造轮子）
- [ ] 命名合规：schema 常量 `XxxSchema` 结尾，入参类型 `XxxDto`、响应类型 `XxxModel` 同文件导出，无「常量用 Dto 后缀」写法
- [ ] 实体 ↔ schema 字段名、类型、可空 / 默认值一致
- [ ] 实体已在 `apps/server/src/root.module.ts` 的 `DbModule.forRootAsync` 工厂里注入（`entities: [...]`）；schema 已注册 `schema/index.ts`
- [ ] 已生成 + 人工检查 + 执行迁移；删除字段前确认无数据依赖
- [ ] 游标分页的表有 `(updatedAt, id)` 顺序索引
