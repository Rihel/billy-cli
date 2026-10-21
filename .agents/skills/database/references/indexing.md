# 索引：怎么搞（database 引用文件）

> 本文件是 `database` skill 的组成部分，由主 SKILL.md 引用。
> 加索引、设计查询路径、排查慢查询时必读。

## 1. 先想清楚：为查询路径建索引，不为「万一用到」建

索引加速读、拖慢写（每次写要维护索引）并占磁盘。规则：

- 只为**真实查询路径**的 `where` / `orderBy` / 连接列建索引。
- 写完一个列表 / 详情查询，先自问：这个 where / 排序走没走索引？怎么验证 → EXPLAIN（见 §6）。
- 别给从不查询的列建索引；别索引泛滥（一张表 3~5 个以内通常足够）。

## 2. 组合索引的列序

等值条件列在前，排序 / 范围列在后：

- 游标分页：排序是 `updatedAt desc, id desc` → 建 `(updatedAt, id)` 组合索引
  （`@Index('idx_update_at_id', ['updatedAt', 'id'])`——注意实体字段名是 `updatedAt`，
  TypeORM 会映射到列）
- 只有等值条件的场景（如按 `rule_id + status` 过滤列表）→ `(ruleId, status)` 等值在前。

## 3. 游标分页必须有配套索引

- `cursorPageWith` 要求排序与 `cursorColumns` 一致（游标列表：`cursorColumns: ['updatedAt','id']` +
  `orderBy updatedAt desc, id desc`），**必须有 `(updatedAt, id)` 索引**，否则深翻页会扫全表。
- offset 分页（`pageWith`）在数据量大了会越来越慢（skip 越翻越深）——量大换游标
  或启用 `@repo/kits` 的 deferred 变体（只取主键再回表，当前业务未用，极大表再启用）。

## 4. 唯一约束 vs 索引

- 唯一业务键用 `@Unique('uk_*')`（同时就是唯一索引，查询也受益）；软删表记得带 `deletedAt`
  （见 model-design.md §4）。
- 非唯一的过滤 / 排序路径才用 `@Index('idx_*', [...])`。
- 显式命名 `idx_*` / `uk_*`（code-conventions 硬性要求；迁移 SQL 里可辨认，方便后续管理）。

## 5. ILIKE 与索引失效（常见坑）

- `ILIKE '%keyword%'`（前后都通配）**无法走普通 B-tree 索引**，数据量大就是全表扫。
  量小可接受；量大了要评估：
  - 前缀匹配 `keyword%` 可以走索引；
  - 子串搜索上 pg_trgm（GIN 索引）或分词，别硬扛。
- 函数包住列（`lower(col)`、`DATE(col)` 等）也会让索引失效——把函数挪到值一侧。

## 6. 用 EXPLAIN 验证，别猜

起库后直连 psql 验证（命令见主 SKILL.md「常用命令」）：

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ... WHERE ... ORDER BY ... LIMIT ...;
```

- 看是否出现 `Seq Scan`（全表扫，量大了要处理）vs `Index Scan` / `Index Only Scan`。
- 迁移后顺手验证一次新索引真的被查询用上（没用到就删掉，别留无用索引）。

检查项：每条列表 / 详情查询路径有对应索引；游标配 `(updatedAt, id)`；组合索引列序合理；
无函数包列 / 无 `%kw%` 硬扫大表；索引显式命名；EXPLAIN 验证过。
