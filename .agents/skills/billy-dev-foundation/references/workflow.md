# 标准开发流程与参考实现（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> 任务执行过程中按此流程推进，结束时对照主 SKILL.md 的「完成检查清单」自查。

## 标准开发流程

> 动手前先按 `design.md` 评估难度：简单需求直接走下面流程；中等 / 复杂需求先出
> 设计落地方案（落点 + 关键数据结构 + 关键流程 + 测试点），再实现。

1. **读需求，拆落点**：明确涉及哪些层（契约 / 数据 / 业务 / 接口 / SDK / 页面），
   同时按 `code-conventions.md` 第 10 条的「实现查找顺序」盘点各层现成实现，
   避免重复造轮子。
2. **契约先行**：先定义 `@repo/shared` 的 schema 与 dict（含错误码），这是前后端共同的语言。
3. **自底向上实现**：实体（db）→ 迁移 → repository / service / errors（core）→ DI 注册 →
   Hono 路由（server）→ SDK → 前端页面。
4. **验证**：`pnpm dev:pkgs` 确保包构建通过 → `pnpm dev:server` 起服务 →
   `curl -X POST http://localhost:9989/...` 或前端页面自测 → 迁移正确执行。
5. **收尾**：对照主 SKILL.md 的「完成检查清单」自查，确认没有遗漏注册 / 导出。

## 参考实现

- **完整 CRUD 最小链路**：todo 模块——schema
  `packages/shared/src/schema/todo.schema.ts` → 实体
  `packages/db/src/entities/todo-entity.ts` → core
  `packages/core/src/modules/todo/*` → 路由 `apps/server/src/features/todo.ts` → SDK
  `packages/sdk/src/server.client.ts` → admin 页
  `apps/admin/src/app/main/todo/page.tsx`。
- **架构决策与历史**：`README.md`、`docs/sdk-refactor.md`（API 客户端职责划分）。
