# 接口变更与兼容（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 修改已有 schema / DTO / 实体 / SDK 时必读（改接口的纪律）。

考虑什么：schema / DTO 是前后端 + SDK 的公共数据结构，改动影响面大于「改一个文件」。
仓库落地：

- 数据结构改 = 全链路改：`packages/shared` schema → 实体（`define-data-structure`）→
  service / repository 用法 → SDK `server.client.ts` 段 → 页面调用方，**同一变更内完成**，
  并 `pnpm dev:pkgs` 重建（monorepo 内构建产物是共享的，不重建别的包拿不到新类型）。
- 加字段：给 default / optional（zod `optional().default()`），别让既有调用方因缺字段报错。
- 删字段 / 改类型：先查引用（`grep`）与存量数据（迁移），确认无依赖再动
  （`define-data-structure` checklist 同款要求）；错误码 / 枚举 value 不回收复用
  （`define-dict-enum`）。
- 防滥用约束别随手放宽：分页 `size` 的定义已 `min(1).max(100)`（`base.schema.ts`），
  扩大上限要评估服务端压力与限流。
- 复用数据结构基类：分页继承 `BasePaginateSchema` / `BaseCursorPaginateSchema`，不各自发明
  （「不重复造轮子」实现查找顺序）。
- 命名纪律：数据结构常量一律 `XxxSchema` 结尾，入参类型 `XxxDto`、响应类型 `XxxModel`，且类型
  `z.infer` 导出在**同一文件**；改名是破坏性变更，须按上面「数据结构改 = 全链路改」同批同步
  （`define-data-structure` 3.1）。

检查项：一次数据结构改动里 schema / 实体 / service / SDK / 调用方全部同步；删改字段前已查引用。
