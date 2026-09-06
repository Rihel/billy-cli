# 性能与查询效率（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 实现列表 / 详情 / 搜索等查询接口时必读。

考虑什么：接口在数据量上来后会不会慢——写列表 / 详情时先想查询计划，不等到线上才优化。
仓库落地：

- 分页方式选对：量小用 `pageWith`（offset）；量大 / 深翻页用 `cursorPageWith`（游标，
  配 `(updatedAt, id)` 顺序索引）——深 offset 翻页会越来越慢。
- 查询只取所需：`createQueryBuilder` 按需 `select`；关键字搜索用绑定参数 `ILIKE :keyword`；
  注意 `ILIKE '%kw%'` 无法走普通索引，数据量大了要评估（pg_trgm / 分词等），别默认全表扫没问题。
- 读多写少的热点：`RedisStore` `setJson(key, val, ttl)` 缓存 + 写后失效（`concurrency`），
  别每次请求都打 DB。
- 防 N+1：循环里逐条查库改为批量查询 / 一次取齐再内存组装。
- 响应裁剪：repository 结果统一 `toXxx()` 映射为模型，不把整表字段（含内部列）外抛——
  同时是性能与安全（参考 todo repository 的 `toTodo`）。

检查项：列表 / 详情接口在万级数据下仍可控；无循环内查库；无整表外抛。
