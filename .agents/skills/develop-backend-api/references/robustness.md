# 鲁棒性（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 处理入参 / 边界 / 查无路径时必读。

- 入参契约：字段类型 / 长度 / 枚举全部由共享 Zod 契约约束（`z.string().min/max`、
  `z.enum` 用字典 value、`BasePaginateDto.size` 已 `min(1).max(100)`、分页默认值已定）；
  契约文件在 `packages/shared/src/schema/`，规范见 `define-data-structure`。
- 查无路径唯一化：repository `findOneBy` 返回 null → service 抛对应 `AppError`
  （如 `XxxNotFoundError`），不允许把 null / undefined 直接 return 出接口。
- 先查后改：update / remove 一律「`findOneBy` → 判空 → `Object.assign` + save / remove」，
  避免盲改（参考 todo repository）。
- 查询参数化：TypeORM `createQueryBuilder` 绑定参数 / 传 DTO，不拼 SQL；关键字用 `ILIKE`。
- 游标分页表配 `(updatedAt, id)` 顺序索引，防深分页慢查询。
- 超时 / 慢路径：读多写少的热点考虑缓存；重活考虑队列异步化（见 `concurrency` / `queue`）。

检查项：空参数 / 超长 / 不存在 id / 非法枚举 / size 超 100 / 并发请求各试一遍。
